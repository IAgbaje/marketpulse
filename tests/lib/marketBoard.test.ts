import { describe, it, expect, vi, beforeEach } from "vitest";

const order = vi.fn();
const not = vi.fn(() => ({ order }));
const eqMonth = vi.fn(() => ({ not }));
const eqMarket = vi.fn(() => ({ eq: eqMonth }));
const select = vi.fn(() => ({ eq: eqMarket }));

vi.mock("@/src/lib/supabase", () => ({
  supabase: { from: vi.fn(() => ({ select })) },
}));

import { fetchMarketBands } from "@/src/lib/marketBoard";

beforeEach(() => {
  vi.clearAllMocks();
  select.mockReturnValue({ eq: eqMarket });
  eqMarket.mockReturnValue({ eq: eqMonth });
  eqMonth.mockReturnValue({ not });
  not.mockReturnValue({ order });
});

describe("fetchMarketBands", () => {
  it("maps joined commodity name and converts money fields to bigint", async () => {
    order.mockResolvedValue({
      data: [
        {
          commodity_id: "rice_local",
          median_kobo: 300000,
          p25_kobo: 280000,
          p75_kobo: 320000,
          grade_caveat: false,
          commodities: { canonical_name: "Rice (local)" },
        },
      ],
      error: null,
    });

    const rows = await fetchMarketBands("m1", "2026-08-01");
    expect(rows).toEqual([
      {
        commodityId: "rice_local",
        canonicalName: "Rice (local)",
        medianKobo: 300000n,
        p25Kobo: 280000n,
        p75Kobo: 320000n,
        gradeCaveat: false,
      },
    ]);
  });

  it("handles the embed coming back as an array (some PostgREST configurations do this)", async () => {
    order.mockResolvedValue({
      data: [
        {
          commodity_id: "onion",
          median_kobo: 50000,
          p25_kobo: 45000,
          p75_kobo: 55000,
          grade_caveat: true,
          commodities: [{ canonical_name: "Onion" }],
        },
      ],
      error: null,
    });
    const rows = await fetchMarketBands("m1", "2026-08-01");
    expect(rows[0]?.canonicalName).toBe("Onion");
    expect(rows[0]?.gradeCaveat).toBe(true);
  });

  it("falls back to the commodity id if the name join is missing", async () => {
    order.mockResolvedValue({
      data: [
        { commodity_id: "req_abc", median_kobo: 1000, p25_kobo: 900, p75_kobo: 1100, grade_caveat: false, commodities: null },
      ],
      error: null,
    });
    const rows = await fetchMarketBands("m1", "2026-08-01");
    expect(rows[0]?.canonicalName).toBe("req_abc");
  });

  it("throws on a query error", async () => {
    order.mockResolvedValue({ data: null, error: new Error("boom") });
    await expect(fetchMarketBands("m1", "2026-08-01")).rejects.toThrow("boom");
  });

  it("empty when the market has no published bands this month", async () => {
    order.mockResolvedValue({ data: [], error: null });
    expect(await fetchMarketBands("m1", "2026-08-01")).toEqual([]);
  });
});
