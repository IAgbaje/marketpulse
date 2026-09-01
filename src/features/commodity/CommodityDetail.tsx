import { useEffect, useState } from "react";
import { useLocation as useRouterLocation } from "wouter";
import { db } from "../../lib/db.js";
import { formatNaira } from "../../lib/money.js";
import { personalPurchaseHistory } from "../../lib/trips.js";
import { fetchCrowdBands, type CrowdBandRow } from "../../lib/crowdBand.js";
import type { LocalCommodity, LocalLine, LocalLocation, LocalTrip } from "../../lib/db.js";

/**
 * Screen 11 — Commodity detail (§4 stage 4, "seeded crowd read"). Two
 * independent data sources shown together, each with its own honest state:
 *
 *  - Personal time series: local only, always available from the user's
 *    first purchase of this item, no network needed.
 *  - Crowd band: `price_aggregates` (§7's privacy floor — needs >= 5
 *    distinct users per commodity/market/month). This is a pre-launch app
 *    with no real user density yet, so this section will show its designed
 *    empty state for everyone until that changes — that's correct behaviour,
 *    not a bug, and is why the two sections load and fail independently
 *    rather than one blocking page.
 */
interface HistoryRow {
  line: LocalLine;
  trip: LocalTrip | undefined;
  market: LocalLocation | undefined;
}

type PersonalState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "ready"; commodity: LocalCommodity | undefined; rows: HistoryRow[] };

type CrowdState =
  | { kind: "loading" }
  | { kind: "unavailable" } // network/query failure — not the same as "no data yet"
  | { kind: "empty" } // query succeeded, no rows at all
  | { kind: "ready"; bands: CrowdBandRow[] };

export function CommodityDetail({ commodityId, userId }: { commodityId: string; userId: string }) {
  const [, navigate] = useRouterLocation();
  const [personal, setPersonal] = useState<PersonalState>({ kind: "loading" });
  const [crowd, setCrowd] = useState<CrowdState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [lines, commodity] = await Promise.all([
        personalPurchaseHistory(userId, commodityId),
        db.commodities.get(commodityId),
      ]);
      if (cancelled) return;

      if (lines.length === 0) {
        setPersonal({ kind: "empty" });
        return;
      }

      const tripIds = [...new Set(lines.map((l) => l.tripId))];
      const trips = await db.trips.bulkGet(tripIds);
      const tripById = new Map(trips.filter((t) => t !== undefined).map((t) => [t!.id, t!]));

      const marketIds = [...new Set([...tripById.values()].map((t) => t.marketId).filter((id): id is string => id !== null))];
      const markets = await db.locations.bulkGet(marketIds);
      const marketById = new Map(markets.filter((m) => m !== undefined).map((m) => [m!.id, m!]));

      if (cancelled) return;
      setPersonal({
        kind: "ready",
        commodity,
        rows: lines.map((line) => {
          const trip = tripById.get(line.tripId);
          return { line, trip, market: trip?.marketId ? marketById.get(trip.marketId) : undefined };
        }),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [commodityId, userId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const bands = await fetchCrowdBands(commodityId);
        if (cancelled) return;
        setCrowd(bands.length === 0 ? { kind: "empty" } : { kind: "ready", bands });
      } catch {
        if (!cancelled) setCrowd({ kind: "unavailable" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [commodityId]);

  if (personal.kind === "loading") {
    return <main aria-busy="true">Loading…</main>;
  }

  if (personal.kind === "empty") {
    return (
      <main>
        <h1>Price history</h1>
        <p>You haven&rsquo;t logged this item before, so there&rsquo;s no history to show yet.</p>
        <button type="button" onClick={() => navigate("/capture")}>
          Log a shop
        </button>
      </main>
    );
  }

  const { commodity, rows } = personal;

  return (
    <main>
      <h1>{commodity?.canonicalName ?? "Price history"}</h1>

      <section aria-label="Your purchase history">
        <h2>Your history</h2>
        <ul aria-label="Your purchase history">
          {rows.map(({ line, trip, market }) => (
            <li key={line.id}>
              {trip?.tripDate ?? "Unknown date"} — {market?.name ?? "Unknown market"} —{" "}
              {formatNaira(BigInt(line.paidPriceKobo))} for {line.quantity}
              {line.outlierFlagged && !line.userConfirmed && " (unusual price)"}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="What others paid">
        <h2>What others paid</h2>
        {crowd.kind === "loading" && <p aria-busy="true">Checking…</p>}
        {crowd.kind === "unavailable" && (
          <p>Couldn&rsquo;t load this right now — your own history above is unaffected.</p>
        )}
        {crowd.kind === "empty" && (
          <p>Not enough shoppers on MarketPulse yet to show this — nothing is hidden, there just isn&rsquo;t a crowd here yet.</p>
        )}
        {crowd.kind === "ready" && (
          <ul aria-label="Crowd price bands by market and month">
            {crowd.bands.map((band) => (
              <li key={`${band.marketId}-${band.periodMonth}`}>
                {band.periodMonth} —{" "}
                {band.medianKobo === null
                  ? `not enough shoppers yet (${band.distinctUserCount}/5)`
                  : `typically ${formatNaira(band.p25Kobo!)}–${formatNaira(band.p75Kobo!)}, median ${formatNaira(band.medianKobo)}`}
                {band.gradeCaveat && " — grade/quality varies, treat as a rough guide"}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
