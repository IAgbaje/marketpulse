/**
 * Soft-delete / tombstone convention (README "Money & data invariants" +
 * migration 20260902000001). Exercises the real trips.ts / watchlist.ts /
 * budgets.ts functions against a real Dexie instance (fake-indexeddb):
 *
 *  - a deleted line / trip / watch vanishes from every local read;
 *  - the tombstoned row is NOT gone from the store — it stays, marked
 *    pending, carrying `deletedAt`, so the next sync pass can push the
 *    delete to the server;
 *  - a deleted trip takes its lines with it, and drops out of the
 *    budget/decomposition month rollups.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/src/lib/db";
import {
  addLine,
  commitTrip,
  deleteLine,
  deleteTrip,
  getOrCreateDraft,
  getTripLines,
  listRecentTrips,
  personalPurchaseHistory,
} from "@/src/lib/trips";
import { monthLines } from "@/src/lib/budgets";
import { addWatch, listWatches, removeWatch } from "@/src/lib/watchlist";

const USER = "softdelete-user";
const MARKET = "softdelete-market";

async function seedUnit(): Promise<string> {
  const id = "softdelete-unit";
  await db.units.put({
    id,
    unitCode: "kg",
    toBaseUnit: "g",
    commodityId: null,
    factorNum: "1000",
    factorDen: "1",
    confidence: "high",
  });
  return id;
}

async function wipe() {
  await db.trips.where("userId").equals(USER).delete();
  await db.lines.where("userId").equals(USER).delete();
  await db.watchlist.where("userId").equals(USER).delete();
}

beforeEach(async () => {
  await db.open();
  await wipe();
});
afterEach(wipe);

async function committedTripWithTwoLines(unitId: string) {
  const draft = await getOrCreateDraft(USER, MARKET);
  const a = await addLine({
    tripId: draft.id,
    userId: USER,
    commodityId: "rice_local",
    unitId,
    quantity: 2,
    paidPriceKobo: 300000n,
    purchaseForm: "loose",
  });
  const b = await addLine({
    tripId: draft.id,
    userId: USER,
    commodityId: "onion",
    unitId,
    quantity: 1,
    paidPriceKobo: 50000n,
    purchaseForm: "loose",
  });
  await commitTrip(draft.id);
  return { tripId: draft.id, a, b };
}

describe("deleteLine", () => {
  it("removes the line from reads but keeps a pending tombstone row to sync", async () => {
    const unitId = await seedUnit();
    const { tripId, a } = await committedTripWithTwoLines(unitId);

    await deleteLine(a.id);

    expect(await getTripLines(tripId)).toHaveLength(1);
    expect(await personalPurchaseHistory(USER, "rice_local")).toHaveLength(0);

    const rowStillThere = await db.lines.get(a.id);
    expect(rowStillThere?.deletedAt).toBeTruthy();
    expect(rowStillThere?.syncStatus).toBe("pending");
  });

  it("survives a connection close/reopen (the delete is durable, not in-memory)", async () => {
    const unitId = await seedUnit();
    const { tripId, a } = await committedTripWithTwoLines(unitId);
    await deleteLine(a.id);

    db.close();
    await db.open();

    expect(await getTripLines(tripId)).toHaveLength(1);
  });
});

describe("deleteTrip", () => {
  it("tombstones the trip and every line on it, and drops it from month rollups", async () => {
    const unitId = await seedUnit();
    const { tripId } = await committedTripWithTwoLines(unitId);

    const month = new Date().toISOString().slice(0, 8) + "01";
    expect((await monthLines(USER, month)).length).toBeGreaterThan(0);

    await deleteTrip(tripId);

    expect(await listRecentTrips(USER)).toHaveLength(0);
    expect(await getTripLines(tripId)).toHaveLength(0);
    expect(await monthLines(USER, month)).toHaveLength(0);

    const trip = await db.trips.get(tripId);
    expect(trip?.deletedAt).toBeTruthy();
    expect(trip?.syncStatus).toBe("pending");
    const lines = await db.lines.where("tripId").equals(tripId).toArray();
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.deletedAt && l.syncStatus === "pending")).toBe(true);
  });
});

describe("removeWatch", () => {
  it("removes the watch from listWatches but keeps a pending tombstone", async () => {
    const w = await addWatch(USER, "rice_local", null, null);
    expect(await listWatches(USER)).toHaveLength(1);

    await removeWatch(w.id);

    expect(await listWatches(USER)).toHaveLength(0);
    const row = await db.watchlist.get(w.id);
    expect(row?.deletedAt).toBeTruthy();
    expect(row?.syncStatus).toBe("pending");
  });
});
