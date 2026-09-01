import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/src/lib/db";
import { addLine, commitTrip, getOrCreateDraft, listRecentTrips } from "@/src/lib/trips";

const USER = "list-recent-trips-test-user";
const MARKET = "list-recent-trips-test-market";
const UNIT = "list-recent-trips-test-unit";

async function makeCommittedTrip(): Promise<string> {
  const draft = await getOrCreateDraft(USER, MARKET);
  await addLine({
    tripId: draft.id,
    userId: USER,
    commodityId: "rice_local",
    unitId: UNIT,
    quantity: 1,
    paidPriceKobo: 100000n,
    purchaseForm: "loose",
  });
  await commitTrip(draft.id);
  return draft.id;
}

beforeEach(async () => {
  await db.open();
  await db.trips.where("userId").equals(USER).delete();
  await db.units.put({
    id: UNIT,
    unitCode: "kg",
    toBaseUnit: "g",
    commodityId: null,
    factorNum: "1000",
    factorDen: "1",
    confidence: "high",
  });
});

afterEach(async () => {
  await db.trips.where("userId").equals(USER).delete();
  await db.lines.where("userId").equals(USER).delete();
});

describe("listRecentTrips", () => {
  it("returns committed trips newest first", async () => {
    const first = await makeCommittedTrip();
    const second = await makeCommittedTrip();

    const trips = await listRecentTrips(USER);
    expect(trips.map((t) => t.id)).toEqual([second, first]);
  });

  it("excludes the open draft (an in-progress shop is not history yet)", async () => {
    const committed = await makeCommittedTrip();
    await getOrCreateDraft(USER, MARKET); // opens a new draft, not committed

    const trips = await listRecentTrips(USER);
    expect(trips.map((t) => t.id)).toEqual([committed]);
    expect(trips.every((t) => !t.isDraft)).toBe(true);
  });

  it("empty when the user has never committed a trip", async () => {
    expect(await listRecentTrips(USER)).toEqual([]);
  });

  it("respects the limit, keeping the most recent", async () => {
    const ids = [await makeCommittedTrip(), await makeCommittedTrip(), await makeCommittedTrip()];
    const trips = await listRecentTrips(USER, 2);
    expect(trips.map((t) => t.id)).toEqual([ids[2], ids[1]]);
  });
});
