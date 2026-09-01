import { useEffect, useState } from "react";
import { db } from "../../lib/db.js";
import { formatNaira } from "../../lib/money.js";
import { monthStart } from "../../lib/budgets.js";
import { fetchCrowdBands } from "../../lib/crowdBand.js";
import { bandsForMonth } from "../../lib/marketComparison.js";
import type { LocalLocation } from "../../lib/db.js";

/**
 * Price comparison (§4 stage 8, V1: `/compare/location`). Where is this
 * item cheapest THIS month, across every market with a published crowd
 * band? Cheapest first; markets without a band aren't guessed at.
 */
type ViewState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | { kind: "ready"; rows: { market: LocalLocation | undefined; medianKobo: bigint }[] };

export function PriceComparison({ commodityId }: { commodityId: string }) {
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const [commodityName, setCommodityName] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const commodity = await db.commodities.get(commodityId);
      if (!cancelled) setCommodityName(commodity?.canonicalName);

      try {
        const bands = bandsForMonth(await fetchCrowdBands(commodityId), monthStart());
        if (bands.length === 0) {
          if (!cancelled) setState({ kind: "empty" });
          return;
        }
        const sorted = [...bands].sort((a, b) => (a.medianKobo! < b.medianKobo! ? -1 : 1));
        const markets = await db.locations.bulkGet(sorted.map((b) => b.marketId));
        const marketById = new Map(markets.filter((m) => m !== undefined).map((m) => [m!.id, m!]));

        if (!cancelled) {
          setState({
            kind: "ready",
            rows: sorted.map((b) => ({ market: marketById.get(b.marketId), medianKobo: b.medianKobo! })),
          });
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
  }, [commodityId]);

  return (
    <main>
      <h1>Compare markets{commodityName ? ` — ${commodityName}` : ""}</h1>

      {state.kind === "loading" && <p aria-busy="true">Loading…</p>}
      {state.kind === "error" && <p role="alert">{state.message}</p>}
      {state.kind === "empty" && (
        <p>Not enough shoppers across any market yet to compare prices for this item.</p>
      )}
      {state.kind === "ready" && (
        <ol aria-label="Markets, cheapest first">
          {state.rows.map(({ market, medianKobo }, i) => (
            <li key={market?.id ?? i}>
              {market?.name ?? "Unknown market"} — {formatNaira(medianKobo)}
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
