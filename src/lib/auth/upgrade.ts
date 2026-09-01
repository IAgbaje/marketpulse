/**
 * Account upgrade (Screen 14, `/account/upgrade`) — the impure orchestration
 * around `deviceMerge.ts`'s pure decision logic.
 *
 * Sign-in method: email OTP (one-time code, no password). Not specified in
 * the source docs — an engineering default, not a product decision: no
 * password to remember or reset, no SMS cost, and the two-step
 * request/verify shape matches the ordering `deviceMerge.ts` requires
 * exactly (capture the anonymous session between the two steps).
 *
 * Ordering that matters (TR §2.3): the pre-verify anonymous session is
 * captured BEFORE calling `verifyOtp`, because that call replaces the
 * session in place — capture after it, and proof of ownership of the prior
 * anonymous session (device B) is already gone.
 */

import { supabase } from "../supabase.js";
import { probeLocalData } from "./localDataProbe.js";
import {
  decideSecondDeviceSignIn,
  resolveSecondDeviceSignIn,
  type AnonymousSessionSnapshot,
  type MergeApi,
  type MergeApiResult,
  type MergeChoice,
  type SecondDeviceDecision,
} from "./deviceMerge.js";

const mergeApi: MergeApi = {
  async merge({ sourceRefreshToken, idempotencyKey }): Promise<MergeApiResult> {
    const { data, error } = await supabase.functions.invoke("merge-anonymous-data", {
      body: { choice: "merge", sourceRefreshToken, idempotencyKey },
    });
    if (error) throw error;
    return data as MergeApiResult;
  },
  async keepSeparate({ sourceUserId, idempotencyKey }): Promise<MergeApiResult> {
    const { data, error } = await supabase.functions.invoke("merge-anonymous-data", {
      body: { choice: "keep_separate", sourceUserId, idempotencyKey },
    });
    if (error) throw error;
    return data as MergeApiResult;
  },
};

/** Step 1: request a one-time code by email. */
export async function requestUpgradeCode(email: string): Promise<void> {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true },
  });
  if (error) throw error;
}

/**
 * Step 2: verify the code. Captures the prior anonymous session before
 * verifying (see module doc), then returns the merge decision for the UI to
 * act on — `must_choose` means the UI must ask the user before this can be
 * completed with `completeUpgrade`.
 */
export async function verifyUpgradeCode(
  email: string,
  token: string,
): Promise<SecondDeviceDecision> {
  const { data: before } = await supabase.auth.getSession();
  const priorAnonSession: AnonymousSessionSnapshot | null =
    before.session?.user.is_anonymous === true
      ? { userId: before.session.user.id, refreshToken: before.session.refresh_token }
      : null;

  const { data, error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
  if (error) throw error;
  if (!data.session) {
    throw new Error("verifyUpgradeCode: verification returned no session");
  }

  const localData = priorAnonSession
    ? await probeLocalData(priorAnonSession.userId)
    : { tripCount: 0, purchaseLineCount: 0, budgetCount: 0, watchlistCount: 0 };

  return decideSecondDeviceSignIn({
    priorAnonSession,
    signedInUserId: data.session.user.id,
    localData,
  });
}

/**
 * Step 3 (only when `verifyUpgradeCode` returned `must_choose`): act on the
 * user's explicit choice. Throws — never proceeds silently — if `choice` is
 * null while a decision is pending (TR §2.3); see `deviceMerge.ts`.
 */
export async function completeUpgrade(
  decision: SecondDeviceDecision,
  choice: MergeChoice | null,
): Promise<MergeApiResult | null> {
  return resolveSecondDeviceSignIn(decision, choice, mergeApi);
}
