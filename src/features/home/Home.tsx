import { useEffect, useState } from "react";
import { Link } from "wouter";
import { db } from "../../lib/db.js";
import { formatNaira } from "../../lib/money.js";
import { getTripLines, listRecentTrips } from "../../lib/trips.js";
import type { LocalLocation, LocalTrip } from "../../lib/db.js";

/**
 * Screen 8 — Home (§4 stage 4, PARTIAL — see build order note). Budget is
 * real as of stage 5 (links to Budget Analysis, which handles its own
 * no-budget-set-yet state). Crowd "movers" still isn't — that needs the
 * >= 5-distinct-user privacy floor (§7) this pre-launch app has no real
 * user density to clear yet, and stage 7+'s crowd-contribution feature
 * isn't built. Shown as a designed empty state below, not silently omitted.
 */
interface TripRow {
  trip: LocalTrip;
  market: LocalLocation | undefined;
  totalKobo: bigint;
  itemCount: number;
}

type ViewState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "ready"; rows: TripRow[] };

export function Home({ userId }: { userId: string }) {
  const [state, setState] = useState<ViewState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const trips = await listRecentTrips(userId);
      if (trips.length === 0) {
        if (!cancelled) setState({ kind: "empty" });
        return;
      }

      const marketIds = [...new Set(trips.map((t) => t.marketId).filter((id): id is string => id !== null))];
      const markets = await db.locations.bulkGet(marketIds);
      const marketById = new Map(markets.filter((m) => m !== undefined).map((m) => [m!.id, m!]));

      const rows = await Promise.all(
        trips.map(async (trip): Promise<TripRow> => {
          const lines = await getTripLines(trip.id);
          return {
            trip,
            market: trip.marketId ? marketById.get(trip.marketId) : undefined,
            totalKobo: lines.reduce((sum, l) => sum + BigInt(l.paidPriceKobo), 0n),
            itemCount: lines.length,
          };
        }),
      );

      if (!cancelled) setState({ kind: "ready", rows });
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return (
    <main>
      <h1>MarketPulse</h1>

      <p>
        <Link to="/capture">
          <button type="button">Log a shop</button>
        </Link>
      </p>

      <section aria-label="Budget">
        <h2>Budget</h2>
        <p>
          <Link to="/budget">See how this month is going</Link>
        </p>
      </section>

      <section aria-label="Recent shops">
        <h2>Recent shops</h2>
        {state.kind === "loading" && <p aria-busy="true">Loading…</p>}
        {state.kind === "empty" && (
          <p>Nothing logged yet — your first shop will show up here.</p>
        )}
        {state.kind === "ready" && (
          <ul aria-label="Recent shops">
            {state.rows.map(({ trip, market, totalKobo, itemCount }) => (
              <li key={trip.id}>
                <Link to={`/trips/${trip.id}/summary`}>
                  {market?.name ?? "Unknown market"} — {trip.tripDate} — {formatNaira(totalKobo)}{" "}
                  ({itemCount} item{itemCount === 1 ? "" : "s"})
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Price movers">
        <h2>What's moving</h2>
        <p>Not enough shoppers on MarketPulse yet to show crowd price trends.</p>
      </section>

      <section aria-label="Markets">
        <h2>Markets</h2>
        <p>
          <Link to="/map">Browse markets</Link> ·{" "}
          <Link to="/compare/basket">Compare your last basket</Link>
        </p>
      </section>

      <p>
        <Link to="/account/upgrade">Back up your data</Link>
      </p>
    </main>
  );
}
