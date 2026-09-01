/**
 * Second-device sign-in: detect local anonymous data and force an explicit
 * choice (Technical Requirements §2.3, blocking item 2).
 *
 * This module is the CLIENT-SIDE decision seam. It is pure where it can be so
 * the branching logic is unit-tested; the one impure step (calling the
 * `merge-anonymous-data` Edge Function) is injected.
 *
 * The ordering that matters and is easy to get wrong:
 *
 *   1. BEFORE calling `signInWithPassword` / `verifyOtp`, capture the current
 *      anonymous session's refresh token and uid. The sign-in call replaces the
 *      session in place — capture after it, and the proof of ownership of B is
 *      already gone.
 *   2. Sign in → session is now A.
 *   3. If step 1 captured a session AND that session had local data, DO NOT
 *      proceed silently. Present the fork (`outcome: 'must_choose'`).
 *   4. On the user's choice, call the Edge Function with A's fresh access token
 *      and B's captured refresh token.
 *
 * Silent loss must never be reachable. `resolveSecondDeviceSignIn` throws if
 * asked to proceed while unmerged local data exists and no choice was made.
 */

export interface AnonymousSessionSnapshot {
  /** uid of the anonymous session that existed on this device before sign-in. */
  userId: string;
  /** Refresh token of that session, captured before the sign-in call. */
  refreshToken: string;
}

export interface LocalDataProbe {
  /** Rows in the local Dexie store owned by the pre-sign-in anonymous uid. */
  tripCount: number;
  purchaseLineCount: number;
  budgetCount: number;
  watchlistCount: number;
}

export type MergeChoice = 'merge' | 'keep_separate';

export interface SecondDeviceContext {
  /** Snapshot captured before sign-in; null if this device had no anon session. */
  priorAnonSession: AnonymousSessionSnapshot | null;
  /** uid the device is signed in as after sign-in (account A). */
  signedInUserId: string;
  /** Local data owned by the prior anon uid. Ignored if `priorAnonSession` null. */
  localData: LocalDataProbe;
}

export type SecondDeviceDecision =
  | { outcome: 'nothing_to_do'; reason: 'no_prior_session' | 'no_local_data' | 'same_user' }
  | { outcome: 'must_choose'; source: AnonymousSessionSnapshot; target: string; pending: LocalDataProbe };

export function hasLocalData(p: LocalDataProbe): boolean {
  return (
    p.tripCount > 0 ||
    p.purchaseLineCount > 0 ||
    p.budgetCount > 0 ||
    p.watchlistCount > 0
  );
}

/**
 * Decide whether the sign-in needs a user choice. Pure.
 */
export function decideSecondDeviceSignIn(ctx: SecondDeviceContext): SecondDeviceDecision {
  if (ctx.priorAnonSession === null) {
    return { outcome: 'nothing_to_do', reason: 'no_prior_session' };
  }
  if (ctx.priorAnonSession.userId === ctx.signedInUserId) {
    // Same-device anonymous → permanent upgrade: auth.uid() is preserved, RLS
    // policies carry over, nothing to merge.
    return { outcome: 'nothing_to_do', reason: 'same_user' };
  }
  if (!hasLocalData(ctx.localData)) {
    return { outcome: 'nothing_to_do', reason: 'no_local_data' };
  }
  return {
    outcome: 'must_choose',
    source: ctx.priorAnonSession,
    target: ctx.signedInUserId,
    pending: ctx.localData,
  };
}

export interface MergeApiResult {
  kind: MergeChoice;
  tripsMoved: number;
  purchaseLinesMoved: number;
  budgetsMoved: number;
  watchlistMoved: number;
}

export interface MergeApi {
  /** POST /functions/v1/merge-anonymous-data */
  merge(args: {
    sourceRefreshToken: string;
    idempotencyKey: string;
  }): Promise<MergeApiResult>;
  /** Same endpoint, `?choice=keep_separate` — records the audit row only. */
  keepSeparate(args: {
    sourceUserId: string;
    idempotencyKey: string;
  }): Promise<MergeApiResult>;
}

/**
 * Deterministic idempotency key for a given (source, target) pair, so a retry
 * after a dropped response reuses the same key and the server returns the
 * original result instead of re-parenting again.
 */
export function mergeIdempotencyKey(sourceUserId: string, targetUserId: string): string {
  return `merge:${sourceUserId}->${targetUserId}`;
}

/**
 * Execute the user's choice. Impure only through `api`. Throws rather than
 * proceed if `choice` is missing while a merge is pending — silent loss must not
 * be a reachable outcome (TR §2.3).
 */
export async function resolveSecondDeviceSignIn(
  decision: SecondDeviceDecision,
  choice: MergeChoice | null,
  api: MergeApi,
): Promise<MergeApiResult | null> {
  if (decision.outcome === 'nothing_to_do') return null;

  if (choice === null) {
    throw new Error(
      'resolveSecondDeviceSignIn: local anonymous data is pending merge and no choice was made — ' +
        'refusing to proceed (silent data loss is not a permitted outcome, TR §2.3)',
    );
  }

  const idempotencyKey = mergeIdempotencyKey(decision.source.userId, decision.target);

  if (choice === 'merge') {
    return api.merge({
      sourceRefreshToken: decision.source.refreshToken,
      idempotencyKey,
    });
  }
  return api.keepSeparate({
    sourceUserId: decision.source.userId,
    idempotencyKey,
  });
}
