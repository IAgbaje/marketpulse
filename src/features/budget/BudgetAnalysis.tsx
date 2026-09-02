import { useEffect, useState } from "react";
import { Link } from "wouter";
import { flag } from "../../lib/flags.js";
import { formatNaira } from "../../lib/money.js";
import {
  addMonths,
  countCompleteMonths,
  getBudgetForMonth,
  monthLines,
  monthStart,
} from "../../lib/budgets.js";
import { aggregateLinesByCommodity, unconfirmedOutlierCommodityIds } from "../../lib/trips.js";
import {
  decompose,
  projectToPriceEffect,
  selectTier,
  toDisplayModel,
  type DecompositionDisplayModel,
  type PriceEffectTier,
} from "../../engine/index.js";

/**
 * Screen 10 — Budget vs actual (§4 stage 5, `/budget`). Stage 5 splits into
 * two priorities:
 *
 *   - 5a (P0): price-effect-only tier — always available at ≥ 2 complete months.
 *   - 5b (P1): the full PRICE / WHAT_YOU_BOUGHT / basket-change / excluded
 *     breakdown — gated behind "≥ 2 complete months AND the 5b feature flag"
 *     (§7.7). The flag is `fullDecompositionSplit` (src/lib/flags.ts): off by
 *     default, flip via `VITE_FLAG_FULL_DECOMPOSITION_SPLIT=true` at build or a
 *     per-device localStorage override. `selectTier` and the 'full' branch
 *     below already run against the engine's real output and its exact-tie
 *     display model — enabling 5b is the flag, not new engineering.
 */

type ViewState =
  | { kind: "loading" }
  | { kind: "no-budget" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      budgetKobo: bigint;
      spentKobo: bigint;
      tier: "none" | "price_effect_only" | "full";
      priceEffect: PriceEffectTier | null;
      full: DecompositionDisplayModel | null;
    };

export function BudgetAnalysis({ userId }: { userId: string }) {
  const [state, setState] = useState<ViewState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const month = monthStart();
      const budget = await getBudgetForMonth(userId, month);
      if (!budget) {
        if (!cancelled) setState({ kind: "no-budget" });
        return;
      }

      const [thisMonthLines, completeMonths] = await Promise.all([
        monthLines(userId, month),
        countCompleteMonths(userId),
      ]);
      const spentKobo = thisMonthLines.reduce((sum, l) => sum + BigInt(l.paidPriceKobo), 0n);

      const tier = selectTier({
        completeMonths,
        fullSplitEnabled: flag("fullDecompositionSplit"),
      });

      let priceEffect: PriceEffectTier | null = null;
      let full: DecompositionDisplayModel | null = null;

      if (tier !== "none") {
        const priorMonthLines = await monthLines(userId, addMonths(month, -1));
        const decomposition = decompose({
          periodStart: aggregateLinesByCommodity(priorMonthLines),
          periodEnd: aggregateLinesByCommodity(thisMonthLines),
          excludedCommodityIds: [
            ...new Set([
              ...unconfirmedOutlierCommodityIds(priorMonthLines),
              ...unconfirmedOutlierCommodityIds(thisMonthLines),
            ]),
          ],
          currency: budget.currency,
        });
        if (tier === "price_effect_only") {
          priceEffect = projectToPriceEffect(decomposition);
        } else {
          full = toDisplayModel(decomposition);
        }
      }

      if (!cancelled) {
        setState({
          kind: "ready",
          budgetKobo: BigInt(budget.amountKobo),
          spentKobo,
          tier,
          priceEffect,
          full,
        });
      }
    })().catch((err: unknown) => {
      if (!cancelled) {
        setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (state.kind === "loading") {
    return <main aria-busy="true">Working out your budget…</main>;
  }

  if (state.kind === "no-budget") {
    return (
      <main>
        <h1>No budget set yet</h1>
        <p>Set a monthly budget to see how your spending compares.</p>
        <Link to="/budget/setup">
          <button type="button">Set up budget</button>
        </Link>
      </main>
    );
  }

  if (state.kind === "error") {
    return (
      <main role="alert">
        <h1>Couldn&rsquo;t load your budget</h1>
        <p>{state.message}</p>
      </main>
    );
  }

  const { budgetKobo, spentKobo, tier, priceEffect, full } = state;
  const remainingKobo = budgetKobo - spentKobo;
  const overBudget = remainingKobo < 0n;

  return (
    <main>
      <h1>This month&rsquo;s budget</h1>

      <p>
        <strong>{formatNaira(spentKobo)}</strong> of {formatNaira(budgetKobo)} spent so far.
      </p>
      <p>
        {overBudget
          ? `${formatNaira(-remainingKobo)} over budget.`
          : `${formatNaira(remainingKobo)} left this month.`}
      </p>

      {tier === "none" && (
        <p>
          Once you&rsquo;ve got two complete months of shopping logged, we&rsquo;ll show you how
          much of any change is prices going up versus what you bought.
        </p>
      )}

      {tier === "price_effect_only" && priceEffect && (
        <p>
          Of the change since last month, prices moving accounts for{" "}
          {formatSigned(priceEffect.priceKobo)}.
        </p>
      )}

      {tier === "full" && full && (
        <dl>
          <dt>Prices changed</dt>
          <dd>{formatSigned(full.hero.priceKobo)}</dd>
          <dt>What you bought changed</dt>
          <dd>{formatSigned(full.hero.whatYouBoughtKobo)}</dd>
          {full.reconciliation.basketChangeKobo !== 0n && (
            <>
              <dt>Different items this month</dt>
              <dd>{formatSigned(full.reconciliation.basketChangeKobo)}</dd>
            </>
          )}
        </dl>
      )}

      <p>
        <Link to="/budget/setup">Change budget</Link>
      </p>
    </main>
  );
}

function formatSigned(kobo: bigint): string {
  if (kobo === 0n) return "No change";
  const sign = kobo > 0n ? "+" : "−";
  const abs = kobo < 0n ? -kobo : kobo;
  return `${sign}${formatNaira(abs)}`;
}
