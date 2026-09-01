/**
 * Local-first store (IndexedDB via Dexie).
 *
 * Spec: Technical Requirements §2.2, §5; Handover §9.2, §9.3.
 *
 * Every write lands here first with a client-generated UUID and a sync_status,
 * and the UI never waits on the network. A sync queue drains to Supabase on
 * reconnect — from trip 1, for durability, not only once crowd features exist.
 *
 * Versioning is INDEPENDENT of the Postgres schema (§2.2). When a Phase-0
 * field evolves, add a new `db.version(n).stores(...).upgrade(...)` block here
 * rather than mutating an existing one — users carry old data on devices that
 * may not have fetched a new bundle yet.
 *
 * Schema shape below mirrors `supabase/migrations/20260831000001_core_schema.sql`
 * (the live schema) — see that file for the authoritative column list.
 */

import Dexie, { type EntityTable } from "dexie";

export type SyncStatus = "pending" | "synced" | "failed";

export interface LocalTrip {
  /** Client-generated UUID. Also sent as both `id` and `client_trip_id` on
   * push, so retries are naturally idempotent (see src/lib/sync.ts). */
  id: string;
  userId: string;
  /** FK to a `locations` row at level='market'. Column is `market_id` server-side. */
  marketId: string | null;
  tripDate: string; // ISO date, no time
  currency: string;
  /** Provisional client-side guess; the server trigger `trg_trips_before_write`
   * sets the authoritative value from trip_date, never trusted from the client. */
  captureMethod: "same_day" | "recall";
  /** Device-local edit time. Evidence for the conflict UI, never an ordering key (§7.1).
   * Maps to `local_edited_at` server-side. */
  clientUpdatedAt: string;
  syncStatus: SyncStatus;
  /** Set while the trip is still being captured; committed trips are false. */
  isDraft: boolean;
}

export interface LocalLine {
  /** Client-generated UUID. Also sent as both `id` and `client_line_id` on push. */
  id: string;
  tripId: string;
  userId: string;
  commodityId: string;
  unitId: string;
  /** Integer kobo, held as a string because IndexedDB cannot index BigInt. */
  paidPriceKobo: string;
  currency: string;
  /** What the user typed, in the commodity_unit's unit_code. Maps to `qty_entered`. */
  quantity: number;
  /** Integer base units, string for the same reason as above. Maps to `qty_in_base_unit`. */
  qtyInBaseUnit: string;
  purchaseForm: "loose" | "pre_packed" | "bulk";
  /** Local-only display/heuristic ratio (paidPriceKobo / qtyInBaseUnit). Not a
   * server column — `unit_price_micro_kobo` is server-generated from the raw
   * columns instead, so this never needs to round-trip. */
  unitPriceNormalized: number;
  /** Local-only (OCR capture, not yet a server column). */
  rawText: string | null;
  /** Local-only (OCR capture, not yet a server column). */
  mappingConfidence: number | null;
  userConfirmed: boolean;
  outlierFlagged: boolean;
  clientUpdatedAt: string;
  syncStatus: SyncStatus;
}

/**
 * Cached reference data. Read-only locally; refreshed from the server. Held
 * on-device so capture and autocomplete work with no network.
 *
 * `id` is the commodity slug (e.g. 'rice_local') — the server's PK, not a uuid.
 */
export interface LocalCommodity {
  id: string;
  canonicalName: string;
  category: string;
  baseUnit: "g" | "ml" | "piece";
  substituteGroup: string | null;
  perishable: boolean;
  gradeSensitive: boolean;
  provisional: boolean;
}

/** One row of `commodity_aliases` — used to widen autocomplete matching. */
export interface LocalAlias {
  commodityId: string;
  alias: string;
}

export interface LocalUnit {
  id: string;
  unitCode: string;
  toBaseUnit: "g" | "ml" | "piece";
  /** null ⇒ commodity-independent unit (server '*' scope, e.g. 'piece'). */
  commodityId: string | null;
  /** Exact rational factor (base units per 1 unit_code) — bigint as string,
   * IndexedDB cannot index/store BigInt directly. Never convert to float. */
  factorNum: string;
  factorDen: string;
  confidence: "high" | "medium" | "low";
}

export interface LocalLocation {
  id: string;
  parentId: string | null;
  level: "country" | "state" | "lga" | "area" | "market";
  name: string;
  marketType: "open_market" | "supermarket" | "unknown" | null;
}

/**
 * Mirrors `user_budgets` (Stage 5, Budget Setup/Analysis). Local-first like
 * everything else here — set once a month, low-frequency, but still written
 * through Dexie first and synced, not called straight to Supabase, for the
 * same offline-durability reason as trips/lines (§5).
 */
export interface LocalBudget {
  id: string;
  userId: string;
  /** Integer kobo, string for the same IndexedDB-can't-index-BigInt reason
   * as LocalLine's money fields. */
  amountKobo: string;
  currency: string;
  periodKind: "monthly";
  /** ISO date, first of the month this budget takes effect from. */
  effectiveFrom: string;
  source: "derived_from_trip" | "manual";
  clientUpdatedAt: string;
  syncStatus: SyncStatus;
}

const db = new Dexie("marketpulse") as Dexie & {
  trips: EntityTable<LocalTrip, "id">;
  lines: EntityTable<LocalLine, "id">;
  commodities: EntityTable<LocalCommodity, "id">;
  aliases: EntityTable<LocalAlias, "alias">;
  units: EntityTable<LocalUnit, "id">;
  locations: EntityTable<LocalLocation, "id">;
  budgets: EntityTable<LocalBudget, "id">;
};

// IndexedDB cannot index booleans, so `isDraft` is not an index — draft
// lookup filters on an already-narrow per-user result set instead.
//
// v2: schema rewired onto the live server schema (20260831000001..000004) —
// commodities.id is a text slug (was uuid), category/name columns renamed,
// commodity_aliases added, units keyed by exact rational factor. Reference
// tables are pull-and-replace caches, so the v1→v2 upgrade just clears and
// lets the next boot's refreshReferenceData() repopulate them.
db.version(1).stores({
  trips: "id, userId, tripDate, syncStatus",
  lines: "id, tripId, userId, commodityId, syncStatus",
  commodities: "id, slug, category, substituteGroup",
  units: "id, commodityId",
  locations: "id, parentId, level",
});

db.version(2)
  .stores({
    trips: "id, userId, tripDate, syncStatus",
    lines: "id, tripId, userId, commodityId, syncStatus",
    commodities: "id, category, substituteGroup, provisional",
    aliases: "alias, commodityId",
    units: "id, commodityId, unitCode",
    locations: "id, parentId, level",
  })
  .upgrade(async (tx) => {
    // Cached reference data only — safe to drop and let boot repopulate it.
    await tx.table("commodities").clear();
    await tx.table("units").clear();
    await tx.table("locations").clear();
  });

// v3: adds budgets (Stage 5). Purely additive — no upgrade() needed, Dexie
// creates the new table empty.
db.version(3).stores({
  trips: "id, userId, tripDate, syncStatus",
  lines: "id, tripId, userId, commodityId, syncStatus",
  commodities: "id, category, substituteGroup, provisional",
  aliases: "alias, commodityId",
  units: "id, commodityId, unitCode",
  locations: "id, parentId, level",
  budgets: "id, userId, effectiveFrom, syncStatus",
});

export { db };

/**
 * The in-progress capture lives in Dexie as a draft trip from the first line
 * added, not in component state (§5). A force-quit mid-capture must lose at
 * most the keystrokes in the unsubmitted form — never committed lines.
 */
export async function getOpenDraft(userId: string): Promise<LocalTrip | undefined> {
  return db.trips
    .where("userId")
    .equals(userId)
    .filter((t) => t.isDraft)
    .first();
}
