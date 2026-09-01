/**
 * Edge Function: merge-anonymous-data
 * Blocking item 2 (Technical Requirements §2.3).
 *
 * Re-parents a second device's anonymous data onto the signed-in account, OR
 * records that the user chose to keep it separate. Runs with the service role
 * because RLS (correctly) forbids a client writing rows under another user_id.
 *
 * Proof of ownership required for BOTH parties:
 *   - target (account A): the caller's own JWT in `Authorization: Bearer`,
 *     verified against Supabase Auth.
 *   - source (anon session B): the caller presents B's still-valid refresh
 *     token, which the client captured BEFORE sign-in replaced the session.
 *     We exchange it server-side; a successful exchange proves possession.
 *
 * Idempotent on `idempotencyKey` (enforced in `merge_anonymous_account`).
 *
 * Deploy:  supabase functions deploy merge-anonymous-data
 * Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 *          (all provided by the platform for deployed functions)
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

interface MergeRequest {
  choice: 'merge' | 'keep_separate';
  idempotencyKey: string;
  /** Required when choice === 'merge'. */
  sourceRefreshToken?: string;
  /** Required when choice === 'keep_separate'. */
  sourceUserId?: string;
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return json(401, { error: 'missing_bearer_token' });

  let body: MergeRequest;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  if (!body.idempotencyKey || typeof body.idempotencyKey !== 'string') {
    return json(400, { error: 'missing_idempotency_key' });
  }
  if (body.choice !== 'merge' && body.choice !== 'keep_separate') {
    return json(400, { error: 'invalid_choice' });
  }

  // 1. Verify the caller (account A) from their JWT.
  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: callerData, error: callerErr } = await asCaller.auth.getUser();
  if (callerErr || !callerData.user) return json(401, { error: 'invalid_caller_token' });
  const targetUserId = callerData.user.id;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (body.choice === 'keep_separate') {
    if (!body.sourceUserId) return json(400, { error: 'missing_source_user_id' });
    if (body.sourceUserId === targetUserId) return json(400, { error: 'same_user' });
    const { data, error } = await admin.rpc('record_keep_separate', {
      p_source_user_id: body.sourceUserId,
      p_target_user_id: targetUserId,
      p_idempotency_key: body.idempotencyKey,
    });
    if (error) return json(500, { error: 'record_failed', detail: error.message });
    return json(200, toResult(data));
  }

  // choice === 'merge'
  if (!body.sourceRefreshToken) return json(400, { error: 'missing_source_refresh_token' });

  // 2. Prove ownership of source (anon session B) by exchanging its refresh token.
  const asSource = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: sourceSession, error: sourceErr } = await asSource.auth.refreshSession({
    refresh_token: body.sourceRefreshToken,
  });
  if (sourceErr || !sourceSession.user) {
    return json(401, { error: 'invalid_source_refresh_token' });
  }
  const sourceUserId = sourceSession.user.id;

  if (sourceUserId === targetUserId) return json(400, { error: 'same_user' });
  if (sourceSession.user.is_anonymous !== true) {
    return json(409, { error: 'source_not_anonymous' });
  }

  // 3. Re-parent atomically + idempotently in the database.
  const { data, error } = await admin.rpc('merge_anonymous_account', {
    p_source_user_id: sourceUserId,
    p_target_user_id: targetUserId,
    p_idempotency_key: body.idempotencyKey,
  });
  if (error) return json(500, { error: 'merge_failed', detail: error.message });

  // 4. Best-effort: revoke the now-empty source session so device 2 cannot keep
  //    writing under B. Non-fatal if it fails — the reaper will collect it.
  try {
    await admin.auth.admin.signOut(sourceUserId, 'global');
  } catch {
    // swallow — audited row already written
  }

  return json(200, toResult(data));
});

function toResult(row: Record<string, unknown> | null) {
  return {
    kind: row?.kind ?? null,
    tripsMoved: row?.trips_moved ?? 0,
    purchaseLinesMoved: row?.purchase_lines_moved ?? 0,
    budgetsMoved: row?.budgets_moved ?? 0,
    watchlistMoved: row?.watchlist_moved ?? 0,
  };
}
