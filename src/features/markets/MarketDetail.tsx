import { useEffect, useState } from "react";
import { Link } from "wouter";
import { db } from "../../lib/db.js";
import { formatNaira } from "../../lib/money.js";
import { monthStart } from "../../lib/budgets.js";
import { fetchMarketBands, type MarketCommodityBand } from "../../lib/marketBoard.js";
import type { LocalLocation } from "../../lib/db.js";

/**
 * Market detail (§4 stage 8, V1: `/map/market/:id`). Named as a map
 * drill-down in the doc, but nothing here actually needs the map to be
 * useful, and the map itself is blocked (no PostGIS in the schema yet, and
 * the GeoJSON boundary source's licence is an open primary-source question
 * per TR §8 open item 3 — not something to fabricate an answer to). So this
 * ships as its own reachable page (linked from the Markets list) rather
 * than waiting on the map — a price board for one market, this month.
 */
type ViewState =
  | { kind: "loading" }
  | { kind: "not-found" }
  | { kind: "error"; message: string }
  | { kind: "ready"; market: LocalLocation; bands: MarketCommodityBand[] };

export function MarketDetail({ marketId }: { marketId: string }) {
  const [state, setState] = useState<ViewState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const market = await db.locations.get(marketId);
      if (!market) {
        if (!cancelled) setState({ kind: "not-found" });
        return;
      }
      try {
        const bands = await fetchMarketBands(marketId, monthStart());
        if (!cancelled) setState({ kind: "ready", market, bands });
      } catch (err) {
        if (!cancelled) {
          setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [marketId]);

  if (state.kind === "loading") return <main aria-busy="true">Loading…</main>;

  if (state.kind === "not-found") {
    return (
      <main role="alert">
        <h1>Market not found</h1>
      </main>
    );
  }

  if (state.kind === "error") {
    return (
      <main role="alert">
        <h1>Couldn&rsquo;t load this market</h1>
        <p>{state.message}</p>
      </main>
    );
  }

  const { market, bands } = state;

  return (
    <main>
      <h1>{market.name}</h1>
      {market.marketType && market.marketType !== "unknown" && (
        <p>{market.marketType === "open_market" ? "Open market" : "Supermarket"}</p>
      )}

      <section aria-label="This month's prices">
        <h2>This month</h2>
        {bands.length === 0 ? (
          <p>Not enough shoppers here yet this month to show prices.</p>
        ) : (
          <ul aria-label="Commodity prices at this market">
            {bands.map((b) => (
              <li key={b.commodityId}>
                <Link to={`/commodity/${b.commodityId}`}>{b.canonicalName}</Link> —{" "}
                {formatNaira(b.medianKobo)} (typically {formatNaira(b.p25Kobo)}–{formatNaira(b.p75Kobo)})
                {b.gradeCaveat && " — grade/quality varies"}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
