/**
 * Watchlist CRUD + alert reads (Stage 9, My Watchlist). Watches are
 * local-first like everything else here (added to Dexie, drained by
 * sync.ts); alerts are server-computed output only (evaluate_watchlist_
 * thresholds(), migration 20260901220816) — read directly from Supabase,
 * same pattern as crowdBand.ts, never mirrored locally.
 */

import { db, type LocalWatchlistItem, type SyncStatus } from "./db.js";
import { supabase } from "./supabase.js";

function newId(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function addWatch(
  userId: string,
  commodityId: string,
  marketId: string | null,
  thresholdKobo: bigint | null,
): Promise<LocalWatchlistItem> {
  if (thresholdKobo !== null && thresholdKobo < 0n) {
    throw new Error("addWatch: threshold must not be negative");
  }
  const watch: LocalWatchlistItem = {
    id: newId(),
    userId,
    commodityId,
    marketId,
    thresholdKobo: thresholdKobo === null ? null : thresholdKobo.toString(),
    currency: "NGN",
    clientUpdatedAt: nowIso(),
    syncStatus: "pending" as SyncStatus,
    deletedAt: null,
  };
  await db.watchlist.add(watch);
  return watch;
}

/**
 * Tombstone a watch: gone from every local read immediately, pushed to the
 * server as `deleted_at` on the next sync pass and sticky there. Same
 * soft-delete contract as `deleteLine` / `deleteTrip` (src/lib/trips.ts).
 */
export async function removeWatch(id: string): Promise<void> {
  await db.watchlist.update(id, { deletedAt: nowIso(), syncStatus: "pending" });
}

export async function listWatches(userId: string): Promise<LocalWatchlistItem[]> {
  return db.watchlist
    .where("userId")
    .equals(userId)
    .filter((w) => !w.deletedAt)
    .toArray();
}

export interface WatchlistAlert {
  id: string;
  commodityId: string;
  marketId: string | null;
  periodMonth: string;
  triggeredPriceKobo: bigint;
  thresholdKobo: bigint;
  createdAt: string;
  readAt: string | null;
}

interface AlertRow {
  id: string;
  commodity_id: string;
  market_id: string | null;
  period_month: string;
  triggered_price_kobo: number | string;
  threshold_kobo: number | string;
  created_at: string;
  read_at: string | null;
}

/** Newest first. RLS scopes this to the caller's own alerts already. */
export async function fetchAlerts(): Promise<WatchlistAlert[]> {
  const { data, error } = await supabase
    .from("watchlist_alerts")
    .select("id, commodity_id, market_id, period_month, triggered_price_kobo, threshold_kobo, created_at, read_at")
    .order("created_at", { ascending: false });
  if (error) throw error;

  return (data as AlertRow[]).map((r) => ({
    id: r.id,
    commodityId: r.commodity_id,
    marketId: r.market_id,
    periodMonth: r.period_month,
    triggeredPriceKobo: BigInt(r.triggered_price_kobo),
    thresholdKobo: BigInt(r.threshold_kobo),
    createdAt: r.created_at,
    readAt: r.read_at,
  }));
}

export async function markAlertRead(alertId: string): Promise<void> {
  const { error } = await supabase
    .from("watchlist_alerts")
    .update({ read_at: new Date().toISOString() })
    .eq("id", alertId);
  if (error) throw error;
}
