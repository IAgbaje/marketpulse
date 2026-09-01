import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/src/lib/db";
import { addLine, commitTrip, getOrCreateDraft } from "@/src/lib/trips";
import {
  addMonths,
  countCompleteMonths,
  getBudgetForMonth,
  monthLines,
  monthStart,
  setBudget,
  suggestBudgetFromLatestTrip,
} from "@/src/lib/budgets";

const USER = "budgets-test-user";
const MARKET = "budgets-test-market";
const UNIT = "budgets-test-unit";

async function makeCommittedTripOn(tripDate: string, paidPriceKobo = 100000n): Promise<string> {
  const draft = await getOrCreateDraft(USER, MARKET);
  await db.trips.update(draft.id, { tripDate });
  await addLine({
    tripId: draft.id,
    userId: USER,
    commodityId: "rice_local",
    unitId: UNIT,
    quantity: 1,
    paidPriceKobo,
    purchaseForm: "loose",
  });
  await commitTrip(draft.id);
  return draft.id;
}

beforeEach(async () => {
  await db.open();
  await db.trips.where("userId").equals(USER).delete();
  await db.budgets.where("userId").equals(USER).delete();
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
  await db.budgets.where("userId").equals(USER).delete();
});

describe("monthStart / addMonths", () => {
  it("returns the first of the month for a given date", () => {
    expect(monthStart(new Date("2026-08-17T10:00:00Z"))).toBe("2026-08-01");
  });

  it("addMonths shifts by whole months, including across year boundaries", () => {
    expect(addMonths("2026-08-01", -1)).toBe("2026-07-01");
    expect(addMonths("2026-01-01", -1)).toBe("2025-12-01");
    expect(addMonths("2026-08-01", 1)).toBe("2026-09-01");
  });
});

describe("setBudget / getBudgetForMonth", () => {
  it("saves a budget and retrieves it for the same month", async () => {
    await setBudget(USER, 5000000n, "2026-08-01", "manual");
    const found = await getBudgetForMonth(USER, "2026-08-01");
    expect(found?.amountKobo).toBe("5000000");
    expect(found?.source).toBe("manual");
  });

  it("re-setting the same month's budget updates it in place, not a duplicate", async () => {
    await setBudget(USER, 5000000n, "2026-08-01", "manual");
    await setBudget(USER, 6000000n, "2026-08-01", "manual");

    const all = await db.budgets.where("userId").equals(USER).toArray();
    expect(all).toHaveLength(1);
    expect(all[0]?.amountKobo).toBe("6000000");
  });

  it("a budget applies forward to later months until superseded", async () => {
    await setBudget(USER, 5000000n, "2026-06-01", "manual");
    const found = await getBudgetForMonth(USER, "2026-08-01");
    expect(found?.amountKobo).toBe("5000000");
  });

  it("the most recent budget at or before the month wins", async () => {
    await setBudget(USER, 5000000n, "2026-06-01", "manual");
    await setBudget(USER, 7000000n, "2026-07-01", "manual");
    const found = await getBudgetForMonth(USER, "2026-08-01");
    expect(found?.amountKobo).toBe("7000000");
  });

  it("no budget set at all returns undefined, not a thrown error", async () => {
    expect(await getBudgetForMonth(USER, "2026-08-01")).toBeUndefined();
  });

  it("rejects a negative amount", async () => {
    await expect(setBudget(USER, -1n, "2026-08-01", "manual")).rejects.toThrow(/negative/);
  });
});

describe("suggestBudgetFromLatestTrip", () => {
  it("suggests the latest trip's total", async () => {
    await makeCommittedTripOn("2026-08-01", 100000n);
    await makeCommittedTripOn("2026-08-15", 250000n);

    expect(await suggestBudgetFromLatestTrip(USER)).toBe(250000n);
  });

  it("null when the user has no trips yet", async () => {
    expect(await suggestBudgetFromLatestTrip(USER)).toBeNull();
  });
});

describe("countCompleteMonths", () => {
  it("the current month never counts, no matter how many trips are in it", async () => {
    const today = monthStart();
    await makeCommittedTripOn(today);
    expect(await countCompleteMonths(USER)).toBe(0);
  });

  it("counts distinct PAST calendar months with at least one committed trip", async () => {
    await makeCommittedTripOn("2026-06-15");
    await makeCommittedTripOn("2026-06-20"); // same month as above, counts once
    await makeCommittedTripOn("2026-07-10");
    expect(await countCompleteMonths(USER)).toBe(2);
  });
});

describe("monthLines", () => {
  it("only returns lines from trips within the given month", async () => {
    await makeCommittedTripOn("2026-07-31", 111n);
    await makeCommittedTripOn("2026-08-01", 222n);
    await makeCommittedTripOn("2026-08-31", 333n);
    await makeCommittedTripOn("2026-09-01", 444n);

    const lines = await monthLines(USER, "2026-08-01");
    expect(lines.map((l) => l.paidPriceKobo).sort()).toEqual(["222", "333"].sort());
  });
});
