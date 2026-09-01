/**
 * Sync queue: drains committed, locally-pending trips and lines to Supabase.
 * Durability, not crowd participation — this exists so IndexedDB eviction
 * cannot take a user's history with it (Handover §9.2, §17.2).
 *
 * Runs on: app boot, `online` events, and a periodic fallback interval (for
 * the case where the browser never fires `online` reliably). Every call is
 * safe to run concurrently with itself — Dexie's per-record queries and
 * Supabase upserts make a duplicate pass a no-op, not a duplicate write.
 *
 * Both `shopping_trips` and `purchase_lines` let the client provide the row's
 * `id` explicitly (server default is only a fallback), so the local
 * client-generated UUID is reused as the server PK directly, and doubles as
 * the row's `client_trip_id` / `client_line_id` — the columns the server's
 * unique constraints key retry-idempotency on (§7). A trip must land before
 * its lines so the lines' `trip_id` FK is always satisfiable.
 */

import { supabase } from "./supabase.js";
import { db, type LocalLine, type LocalTrip } from "./db.js";

async function pushTrips(trips: LocalTrip[]): Promise<Set<string>> {
  if (trips.length === 0) return new Set();

  const rows = trips
    .filter((t) => t.marketId !== null)
    .map((t) => ({
      id: t.id,
      client_trip_id: t.id,
      user_id: t.userId,
      market_id: t.marketId,
      trip_date: t.tripDate,
      currency: t.currency,
      capture_method: t.captureMethod,
      local_edited_at: t.clientUpdatedAt,
    }));
  if (rows.length === 0) return new Set();

  const { error } = await supabase
    .from("shopping_trips")
    .upsert(rows, { onConflict: "user_id,client_trip_id" });
  if (error) {
    console.error("sync: trip push failed", error);
    return new Set();
  }
  return new Set(rows.map((r) => r.id));
}

async function pushLines(lines: LocalLine[]): Promise<Set<string>> {
  if (lines.length === 0) return new Set();

  const unitIds = [...new Set(lines.map((l) => l.unitId))];
  const units = await db.units.bulkGet(unitIds);
  const unitCodeById = new Map(units.filter((u) => u !== undefined).map((u) => [u!.id, u!.unitCode]));

  const rows = lines
    .map((l) => {
      const unitCode = unitCodeById.get(l.unitId);
      if (unitCode === undefined) {
        console.error(`sync: unknown unit ${l.unitId} for line ${l.id}, skipping`);
        return null;
      }
      return {
        id: l.id,
        client_line_id: l.id,
        trip_id: l.tripId,
        commodity_id: l.commodityId,
        unit_code: unitCode,
        qty_entered: l.quantity,
        qty_in_base_unit: l.qtyInBaseUnit,
        paid_price_kobo: l.paidPriceKobo,
        currency: l.currency,
        purchase_form: l.purchaseForm,
        flagged_outlier: l.outlierFlagged,
        outlier_confirmed: l.outlierFlagged ? l.userConfirmed : null,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  if (rows.length === 0) return new Set();

  const { error } = await supabase
    .from("purchase_lines")
    .upsert(rows, { onConflict: "trip_id,client_line_id" });
  if (error) {
    console.error("sync: line push failed", error);
    return new Set();
  }
  return new Set(rows.map((r) => r.id));
}

/**
 * One sync pass: committed trips only (drafts stay local-only, never synced —
 * they are not yet a real observation). Trips push before their lines, so a
 * line's foreign key is always satisfiable server-side.
 */
export async function syncOnce(): Promise<{ tripsSynced: number; linesSynced: number }> {
  const pendingTrips = await db.trips
    .where("syncStatus")
    .equals("pending")
    .filter((t) => !t.isDraft)
    .toArray();

  const syncedTripIds = await pushTrips(pendingTrips);
  if (syncedTripIds.size > 0) {
    await db.trips.bulkUpdate(
      [...syncedTripIds].map((id) => ({ key: id, changes: { syncStatus: "synced" as const } })),
    );
  }

  // Lines only sync once their trip has (avoids racing the FK), so a trip
  // whose push just failed simply retries whole on the next pass.
  const syncableTripIds = new Set([
    ...syncedTripIds,
    ...(await db.trips.where("syncStatus").equals("synced").primaryKeys()),
  ]);

  const pendingLines = (
    await db.lines.where("syncStatus").equals("pending").toArray()
  ).filter((l) => syncableTripIds.has(l.tripId));

  const syncedLineIds = await pushLines(pendingLines);
  if (syncedLineIds.size > 0) {
    await db.lines.bulkUpdate(
      [...syncedLineIds].map((id) => ({ key: id, changes: { syncStatus: "synced" as const } })),
    );
  }

  return { tripsSynced: syncedTripIds.size, linesSynced: syncedLineIds.size };
}

const FALLBACK_INTERVAL_MS = 60_000;

/** Wires sync to run on boot, on reconnect, and on a periodic fallback. */
export function startSyncLoop(): () => void {
  void syncOnce();

  const onOnline = () => void syncOnce();
  window.addEventListener("online", onOnline);

  const interval = window.setInterval(() => void syncOnce(), FALLBACK_INTERVAL_MS);

  return () => {
    window.removeEventListener("online", onOnline);
    window.clearInterval(interval);
  };
}
