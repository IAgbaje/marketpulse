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
 */

import Dexie, { type EntityTable } from "dexie";

export type SyncStatus = "pending" | "synced" | "failed";

export interface LocalTrip {
  id: string;
  userId: string;
  locationId: string | null;
  tripDate: string; // ISO date, no time
  currency: string;
  captureMethod: "same_day" | "recall";
  /** Device-local edit time. Evidence for the conflict UI, never an ordering key (§7.1). */
  clientUpdatedAt: string;
  syncStatus: SyncStatus;
  /** Set while the trip is still being captured; committed trips are false. */
  isDraft: boolean;
}

export interface LocalLine {
  id: string;
  tripId: string;
  userId: string;
  commodityId: string;
  unitId: string;
  /** Integer kobo, held as a string because IndexedDB cannot index BigInt. */
  paidPriceKobo: string;
  currency: string;
  quantity: number;
  /** Integer base units, string for the same reason as above. */
  qtyInBaseUnit: string;
  purchaseForm: "loose" | "pre_packed" | "bulk";
  unitPriceNormalized: number;
  rawText: string | null;
  mappingConfidence: number | null;
  userConfirmed: boolean;
  outlierFlagged: boolean;
  clientUpdatedAt: string;
  syncStatus: SyncStatus;
}

/**
 * Cached reference data. Read-only locally; refreshed from the server. Held
 * on-device so capture and autocomplete work with no network.
 */
export interface LocalCommodity {
  id: string;
  slug: string;
  name: string;
  category: string;
  substituteGroup: string | null;
  defaultUnitId: string | null;
}

export interface LocalUnit {
  id: string;
  commodityId: string;
  unitName: string;
  factorToBase: number;
  conversionConfidence: number;
}

const db = new Dexie("marketpulse") as Dexie & {
  trips: EntityTable<LocalTrip, "id">;
  lines: EntityTable<LocalLine, "id">;
  commodities: EntityTable<LocalCommodity, "id">;
  units: EntityTable<LocalUnit, "id">;
};

// IndexedDB cannot index booleans, so `isDraft` is not an index — draft
// lookup filters on an already-narrow per-user result set instead.
db.version(1).stores({
  trips: "id, userId, tripDate, syncStatus",
  lines: "id, tripId, userId, commodityId, syncStatus",
  commodities: "id, slug, category, substituteGroup",
  units: "id, commodityId",
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
