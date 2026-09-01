import { describe, it, expect } from "vitest";
import { bandsForMonth, computeBasketTotals } from "@/src/lib/marketComparison";
import type { CrowdBandRow } from "@/src/lib/crowdBand";

function band(over: Partial<CrowdBandRow>): CrowdBandRow {
  return {
    marketId: "m1",
    periodMonth: "2026-08-01",
    distinctUserCount: 7,
    p25Kobo: 90000n,
    medianKobo: 100000n,
    p75Kobo: 110000n,
    gradeCaveat: false,
    ...over,
  };
}

describe("bandsForMonth", () => {
  it("keeps only the given month, and only published (non-null-median) bands", () => {
    const rows = [
      band({ periodMonth: "2026-08-01", medianKobo: 100000n }),
      band({ periodMonth: "2026-07-01", medianKobo: 90000n }),
      band({ periodMonth: "2026-08-01", medianKobo: null, p25Kobo: null, p75Kobo: null }),
    ];
    expect(bandsForMonth(rows, "2026-08-01")).toHaveLength(1);
  });
});

describe("computeBasketTotals", () => {
  it("sums median prices per market across the basket's commodities", () => {
    const byCommodity = new Map<string, CrowdBandRow[]>([
      ["rice", [band({ marketId: "m1", medianKobo: 300000n }), band({ marketId: "m2", medianKobo: 280000n })]],
      ["onion", [band({ marketId: "m1", medianKobo: 50000n }), band({ marketId: "m2", medianKobo: 60000n })]],
    ]);

    const totals = computeBasketTotals(byCommodity, ["rice", "onion"], "2026-08-01");
    expect(totals).toHaveLength(2);
    const m1 = totals.find((t) => t.marketId === "m1");
    const m2 = totals.find((t) => t.marketId === "m2");
    expect(m1?.totalKobo).toBe(350000n);
    expect(m1?.itemsPriced).toBe(2);
    expect(m1?.itemsMissing).toBe(0);
    expect(m2?.totalKobo).toBe(340000n);
  });

  it("sorts cheapest total first", () => {
    const byCommodity = new Map<string, CrowdBandRow[]>([
      ["rice", [band({ marketId: "m1", medianKobo: 300000n }), band({ marketId: "m2", medianKobo: 200000n })]],
    ]);
    const totals = computeBasketTotals(byCommodity, ["rice"], "2026-08-01");
    expect(totals.map((t) => t.marketId)).toEqual(["m2", "m1"]);
  });

  it("a market with a band for only SOME basket items still appears, with itemsMissing set honestly", () => {
    const byCommodity = new Map<string, CrowdBandRow[]>([
      ["rice", [band({ marketId: "m1", medianKobo: 300000n })]],
      ["onion", [band({ marketId: "m2", medianKobo: 60000n })]], // m1 has no onion band
    ]);
    const totals = computeBasketTotals(byCommodity, ["rice", "onion"], "2026-08-01");
    const m1 = totals.find((t) => t.marketId === "m1");
    expect(m1?.itemsPriced).toBe(1);
    expect(m1?.itemsMissing).toBe(1);
    expect(m1?.totalKobo).toBe(300000n);
  });

  it("a market with ZERO overlap is not listed at all (not shown as a misleading zero total)", () => {
    const byCommodity = new Map<string, CrowdBandRow[]>([["rice", [band({ marketId: "m1", medianKobo: 300000n })]]]);
    const totals = computeBasketTotals(byCommodity, ["rice"], "2026-08-01");
    expect(totals.some((t) => t.marketId === "m2")).toBe(false);
  });

  it("ties on total are broken by fewest missing items", () => {
    const byCommodity = new Map<string, CrowdBandRow[]>([
      ["rice", [band({ marketId: "m1", medianKobo: 100000n }), band({ marketId: "m2", medianKobo: 100000n })]],
      ["onion", [band({ marketId: "m1", medianKobo: 0n })]], // only m1 has this second item
    ]);
    const totals = computeBasketTotals(byCommodity, ["rice", "onion"], "2026-08-01");
    // both total 100000, but m1 has 2/2 priced vs m2's 1/2 -- m1 should rank first
    expect(totals[0]?.marketId).toBe("m1");
  });

  it("empty basket -> no markets listed", () => {
    expect(computeBasketTotals(new Map(), [], "2026-08-01")).toEqual([]);
  });
});
