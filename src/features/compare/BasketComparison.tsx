import { useEffect, useState } from "react";
import { db } from "../../lib/db.js";
import { formatNaira } from "../../lib/money.js";
import { monthStart } from "../../lib/budgets.js";
import { getTripLines, listRecentTrips } from "../../lib/trips.js";
import { fetchCrowdBands, type CrowdBandRow } from "../../lib/crowdBand.js";
import { computeBasketTotals, type MarketBasketTotal } from "../../lib/marketComparison.js";
import type { LocalLocation } from "../../lib/db.js";

/**
 * Basket comparison (§4 stage 8, V1: `/compare/basket`). Uses the user's
 * most recent committed trip as "the basket" — not specified which trip to
 * use anywhere in the source docs, so this is the same choice Trip Summary
 * already made for its own comparison (the latest one), kept consistent
 * rather than introducing a second convention.
 *
 * The total shown is a SUM OF MEDIAN CROWD PRICES per market, not an
 * observed receipt — stated plainly in the UI, alongside how many of the
 * basket's items each market actually has a price for, so a thin 1-of-8
 * comparison never reads as equivalent to a complete one.
 */
type ViewState =
  | { kind: "loading" }
  | { kind: "no-trips" }
  | { kind: "error"; message: string }
  | { kind: "empty" }
  | { kind: "ready"; totals: MarketBasketTotal[]; itemCount: number };

export function BasketComparison({ userId }: { userId: string }) {
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const [markets, setMarkets] = useState<Map<string, LocalLocation>>(new Map());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [latestTrip] = await listRecentTrips(userId, 1);
      if (!latestTrip) {
        if (!cancelled) setState({ kind: "no-trips" });
        return;
      }

      const lines = await getTripLines(latestTrip.id);
      const commodityIds = [...new Set(lines.map((l) => l.commodityId))];

      try {
        const month = monthStart();
        const bandsByCommodity = new Map<string, CrowdBandRow[]>(
          await Promise.all(
            commodityIds.map(async (id) => [id, await fetchCrowdBands(id)] as [string, CrowdBandRow[]]),
          ),
        );
        const totals = computeBasketTotals(bandsByCommodity, commodityIds, month);

        if (totals.length === 0) {
          if (!cancelled) setState({ kind: "empty" });
          return;
        }

        const marketRows = await db.locations.bulkGet(totals.map((t) => t.marketId));
        if (!cancelled) {
          setMarkets(new Map(marketRows.filter((m) => m !== undefined).map((m) => [m!.id, m!])));
          setState({ kind: "ready", totals, itemCount: commodityIds.length });
        }
      } catch (err) {
        if (!cancelled) {
          setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return (
    <main>
      <h1>Compare your last basket across markets</h1>

      {state.kind === "loading" && <p aria-busy="true">Loading…</p>}
      {state.kind === "no-trips" && <p>Log a shop first, then come back to compare it.</p>}
      {state.kind === "error" && <p role="alert">{state.message}</p>}
      {state.kind === "empty" && (
        <p>Not enough shoppers anywhere yet to estimate your basket at other markets.</p>
      )}
      {state.kind === "ready" && (
        <>
          <p>
            Estimated total using this month&rsquo;s typical prices — not an actual receipt, and only
            counting items each market has enough shoppers to price.
          </p>
          <ol aria-label="Markets, cheapest estimated basket first">
            {state.totals.map((t) => (
              <li key={t.marketId}>
                {markets.get(t.marketId)?.name ?? "Unknown market"} — {formatNaira(t.totalKobo)} (
                {t.itemsPriced} of {state.itemCount} items priced
                {t.itemsMissing > 0 ? `, ${t.itemsMissing} not priced here` : ""})
              </li>
            ))}
          </ol>
        </>
      )}
    </main>
  );
}
