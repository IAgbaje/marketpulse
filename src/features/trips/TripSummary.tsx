import { useEffect, useState } from "react";
import { useLocation as useRouterLocation } from "wouter";
import { db } from "../../lib/db.js";
import { formatNaira } from "../../lib/money.js";
import {
  aggregateLinesByCommodity,
  findPriorTripAtLocation,
  getTripLines,
  unconfirmedOutlierCommodityIds,
} from "../../lib/trips.js";
import { decompose, toDisplayModel } from "../../engine/index.js";
import type { LocalLine, LocalTrip } from "../../lib/db.js";

/**
 * Screen 7 — Trip summary (§4 stage 4, "personal ghost + trip comparison").
 * Compares THIS trip against the last comparable one at the same market,
 * using the same decomposition engine stage 5 uses for budget-vs-actual —
 * it is period-agnostic (two aggregated baskets in, one exact ledger out),
 * so reusing it here at trip granularity is a deliberate choice, not a
 * shortcut: same rigor, no separate cruder comparison to maintain.
 *
 * Unlike the budget feature (§4 stage 5a/5b), there is no "< 2 complete
 * months" tier gate here — a committed trip has no partial-trip analogue to
 * a partial month, so the full PRICE/WHAT_YOU_BOUGHT/basket-change ledger is
 * shown immediately, every time a prior comparable trip exists.
 *
 * State mapping (five required view states):
 *   loading  — fetching the trip, prior trip, and lines
 *   empty    — no prior trip at this market to compare against (first
 *              shop here) — a designed state, not a degraded one
 *   error    — the trip itself couldn't be found
 *   success  — comparison rendered
 *   there is no distinct "partial" state: a completely different basket
 *   (no intersection) is not degraded data, it's the basket-change
 *   reconciliation line doing exactly its job — see `toDisplayModel`.
 */
type ViewState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "empty"; trip: LocalTrip; lines: LocalLine[]; totalKobo: bigint }
  | {
      kind: "success";
      trip: LocalTrip;
      lines: LocalLine[];
      totalKobo: bigint;
      priorTotalKobo: bigint;
      display: ReturnType<typeof toDisplayModel>;
    };

export function TripSummary({ tripId, userId }: { tripId: string; userId: string }) {
  const [, navigate] = useRouterLocation();
  const [state, setState] = useState<ViewState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const trip = await db.trips.get(tripId);
      if (!trip) {
        if (!cancelled) setState({ kind: "error", message: "This trip couldn't be found." });
        return;
      }

      const lines = await getTripLines(tripId);
      const totalKobo = lines.reduce((sum, l) => sum + BigInt(l.paidPriceKobo), 0n);

      if (!trip.marketId) {
        if (!cancelled) setState({ kind: "empty", trip, lines, totalKobo });
        return;
      }

      const priorTrip = await findPriorTripAtLocation(userId, trip.marketId, tripId);
      if (!priorTrip) {
        if (!cancelled) setState({ kind: "empty", trip, lines, totalKobo });
        return;
      }

      const priorLines = await getTripLines(priorTrip.id);
      const priorTotalKobo = priorLines.reduce((sum, l) => sum + BigInt(l.paidPriceKobo), 0n);

      const decomposition = decompose({
        periodStart: aggregateLinesByCommodity(priorLines),
        periodEnd: aggregateLinesByCommodity(lines),
        excludedCommodityIds: [
          ...new Set([
            ...unconfirmedOutlierCommodityIds(priorLines),
            ...unconfirmedOutlierCommodityIds(lines),
          ]),
        ],
        currency: trip.currency,
      });

      if (!cancelled) {
        setState({
          kind: "success",
          trip,
          lines,
          totalKobo,
          priorTotalKobo,
          display: toDisplayModel(decomposition),
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
  }, [tripId, userId]);

  if (state.kind === "loading") {
    return <main aria-busy="true">Working out how this trip compares…</main>;
  }

  if (state.kind === "error") {
    return (
      <main role="alert">
        <h1>Couldn&rsquo;t load this trip</h1>
        <p>{state.message}</p>
        <button type="button" onClick={() => navigate("/")}>
          Go home
        </button>
      </main>
    );
  }

  if (state.kind === "empty") {
    return (
      <main>
        <h1>Shop logged</h1>
        <p>
          <strong>Total: {formatNaira(state.totalKobo)}</strong> across {state.lines.length} item
          {state.lines.length === 1 ? "" : "s"}.
        </p>
        <p>
          This is the first time we&rsquo;ve seen a shop from you at this market, so there&rsquo;s
          nothing to compare it to yet — that&rsquo;ll show up from your next visit here.
        </p>
        <button type="button" onClick={() => navigate("/")}>
          Done
        </button>
      </main>
    );
  }

  // state.kind === "success"
  const { display, totalKobo, priorTotalKobo } = state;
  const changeKobo = display.totalChangeKobo;
  const changeDirection = changeKobo === 0n ? "same" : changeKobo > 0n ? "more" : "less";

  return (
    <main>
      <h1>Shop logged</h1>
      <p>
        <strong>Total: {formatNaira(totalKobo)}</strong> — last time here you paid{" "}
        {formatNaira(priorTotalKobo)}.
      </p>

      <p>
        {changeDirection === "same"
          ? "That's the same as last time."
          : `That's ${formatNaira(bigAbs(changeKobo))} ${changeDirection} than last time.`}
      </p>

      <section aria-label="Why it changed">
        <h2>Why</h2>
        <dl>
          <dt>Prices changed</dt>
          <dd>{formatSigned(display.hero.priceKobo)}</dd>
          <dt>What you bought changed</dt>
          <dd>{formatSigned(display.hero.whatYouBoughtKobo)}</dd>
          {display.reconciliation.basketChangeKobo !== 0n && (
            <>
              <dt>Different items this time</dt>
              <dd>{formatSigned(display.reconciliation.basketChangeKobo)}</dd>
            </>
          )}
          {display.reconciliation.excludedDeltaKobo !== 0n && (
            <>
              <dt>Set aside — {display.detail.excludedCount} unusual price{display.detail.excludedCount === 1 ? "" : "s"} not yet confirmed</dt>
              <dd>{formatSigned(display.reconciliation.excludedDeltaKobo)}</dd>
            </>
          )}
        </dl>
      </section>

      <button type="button" onClick={() => navigate("/")}>
        Done
      </button>
    </main>
  );
}

function bigAbs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function formatSigned(kobo: bigint): string {
  if (kobo === 0n) return "No change";
  const sign = kobo > 0n ? "+" : "−";
  return `${sign}${formatNaira(bigAbs(kobo))}`;
}
