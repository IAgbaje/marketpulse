import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/src/lib/db";
import { addLine, commitTrip, findPriorTripAtLocation, getOrCreateDraft } from "@/src/lib/trips";

const USER = "find-prior-trip-test-user";
const MARKET = "find-prior-trip-test-market";
const OTHER_MARKET = "find-prior-trip-test-other-market";
const UNIT = "find-prior-trip-test-unit";

async function makeCommittedTrip(marketId: string): Promise<string> {
  // getOrCreateDraft returns the single open draft per user, so each call in
  // a test must first commit the previous one — mirrors the real
  // capture → confirm → commit flow, one trip at a time.
  const draft = await getOrCreateDraft(USER, marketId);
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

describe("findPriorTripAtLocation", () => {
  it("finds the most recent committed trip at the same market, excluding the one just committed", async () => {
    const first = await makeCommittedTrip(MARKET);
    const second = await makeCommittedTrip(MARKET);

    const prior = await findPriorTripAtLocation(USER, MARKET, second);
    expect(prior?.id).toBe(first);
  });

  it("never returns the trip being excluded, even if it's the only one", async () => {
    const only = await makeCommittedTrip(MARKET);
    const prior = await findPriorTripAtLocation(USER, MARKET, only);
    expect(prior).toBeUndefined();
  });

  it("ignores trips at a different market", async () => {
    await makeCommittedTrip(OTHER_MARKET);
    const thisTrip = await makeCommittedTrip(MARKET);

    const prior = await findPriorTripAtLocation(USER, MARKET, thisTrip);
    expect(prior).toBeUndefined();
  });
});
