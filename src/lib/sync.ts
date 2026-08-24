/**
 * Sync queue: drains committed, locally-pending trips and lines to Supabase.
 * Durability, not crowd participation — this exists so IndexedDB eviction
 * cannot take a user's history with it (Handover §9.2, §17.2).
 *
 * Runs on: app boot, `online` events, and a periodic fallback interval (for
 * the case where the browser never fires `online` reliably). Every call is
 * safe to run concurrently with itself — Dexie's per-record queries and
 * Supabase upserts make a duplicate pass a no-op, not a duplicate write.
 */

import { supabase } from "./supabase.js";
import { db, type LocalLine, type LocalTrip } from "./db.js";

async function pushTrips(trips: LocalTrip[]): Promise<Set<string>> {
  if (trips.length === 0) return new Set();

  const rows = trips.map((t) => ({
    id: t.id,
    user_id: t.userId,
    location_id: t.locationId,
    trip_date: t.tripDate,
    currency: t.currency,
    capture_method: t.captureMethod,
    client_updated_at: t.clientUpdatedAt,
  }));

  const { error } = await supabase.from("shopping_trips").upsert(rows, { onConflict: "id" });
  if (error) {
    console.error("sync: trip push failed", error);
    return new Set();
  }
  return new Set(trips.map((t) => t.id));
}

async function pushLines(lines: LocalLine[]): Promise<Set<string>> {
  if (lines.length === 0) return new Set();

  const rows = lines.map((l) => ({
    id: l.id,
    trip_id: l.tripId,
    user_id: l.userId,
    commodity_id: l.commodityId,
    unit_id: l.unitId,
    paid_price_kobo: l.paidPriceKobo,
    currency: l.currency,
    quantity: l.quantity,
    qty_in_base_unit: l.qtyInBaseUnit,
    purchase_form: l.purchaseForm,
    unit_price_normalized: l.unitPriceNormalized,
    raw_text: l.rawText,
    mapping_confidence: l.mappingConfidence,
    user_confirmed: l.userConfirmed,
    outlier_flagged: l.outlierFlagged,
  }));

  const { error } = await supabase.from("purchase_lines").upsert(rows, { onConflict: "id" });
  if (error) {
    console.error("sync: line push failed", error);
    return new Set();
  }
  return new Set(lines.map((l) => l.id));
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
