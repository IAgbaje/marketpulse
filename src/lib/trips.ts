/**
 * Trip and line CRUD against the local-first store. Every write lands in
 * Dexie first with a client-generated UUID; the UI never waits on the
 * network (Handover §9.3). Sync (src/lib/sync.ts) drains this to Supabase.
 */

import { db, getOpenDraft, type LocalLine, type LocalTrip, type SyncStatus } from "./db.js";
import { isOutlier } from "./outlier.js";
import { toBaseUnits } from "./units.js";

function newId(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Returns the open draft trip for this user, creating one if none exists.
 * capture_method is decided at commit time, not here — see commitTrip.
 */
export async function getOrCreateDraft(
  userId: string,
  marketId: string | null,
): Promise<LocalTrip> {
  const existing = await getOpenDraft(userId);
  if (existing) return existing;

  const trip: LocalTrip = {
    id: newId(),
    userId,
    marketId,
    tripDate: new Date().toISOString().slice(0, 10),
    currency: "NGN",
    captureMethod: "same_day", // provisional; the server trigger sets it authoritatively
    clientUpdatedAt: nowIso(),
    syncStatus: "pending" as SyncStatus,
    isDraft: true,
  };
  await db.trips.add(trip);
  return trip;
}

export interface AddLineInput {
  tripId: string;
  userId: string;
  commodityId: string;
  unitId: string;
  quantity: number;
  paidPriceKobo: bigint;
  purchaseForm: LocalLine["purchaseForm"];
  rawText?: string | null;
}

/**
 * Adds a line and persists it immediately — this is what makes a mid-capture
 * force-quit lose at most the unsubmitted form, never a prior line (§5).
 * unit_price_normalized and the outlier flag are computed here, at write
 * time, never lazily at read time (§8.3 of the Handover).
 */
export async function addLine(input: AddLineInput): Promise<LocalLine> {
  const unit = await db.units.get(input.unitId);
  if (!unit) throw new Error(`Unknown unit ${input.unitId}`);

  const qtyInBaseUnit = toBaseUnits(input.quantity, unit);
  const unitPriceNormalized = Number(input.paidPriceKobo) / Number(qtyInBaseUnit);

  const priorPrices = await trailingUnitPrices(input.userId, input.commodityId);
  const outlierFlagged = isOutlier(unitPriceNormalized, priorPrices);

  const line: LocalLine = {
    id: newId(),
    tripId: input.tripId,
    userId: input.userId,
    commodityId: input.commodityId,
    unitId: input.unitId,
    paidPriceKobo: input.paidPriceKobo.toString(),
    currency: "NGN",
    quantity: input.quantity,
    qtyInBaseUnit: qtyInBaseUnit.toString(),
    purchaseForm: input.purchaseForm,
    unitPriceNormalized,
    rawText: input.rawText ?? null,
    mappingConfidence: null,
    userConfirmed: false,
    outlierFlagged,
    clientUpdatedAt: nowIso(),
    syncStatus: "pending",
  };

  await db.lines.add(line);
  return line;
}

export async function updateLine(
  lineId: string,
  patch: Partial<Pick<LocalLine, "quantity" | "paidPriceKobo" | "userConfirmed">>,
): Promise<void> {
  await db.lines.update(lineId, { ...patch, clientUpdatedAt: nowIso(), syncStatus: "pending" });
}

export async function deleteLine(lineId: string): Promise<void> {
  await db.lines.delete(lineId);
}

export async function getTripLines(tripId: string): Promise<LocalLine[]> {
  return db.lines.where("tripId").equals(tripId).toArray();
}

/**
 * The user's most recent normalized unit prices for a commodity, most recent
 * first — the trailing window the outlier guard compares against.
 */
export async function trailingUnitPrices(
  userId: string,
  commodityId: string,
  limit = 12,
): Promise<number[]> {
  return (await recentLines(userId, commodityId, limit)).map((l) => l.unitPriceNormalized);
}

async function recentLines(
  userId: string,
  commodityId: string,
  limit: number,
): Promise<LocalLine[]> {
  const lines = await db.lines
    .where("commodityId")
    .equals(commodityId)
    .filter((l) => l.userId === userId)
    .sortBy("clientUpdatedAt");
  return lines.slice(-limit).reverse();
}

/**
 * The user's most recent prior purchase of a commodity, excluding a given
 * line (so confirming the current trip doesn't show itself as "last time").
 * Backs US-2.1's "last time you paid" annotation — the actual prior line,
 * not a reconstruction from unit price x current quantity, which would
 * misstate what was actually paid whenever quantity has since changed.
 */
export async function mostRecentPriorLine(
  userId: string,
  commodityId: string,
  excludeLineId: string,
): Promise<LocalLine | undefined> {
  const lines = await recentLines(userId, commodityId, 5);
  return lines.find((l) => l.id !== excludeLineId);
}

/**
 * Commits the draft: sets capture_method (>48h after the trip date = recall,
 * §7.5 of the Handover), clears isDraft, and returns the committed trip. Sync
 * picks it up from here (src/lib/sync.ts).
 */
export async function commitTrip(tripId: string): Promise<void> {
  const trip = await db.trips.get(tripId);
  if (!trip) throw new Error(`Unknown trip ${tripId}`);

  const lines = await getTripLines(tripId);
  if (lines.length === 0) {
    throw new Error("Cannot commit a trip with no lines");
  }

  const tripDate = new Date(trip.tripDate);
  const hoursSinceTrip = (Date.now() - tripDate.getTime()) / (1000 * 60 * 60);
  const captureMethod: LocalTrip["captureMethod"] = hoursSinceTrip > 48 ? "recall" : "same_day";

  await db.trips.update(tripId, {
    isDraft: false,
    captureMethod,
    clientUpdatedAt: nowIso(),
    syncStatus: "pending",
  });
}

/**
 * Repeat last shop (C11, P0): pre-fills lines from the most recent committed
 * trip at the same market. The user edits prices/quantities only — this is
 * the single highest-leverage feature for the <90s capture target, and it
 * mechanically raises basket intersection, which the decomposition depends
 * on (Handover §17.10).
 */
export async function findLastTripAtLocation(
  userId: string,
  marketId: string,
): Promise<LocalTrip | undefined> {
  const trips = await db.trips
    .where("userId")
    .equals(userId)
    .filter((t) => !t.isDraft && t.marketId === marketId)
    .sortBy("clientUpdatedAt");
  return trips.at(-1);
}

export async function repeatLastShop(
  userId: string,
  sourceTripId: string,
  newTripId: string,
): Promise<void> {
  const sourceLines = await getTripLines(sourceTripId);
  const copies: LocalLine[] = sourceLines.map((line) => ({
    ...line,
    id: newId(),
    tripId: newTripId,
    userConfirmed: false, // prices must be re-confirmed even though they're pre-filled
    outlierFlagged: false,
    clientUpdatedAt: nowIso(),
    syncStatus: "pending",
  }));
  await db.lines.bulkAdd(copies);
}
