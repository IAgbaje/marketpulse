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
    deletedAt: null,
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
    deletedAt: null,
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

/**
 * Tombstone a line: hidden from every local read immediately, and pushed to
 * the server as `deleted_at` on the next sync pass (src/lib/sync.ts) — no
 * longer local-only. Kept as a soft delete, not a hard one, so the removal
 * survives an offline→online round trip and can't be lost to a racing edit
 * from another device (the server tombstone is sticky).
 */
export async function deleteLine(lineId: string): Promise<void> {
  await db.lines.update(lineId, { deletedAt: nowIso(), syncStatus: "pending" });
}

/**
 * Tombstone a whole trip and every line on it. Used for "delete this past
 * trip" (C10). Same soft-delete contract as `deleteLine`.
 */
export async function deleteTrip(tripId: string): Promise<void> {
  const now = nowIso();
  await db.transaction("rw", db.trips, db.lines, async () => {
    await db.trips.update(tripId, { deletedAt: now, syncStatus: "pending" });
    const lineIds = await db.lines.where("tripId").equals(tripId).primaryKeys();
    await db.lines.bulkUpdate(
      lineIds.map((key) => ({ key, changes: { deletedAt: now, syncStatus: "pending" as const } })),
    );
  });
}

export async function getTripLines(tripId: string): Promise<LocalLine[]> {
  return db.lines
    .where("tripId")
    .equals(tripId)
    .filter((l) => !l.deletedAt)
    .toArray();
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
    .filter((l) => l.userId === userId && !l.deletedAt)
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
    .filter((t) => !t.isDraft && !t.deletedAt && t.marketId === marketId)
    .sortBy("clientUpdatedAt");
  return trips.at(-1);
}

/**
 * The committed trip immediately before `excludeTripId` at the same market —
 * Trip Summary's "prior comparable trip" (§4 stage 4, screen 7). Unlike
 * `findLastTripAtLocation` (used for repeat-last-shop, before the current
 * trip exists), this must exclude the trip just committed, or the "most
 * recent trip at this market" would just be itself.
 */
export async function findPriorTripAtLocation(
  userId: string,
  marketId: string,
  excludeTripId: string,
): Promise<LocalTrip | undefined> {
  const trips = await db.trips
    .where("userId")
    .equals(userId)
    .filter((t) => !t.isDraft && !t.deletedAt && t.marketId === marketId && t.id !== excludeTripId)
    .sortBy("clientUpdatedAt");
  return trips.at(-1);
}

/**
 * Every one of the user's own lines for a commodity, newest first —
 * Commodity Detail's personal time series (§4 stage 4, screen 11). Local
 * only; unlike the crowd band this needs no network and no privacy floor —
 * it's the user's own history.
 */
export async function personalPurchaseHistory(
  userId: string,
  commodityId: string,
  limit = 24,
): Promise<LocalLine[]> {
  return recentLines(userId, commodityId, limit);
}

/**
 * The user's most recent COMMITTED trips, newest first — Home's trip list
 * (§4 stage 4, screen 8). Drafts are deliberately excluded: an in-progress
 * shop is not "recent history" yet, it's still being captured.
 */
export async function listRecentTrips(userId: string, limit = 10): Promise<LocalTrip[]> {
  const trips = await db.trips
    .where("userId")
    .equals(userId)
    .filter((t) => !t.isDraft && !t.deletedAt)
    .sortBy("clientUpdatedAt");
  return trips.slice(-limit).reverse();
}

/**
 * Aggregates a trip's lines to one row per commodity — exactly the shape
 * `decompose()` requires (it throws on a duplicate commodityId, by design,
 * so a trip with two lines of the same item must be summed before calling
 * it). Integer kobo/base-unit sums throughout, no floats.
 */
export function aggregateLinesByCommodity(
  lines: readonly LocalLine[],
): { commodityId: string; costKobo: bigint; qtyBaseUnit: bigint }[] {
  const totals = new Map<string, { costKobo: bigint; qtyBaseUnit: bigint }>();
  for (const line of lines) {
    const prior = totals.get(line.commodityId) ?? { costKobo: 0n, qtyBaseUnit: 0n };
    totals.set(line.commodityId, {
      costKobo: prior.costKobo + BigInt(line.paidPriceKobo),
      qtyBaseUnit: prior.qtyBaseUnit + BigInt(line.qtyInBaseUnit),
    });
  }
  return [...totals.entries()].map(([commodityId, t]) => ({ commodityId, ...t }));
}

/**
 * Commodity ids from these lines that are outlier-flagged and NOT yet
 * confirmed by the user — the engine's `excludedCommodityIds` input (TR
 * §3.2): pulled out of PRICE/WHAT_YOU_BOUGHT into the single always-visible
 * EXCLUDED_DELTA reconciliation line, so the ledger still ties to the user's
 * true change rather than a silently-filtered one.
 */
export function unconfirmedOutlierCommodityIds(lines: readonly LocalLine[]): string[] {
  return [...new Set(lines.filter((l) => l.outlierFlagged && !l.userConfirmed).map((l) => l.commodityId))];
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
    deletedAt: null,
  }));
  await db.lines.bulkAdd(copies);
}
