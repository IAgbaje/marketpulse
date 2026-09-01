import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/src/lib/db";
import { addLine, commitTrip, getOrCreateDraft } from "@/src/lib/trips";
import { computeWeeklyReport, formatShareText } from "@/src/lib/weeklyReport";

const USER = "weekly-report-test-user";
const MARKET = "weekly-report-test-market";
const UNIT = "weekly-report-test-unit";

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function makeCommittedTripOn(tripDate: string, commodityId: string, paidPriceKobo: bigint): Promise<void> {
  const draft = await getOrCreateDraft(USER, MARKET);
  await db.trips.update(draft.id, { tripDate });
  await addLine({
    tripId: draft.id,
    userId: USER,
    commodityId,
    unitId: UNIT,
    quantity: 1,
    paidPriceKobo,
    purchaseForm: "loose",
  });
  await commitTrip(draft.id);
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

describe("computeWeeklyReport", () => {
  it("splits spend into this-week vs last-week by trip date", async () => {
    await makeCommittedTripOn(daysAgo(2), "rice_local", 300000n); // this week
    await makeCommittedTripOn(daysAgo(10), "rice_local", 200000n); // last week
    await makeCommittedTripOn(daysAgo(20), "rice_local", 999999n); // too old, excluded

    const report = await computeWeeklyReport(USER);
    expect(report.thisWeekSpentKobo).toBe(300000n);
    expect(report.lastWeekSpentKobo).toBe(200000n);
    expect(report.thisWeekTripCount).toBe(1);
  });

  it("ranks top commodities by this-week spend, highest first, capped at 5", async () => {
    await makeCommittedTripOn(daysAgo(1), "rice_local", 300000n);
    await makeCommittedTripOn(daysAgo(1), "onion", 500000n);
    await makeCommittedTripOn(daysAgo(1), "egg", 100000n);

    const report = await computeWeeklyReport(USER);
    expect(report.topCommodities.map((c) => c.commodityId)).toEqual(["onion", "rice_local", "egg"]);
  });

  it("zero trips this week and last -> all zero, no crash", async () => {
    const report = await computeWeeklyReport(USER);
    expect(report.thisWeekSpentKobo).toBe(0n);
    expect(report.lastWeekSpentKobo).toBe(0n);
    expect(report.thisWeekTripCount).toBe(0);
    expect(report.topCommodities).toEqual([]);
  });
});

describe("formatShareText", () => {
  const fmt = (k: bigint) => `₦${(Number(k) / 100).toFixed(2)}`;

  it("includes the total and trip count", () => {
    const text = formatShareText(
      { thisWeekSpentKobo: 300000n, lastWeekSpentKobo: 0n, thisWeekTripCount: 2, topCommodities: [] },
      fmt,
    );
    expect(text).toContain("2 shops");
    expect(text).toContain("₦3000.00");
  });

  it("omits the week-over-week comparison when there's no prior-week data", () => {
    const text = formatShareText(
      { thisWeekSpentKobo: 300000n, lastWeekSpentKobo: 0n, thisWeekTripCount: 1, topCommodities: [] },
      fmt,
    );
    expect(text).not.toMatch(/Up|Down|Same/);
  });

  it("states the direction and magnitude of the week-over-week change", () => {
    const text = formatShareText(
      { thisWeekSpentKobo: 500000n, lastWeekSpentKobo: 300000n, thisWeekTripCount: 1, topCommodities: [] },
      fmt,
    );
    expect(text).toContain("Up ₦2000.00 from last week");
  });
});
