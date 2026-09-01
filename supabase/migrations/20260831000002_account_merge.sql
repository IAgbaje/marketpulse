-- =============================================================================
-- 20260831000002_account_merge.sql
-- Blocking item 2 (Technical Requirements §2.3): the second-device merge must
-- never silently orphan synced data.
--
-- Scenario it defends against: device 2 minted its own anonymous session B at
-- first launch and already synced trips under B. The user then signs into their
-- upgraded account A on device 2. The session switches to A and everything under
-- B becomes permanently unreachable under RLS (B != A, nothing merges them).
--
-- This migration adds the audit table and the service-role re-parenting function.
-- The client never re-parents directly — RLS forbids writing a row under a
-- different user_id, which is the correct guarantee. Re-parenting is a deliberate,
-- audited, idempotent, service-role operation.
--
-- Reversibility: DROP FUNCTION + DROP TABLE at the bottom of the file (commented).
-- The account_merges rows are an audit trail — never updated or deleted in normal
-- operation.
-- =============================================================================

-- Enum of what the user chose at the sign-in fork. "keep_separate" is recorded
-- too, so a support query can see the device-2 history was deliberately left
-- under its own anonymous record, not lost.
DO $$ BEGIN
  CREATE TYPE account_merge_kind AS ENUM ('merge', 'keep_separate');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS account_merges (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Client-supplied idempotency key. Retries with the same key return the
  -- original result, never a second re-parenting pass.
  idempotency_key   text NOT NULL UNIQUE,
  kind              account_merge_kind NOT NULL,
  source_user_id    uuid NOT NULL,          -- anonymous session B
  target_user_id    uuid NOT NULL,          -- permanent account A
  trips_moved       integer NOT NULL DEFAULT 0,
  purchase_lines_moved integer NOT NULL DEFAULT 0,
  budgets_moved     integer NOT NULL DEFAULT 0,
  watchlist_moved   integer NOT NULL DEFAULT 0,
  -- 'system' | 'user' — who initiated. Always 'user' here (explicit choice at
  -- sign-in), but recorded per the financial-state-machine audit discipline.
  actor             text NOT NULL DEFAULT 'user',
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_merges_distinct_parties CHECK (source_user_id <> target_user_id)
);

CREATE INDEX IF NOT EXISTS idx_account_merges_source ON account_merges (source_user_id);
CREATE INDEX IF NOT EXISTS idx_account_merges_target ON account_merges (target_user_id);

ALTER TABLE account_merges ENABLE ROW LEVEL SECURITY;
-- No policies: readable/writable by the service role only. A user does not need
-- to read their own merge history from the client; support reads it via the
-- dashboard (service role).

-- -----------------------------------------------------------------------------
-- merge_anonymous_account(source, target, key)
--
-- Re-parents every user-owned row from `source` (an anonymous session) to
-- `target`. Must be called with the service role. The Edge Function
-- `merge-anonymous-data` is responsible for PROVING the caller owns both:
--   - target: from the verified JWT of the signed-in user
--   - source: by presenting source's still-valid refresh token, exchanged
--     server-side to confirm the uid — captured BEFORE the sign-in call
--     replaced the session.
--
-- Guarantees:
--   - Idempotent on `key` (unique constraint + fast path).
--   - Serialised per source via a transaction-scoped advisory lock, so two
--     concurrent merges of the same device cannot both run.
--   - Only merges FROM an anonymous user (guard against merging two real
--     accounts, which is a different, human-reviewed operation).
--   - All-or-nothing (single function = single transaction).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION merge_anonymous_account(
  p_source_user_id uuid,
  p_target_user_id uuid,
  p_idempotency_key text
)
RETURNS account_merges
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_existing   account_merges;
  v_is_anon    boolean;
  v_result     account_merges;
  v_trips      integer;
  v_lines      integer;
  v_budgets    integer;
  v_watch      integer;
BEGIN
  IF p_source_user_id = p_target_user_id THEN
    RAISE EXCEPTION 'merge_anonymous_account: source and target are the same user';
  END IF;

  -- Fast idempotent path.
  SELECT * INTO v_existing FROM account_merges WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  -- Serialise concurrent merges of the same source device.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_source_user_id::text, 0));

  -- Re-check after taking the lock.
  SELECT * INTO v_existing FROM account_merges WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  -- Only anonymous sources may be merged this way.
  SELECT (raw_app_meta_data ->> 'is_anonymous')::boolean IS TRUE
       OR is_anonymous IS TRUE
    INTO v_is_anon
  FROM auth.users WHERE id = p_source_user_id;

  IF v_is_anon IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'merge_anonymous_account: source % is not an anonymous user', p_source_user_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_target_user_id) THEN
    RAISE EXCEPTION 'merge_anonymous_account: target % does not exist', p_target_user_id;
  END IF;

  UPDATE shopping_trips  SET user_id = p_target_user_id WHERE user_id = p_source_user_id;
  GET DIAGNOSTICS v_trips = ROW_COUNT;

  UPDATE purchase_lines  SET user_id = p_target_user_id WHERE user_id = p_source_user_id;
  GET DIAGNOSTICS v_lines = ROW_COUNT;

  UPDATE user_budgets    SET user_id = p_target_user_id WHERE user_id = p_source_user_id;
  GET DIAGNOSTICS v_budgets = ROW_COUNT;

  UPDATE watchlist       SET user_id = p_target_user_id WHERE user_id = p_source_user_id;
  GET DIAGNOSTICS v_watch = ROW_COUNT;

  INSERT INTO account_merges (
    idempotency_key, kind, source_user_id, target_user_id,
    trips_moved, purchase_lines_moved, budgets_moved, watchlist_moved, actor
  )
  VALUES (
    p_idempotency_key, 'merge', p_source_user_id, p_target_user_id,
    v_trips, v_lines, v_budgets, v_watch, 'user'
  )
  RETURNING * INTO v_result;

  -- The now-empty anonymous source will be reaped by 0003's scheduled job
  -- (zero trips, older than the retention window). Nothing to delete here.

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION merge_anonymous_account(uuid, uuid, text) FROM public, anon, authenticated;
-- service_role retains EXECUTE via its BYPASSRLS + default grants; the Edge
-- Function calls it with the service key.

-- -----------------------------------------------------------------------------
-- record_keep_separate(source, target, key): audit the "keep separate" choice.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_keep_separate(
  p_source_user_id uuid,
  p_target_user_id uuid,
  p_idempotency_key text
)
RETURNS account_merges
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing account_merges;
  v_result   account_merges;
BEGIN
  SELECT * INTO v_existing FROM account_merges WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN RETURN v_existing; END IF;

  INSERT INTO account_merges (
    idempotency_key, kind, source_user_id, target_user_id, actor
  )
  VALUES (p_idempotency_key, 'keep_separate', p_source_user_id, p_target_user_id, 'user')
  ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION record_keep_separate(uuid, uuid, text) FROM public, anon, authenticated;

-- =============================================================================
-- DOWN (manual):
--   DROP FUNCTION IF EXISTS merge_anonymous_account(uuid, uuid, text);
--   DROP FUNCTION IF EXISTS record_keep_separate(uuid, uuid, text);
--   DROP TABLE IF EXISTS account_merges;
--   DROP TYPE IF EXISTS account_merge_kind;
-- =============================================================================
