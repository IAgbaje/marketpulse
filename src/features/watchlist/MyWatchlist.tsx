import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../../lib/db.js";
import { formatNaira, parseNairaToKobo } from "../../lib/money.js";
import { addWatch, fetchAlerts, listWatches, markAlertRead, removeWatch, type WatchlistAlert } from "../../lib/watchlist.js";
import type { LocalWatchlistItem } from "../../lib/db.js";

/**
 * My Watchlist (§4 stage 9, `/watchlist`). Add an item (optionally scoped to
 * one market, optionally with a price ceiling), see triggered alerts.
 *
 * Delivery is IN-APP ONLY — this screen, checked when opened. §6.2 leaves
 * push/email as an unresolved V1 product decision (not MVP-blocking); it
 * explicitly names in-app as the option that "always works" even if it
 * can't deliver the timing-sensitive "pre-shop briefing" push would. That's
 * a real, disclosed limitation, not an oversight.
 */
export function MyWatchlist({ userId }: { userId: string }) {
  const [watches, setWatches] = useState<LocalWatchlistItem[] | null>(null);
  const [alerts, setAlerts] = useState<WatchlistAlert[] | "unavailable" | null>(null);
  const [commodityQuery, setCommodityQuery] = useState("");
  const [selectedCommodityId, setSelectedCommodityId] = useState("");
  const [marketId, setMarketId] = useState("");
  const [threshold, setThreshold] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const commodities = useLiveQuery(() => db.commodities.toArray(), []) ?? [];
  const aliases = useLiveQuery(() => db.aliases.toArray(), []) ?? [];
  const markets = useLiveQuery(() => db.locations.where("level").equals("market").toArray(), []) ?? [];

  async function reload() {
    setWatches(await listWatches(userId));
  }

  useEffect(() => {
    void reload();
    void fetchAlerts()
      .then(setAlerts)
      .catch(() => setAlerts("unavailable"));
  }, [userId]);

  const commodityMatches = useMemo(() => {
    if (commodityQuery.length < 2) return [];
    const q = commodityQuery.toLowerCase();
    const aliasIds = new Set(aliases.filter((a) => a.alias.toLowerCase().includes(q)).map((a) => a.commodityId));
    return commodities
      .filter((c) => c.canonicalName.toLowerCase().includes(q) || aliasIds.has(c.id))
      .slice(0, 8);
  }, [commodityQuery, commodities, aliases]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!selectedCommodityId) {
      setFormError("Pick an item from the list.");
      return;
    }
    let thresholdKobo: bigint | null = null;
    if (threshold.trim().length > 0) {
      thresholdKobo = parseNairaToKobo(threshold);
      if (thresholdKobo === null || thresholdKobo <= 0n) {
        setFormError("Enter a valid price, or leave it blank to just track this item.");
        return;
      }
    }
    await addWatch(userId, selectedCommodityId, marketId || null, thresholdKobo);
    setCommodityQuery("");
    setSelectedCommodityId("");
    setMarketId("");
    setThreshold("");
    await reload();
  }

  async function handleMarkRead(alertId: string) {
    await markAlertRead(alertId);
    setAlerts((prev) => (Array.isArray(prev) ? prev.map((a) => (a.id === alertId ? { ...a, readAt: new Date().toISOString() } : a)) : prev));
  }

  return (
    <main>
      <h1>My Watchlist</h1>

      <section aria-label="Alerts">
        <h2>Alerts</h2>
        {alerts === null && <p aria-busy="true">Loading…</p>}
        {alerts === "unavailable" && <p>Couldn&rsquo;t load alerts right now.</p>}
        {Array.isArray(alerts) && alerts.length === 0 && <p>No alerts yet.</p>}
        {Array.isArray(alerts) && alerts.length > 0 && (
          <ul aria-label="Price alerts">
            {alerts.map((a) => {
              const commodity = commodities.find((c) => c.id === a.commodityId);
              return (
                <li key={a.id}>
                  {commodity?.canonicalName ?? a.commodityId} dropped to {formatNaira(a.triggeredPriceKobo)}{" "}
                  (your alert: {formatNaira(a.thresholdKobo)} or below)
                  {a.readAt === null && (
                    <button type="button" onClick={() => void handleMarkRead(a.id)}>
                      Mark read
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-label="Watching">
        <h2>Watching</h2>
        {watches === null && <p aria-busy="true">Loading…</p>}
        {watches?.length === 0 && <p>Nothing on your watchlist yet.</p>}
        {watches && watches.length > 0 && (
          <ul aria-label="Watched items">
            {watches.map((w) => {
              const commodity = commodities.find((c) => c.id === w.commodityId);
              const market = markets.find((m) => m.id === w.marketId);
              return (
                <li key={w.id}>
                  {commodity?.canonicalName ?? w.commodityId}
                  {w.marketId ? ` at ${market?.name ?? "a market"}` : " (any market)"}
                  {w.thresholdKobo ? ` — alert at ${formatNaira(BigInt(w.thresholdKobo))} or below` : " — just tracking"}
                  <button
                    type="button"
                    onClick={() => void removeWatch(w.id).then(reload)}
                    aria-label={`Stop watching ${commodity?.canonicalName ?? w.commodityId}`}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-label="Add to watchlist">
        <h2>Watch a new item</h2>
        <form onSubmit={(e) => void handleAdd(e)}>
          <label>
            Item
            <input
              value={commodityQuery}
              onChange={(e) => {
                setCommodityQuery(e.target.value);
                setSelectedCommodityId("");
              }}
              placeholder="Start typing…"
              autoComplete="off"
            />
          </label>
          {commodityMatches.length > 0 && !selectedCommodityId && (
            <ul>
              {commodityMatches.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedCommodityId(c.id);
                      setCommodityQuery(c.canonicalName);
                    }}
                  >
                    {c.canonicalName}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <label>
            Market (optional — any market if left blank)
            <select value={marketId} onChange={(e) => setMarketId(e.target.value)}>
              <option value="">Any market</option>
              {markets.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            Alert me when it drops to (optional)
            <input inputMode="decimal" placeholder="₦" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
          </label>

          {formError && <p role="alert">{formError}</p>}

          <button type="submit">Add to watchlist</button>
        </form>
      </section>
    </main>
  );
}
