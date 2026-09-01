import { useEffect, useState } from "react";
import { Link } from "wouter";
import { db, type LocalLocation } from "../../lib/db.js";

/**
 * Markets browse list — not one of the named MVP/V1 screens, but Market
 * Detail (`/map/market/:id`) needs SOME way to be reached that isn't the
 * (blocked, see MarketDetail.tsx) map. This is the plain-list stand-in,
 * same pattern as ManualEntry's inline market picker standing in for the
 * not-yet-built location-setup screen — flagged, not silently assumed.
 */
export function MarketsList() {
  const [markets, setMarkets] = useState<LocalLocation[] | null>(null);

  useEffect(() => {
    void db.locations.where("level").equals("market").toArray().then(setMarkets);
  }, []);

  return (
    <main>
      <h1>Markets</h1>
      {markets === null && <p aria-busy="true">Loading…</p>}
      {markets?.length === 0 && <p>No markets loaded yet.</p>}
      {markets && markets.length > 0 && (
        <ul aria-label="Markets">
          {markets.map((m) => (
            <li key={m.id}>
              <Link to={`/map/market/${m.id}`}>{m.name}</Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
