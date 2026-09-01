import { useState } from "react";
import { useLocation as useRouterLocation } from "wouter";
import {
  completeUpgrade,
  requestUpgradeCode,
  verifyUpgradeCode,
} from "../../lib/auth/upgrade.js";
import type { MergeChoice, SecondDeviceDecision } from "../../lib/auth/deviceMerge.js";

/**
 * Screen 14 — Account upgrade (§15, `/account/upgrade`). Backs up the local
 * anonymous session to a real, recoverable account (TR §2.3).
 *
 * State machine, not a single form — each state is one of the five required
 * view states (empty/loading/error/partial/success):
 *   'email'   — empty state: nothing entered yet
 *   'sending' / 'verifying' / 'resolving' — loading
 *   'otp'     — partial: code requested, mid-flow
 *   'choice'  — partial: local data found on this device under a different
 *               anonymous id than the one now signed in; the user must
 *               choose before this can complete (never silent, TR §2.3)
 *   'done'    — success
 *   error is layered onto whichever step it happened in, not a separate step
 */
type Step =
  | { kind: "email" }
  | { kind: "sending"; email: string }
  | { kind: "otp"; email: string; error: string | null }
  | { kind: "verifying"; email: string }
  | { kind: "choice"; decision: Extract<SecondDeviceDecision, { outcome: "must_choose" }> }
  | { kind: "resolving"; decision: SecondDeviceDecision; choice: MergeChoice | null }
  | { kind: "done"; merged: boolean }
  | { kind: "error"; message: string };

export function AccountUpgrade() {
  const [, navigate] = useRouterLocation();
  const [step, setStep] = useState<Step>({ kind: "email" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");

  async function handleRequestCode(e: React.FormEvent) {
    e.preventDefault();
    setStep({ kind: "sending", email });
    try {
      await requestUpgradeCode(email);
      setStep({ kind: "otp", email, error: null });
    } catch (err) {
      setStep({ kind: "error", message: describeError(err) });
    }
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    const otpEmail = step.kind === "otp" ? step.email : email;
    setStep({ kind: "verifying", email: otpEmail });
    try {
      const decision = await verifyUpgradeCode(otpEmail, code);
      if (decision.outcome === "must_choose") {
        setStep({ kind: "choice", decision });
        return;
      }
      setStep({ kind: "done", merged: false });
    } catch (err) {
      setStep({ kind: "otp", email: otpEmail, error: describeError(err) });
    }
  }

  async function handleChoice(decision: SecondDeviceDecision, choice: MergeChoice) {
    setStep({ kind: "resolving", decision, choice });
    try {
      const result = await completeUpgrade(decision, choice);
      setStep({ kind: "done", merged: result?.kind === "merge" });
    } catch (err) {
      setStep({ kind: "error", message: describeError(err) });
    }
  }

  if (step.kind === "email" || step.kind === "sending") {
    return (
      <main>
        <h1>Back up your data</h1>
        <p>
          Add an email so your shopping history survives a lost phone or a
          cleared browser. No password to remember — we&rsquo;ll send you a
          code.
        </p>
        <form onSubmit={handleRequestCode}>
          <label htmlFor="upgrade-email">Email address</label>
          <input
            id="upgrade-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={step.kind === "sending"}
          />
          <button type="submit" disabled={step.kind === "sending" || email.length === 0}>
            {step.kind === "sending" ? "Sending code…" : "Send code"}
          </button>
        </form>
      </main>
    );
  }

  if (step.kind === "otp" || step.kind === "verifying") {
    return (
      <main>
        <h1>Enter your code</h1>
        <p>We sent a code to {step.email}.</p>
        <form onSubmit={handleVerifyCode}>
          <label htmlFor="upgrade-otp">6-digit code</label>
          <input
            id="upgrade-otp"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={step.kind === "verifying"}
          />
          {step.kind === "otp" && step.error && (
            <p role="alert">{step.error}</p>
          )}
          <button type="submit" disabled={step.kind === "verifying" || code.length === 0}>
            {step.kind === "verifying" ? "Verifying…" : "Verify"}
          </button>
        </form>
      </main>
    );
  }

  if (step.kind === "choice") {
    const { pending } = step.decision;
    return (
      <main>
        <h1>Data found on this device</h1>
        <p>
          This device has {pending.tripCount} shopping trip
          {pending.tripCount === 1 ? "" : "s"} saved under a different local
          session than the account you just signed in with. What should
          happen to it?
        </p>
        <div role="group" aria-label="What should happen to this device's local data?">
          <button type="button" onClick={() => void handleChoice(step.decision, "merge")}>
            Add it to my account
          </button>
          <button
            type="button"
            onClick={() => void handleChoice(step.decision, "keep_separate")}
          >
            Keep it separate
          </button>
        </div>
        <p>Nothing is deleted either way — this only decides where it lives.</p>
      </main>
    );
  }

  if (step.kind === "resolving") {
    return (
      <main aria-busy="true">
        <h1>Backing up your data…</h1>
      </main>
    );
  }

  if (step.kind === "done") {
    return (
      <main>
        <h1>You&rsquo;re backed up</h1>
        <p>
          {step.merged
            ? "This device's data has been added to your account."
            : "Your account is ready."}
        </p>
        <button type="button" onClick={() => navigate("/capture")}>
          Continue
        </button>
      </main>
    );
  }

  // step.kind === "error"
  return (
    <main role="alert">
      <h1>Couldn&rsquo;t back up your data</h1>
      <p>{step.message}</p>
      <button type="button" onClick={() => setStep({ kind: "email" })}>
        Try again
      </button>
    </main>
  );
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
