import { describe, it, expect } from "vitest";
import {
  aggregateLinesByCommodity,
  unconfirmedOutlierCommodityIds,
} from "@/src/lib/trips";
import type { LocalLine } from "@/src/lib/db";

function line(over: Partial<LocalLine>): LocalLine {
  return {
    id: crypto.randomUUID(),
    tripId: "trip-1",
    userId: "user-1",
    commodityId: "rice_local",
    unitId: "unit-1",
    paidPriceKobo: "100000",
    currency: "NGN",
    quantity: 1,
    qtyInBaseUnit: "1000",
    purchaseForm: "loose",
    unitPriceNormalized: 100,
    rawText: null,
    mappingConfidence: null,
    userConfirmed: false,
    outlierFlagged: false,
    clientUpdatedAt: new Date().toISOString(),
    syncStatus: "pending",
    ...over,
  };
}

describe("aggregateLinesByCommodity", () => {
  it("sums cost and quantity per commodity, one row each", () => {
    const rows = aggregateLinesByCommodity([
      line({ commodityId: "rice_local", paidPriceKobo: "100000", qtyInBaseUnit: "1000" }),
      line({ commodityId: "rice_local", paidPriceKobo: "50000", qtyInBaseUnit: "500" }),
      line({ commodityId: "onion", paidPriceKobo: "20000", qtyInBaseUnit: "1000" }),
    ]);

    expect(rows).toHaveLength(2);
    const rice = rows.find((r) => r.commodityId === "rice_local");
    expect(rice?.costKobo).toBe(150000n);
    expect(rice?.qtyBaseUnit).toBe(1500n);
    const onion = rows.find((r) => r.commodityId === "onion");
    expect(onion?.costKobo).toBe(20000n);
    expect(onion?.qtyBaseUnit).toBe(1000n);
  });

  it("empty input produces an empty basket (the first-trip / no-lines case)", () => {
    expect(aggregateLinesByCommodity([])).toEqual([]);
  });

  it("never produces a duplicate commodityId row — decompose() throws on that", () => {
    const rows = aggregateLinesByCommodity([
      line({ commodityId: "egg" }),
      line({ commodityId: "egg" }),
      line({ commodityId: "egg" }),
    ]);
    expect(rows).toHaveLength(1);
  });
});

describe("unconfirmedOutlierCommodityIds", () => {
  it("includes only flagged-and-unconfirmed lines, deduplicated", () => {
    const ids = unconfirmedOutlierCommodityIds([
      line({ commodityId: "rice_local", outlierFlagged: true, userConfirmed: false }),
      line({ commodityId: "rice_local", outlierFlagged: true, userConfirmed: false }),
      line({ commodityId: "onion", outlierFlagged: true, userConfirmed: true }), // confirmed, excluded
      line({ commodityId: "egg", outlierFlagged: false, userConfirmed: false }), // never flagged
    ]);
    expect(ids).toEqual(["rice_local"]);
  });

  it("empty when nothing is flagged", () => {
    expect(unconfirmedOutlierCommodityIds([line({}), line({})])).toEqual([]);
  });
});
