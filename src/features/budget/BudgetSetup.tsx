import { useEffect, useState } from "react";
import { useLocation as useRouterLocation } from "wouter";
import { formatNaira, parseNairaToKobo } from "../../lib/money.js";
import { monthStart, setBudget, suggestBudgetFromLatestTrip } from "../../lib/budgets.js";

/**
 * Screen 9 — Budget setup (§4 stage 5, `/budget/setup`). "Derived from
 * latest trip" per the build-order table: pre-fills the amount from the
 * user's most recent trip total, editable before saving — never saved
 * without the user seeing and confirming it first.
 */
type ViewState =
  | { kind: "loading" }
  | { kind: "ready"; suggested: bigint | null }
  | { kind: "saving" }
  | { kind: "error"; message: string };

export function BudgetSetup({ userId }: { userId: string }) {
  const [, navigate] = useRouterLocation();
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const [amount, setAmount] = useState("");

  useEffect(() => {
    let cancelled = false;
    void suggestBudgetFromLatestTrip(userId).then((suggested) => {
      if (cancelled) return;
      setState({ kind: "ready", suggested });
      if (suggested !== null) {
        setAmount(formatNaira(suggested).replace(/^₦/, "").replace(/,/g, ""));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const kobo = parseNairaToKobo(amount);
    if (kobo === null || kobo <= 0n) return;

    const wasSuggested =
      state.kind === "ready" &&
      state.suggested !== null &&
      kobo === state.suggested;

    setState({ kind: "saving" });
    try {
      await setBudget(userId, kobo, monthStart(), wasSuggested ? "derived_from_trip" : "manual");
      navigate("/budget");
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (state.kind === "loading") {
    return <main aria-busy="true">Loading…</main>;
  }

  return (
    <main>
      <h1>Set your monthly budget</h1>

      {state.kind === "ready" && state.suggested !== null && (
        <p>Based on your last shop, we&rsquo;ve suggested {formatNaira(state.suggested)}.</p>
      )}
      {state.kind === "ready" && state.suggested === null && (
        <p>Log a shop first and we can suggest an amount — or just enter one now.</p>
      )}

      <form onSubmit={(e) => void handleSave(e)}>
        <label htmlFor="budget-amount">Monthly budget</label>
        <input
          id="budget-amount"
          inputMode="decimal"
          placeholder="₦"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={state.kind === "saving"}
          required
        />
        {state.kind === "error" && <p role="alert">{state.message}</p>}
        <button type="submit" disabled={state.kind === "saving" || amount.length === 0}>
          {state.kind === "saving" ? "Saving…" : "Save budget"}
        </button>
      </form>
    </main>
  );
}
