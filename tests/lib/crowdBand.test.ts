import { describe, it, expect, vi, beforeEach } from "vitest";

const eq = vi.fn();
const order = vi.fn();
const select = vi.fn(() => ({ eq }));

vi.mock("@/src/lib/supabase", () => ({
  supabase: {
    from: vi.fn(() => ({ select })),
  },
}));

import { fetchCrowdBands, matchCrowdBand, type CrowdBandRow } from "@/src/lib/crowdBand";

beforeEach(() => {
  vi.clearAllMocks();
  select.mockReturnValue({ eq });
  eq.mockReturnValue({ order });
});

describe("fetchCrowdBands", () => {
  it("maps NULL band columns through as null (below the 5-user privacy floor)", async () => {
    order.mockResolvedValue({
      data: [
        {
          market_id: "m1",
          period_month: "2026-08-01",
          distinct_user_count: 3,
          p25_kobo: null,
          median_kobo: null,
          p75_kobo: null,
          grade_caveat: false,
        },
      ],
      error: null,
    });

    const rows = await fetchCrowdBands("rice_local");
    expect(rows).toEqual([
      {
        marketId: "m1",
        periodMonth: "2026-08-01",
        distinctUserCount: 3,
        p25Kobo: null,
        medianKobo: null,
        p75Kobo: null,
        gradeCaveat: false,
      },
    ]);
  });

  it("converts published band figures to bigint, never float", async () => {
    order.mockResolvedValue({
      data: [
        {
          market_id: "m1",
          period_month: "2026-08-01",
          distinct_user_count: 7,
          p25_kobo: 280000,
          median_kobo: 300000,
          p75_kobo: 320000,
          grade_caveat: true,
        },
      ],
      error: null,
    });

    const rows = await fetchCrowdBands("rice_local");
    expect(rows[0]?.p25Kobo).toBe(280000n);
    expect(rows[0]?.medianKobo).toBe(300000n);
    expect(rows[0]?.p75Kobo).toBe(320000n);
    expect(rows[0]?.gradeCaveat).toBe(true);
  });

  it("throws on a query error rather than returning an empty/misleading result", async () => {
    order.mockResolvedValue({ data: null, error: new Error("network down") });
    await expect(fetchCrowdBands("rice_local")).rejects.toThrow("network down");
  });

  it("empty array when there are simply no buckets yet", async () => {
    order.mockResolvedValue({ data: [], error: null });
    expect(await fetchCrowdBands("rice_local")).toEqual([]);
  });
});

describe("matchCrowdBand", () => {
  const published: CrowdBandRow = {
    marketId: "m1",
    periodMonth: "2026-08-01",
    distinctUserCount: 7,
    p25Kobo: 280000n,
    medianKobo: 300000n,
    p75Kobo: 320000n,
    gradeCaveat: false,
  };
  const belowFloor: CrowdBandRow = {
    marketId: "m1",
    periodMonth: "2026-07-01",
    distinctUserCount: 2,
    p25Kobo: null,
    medianKobo: null,
    p75Kobo: null,
    gradeCaveat: false,
  };

  it("returns the matching published bucket", () => {
    expect(matchCrowdBand([published], "m1", "2026-08-01")).toBe(published);
  });

  it("no bucket for this market/month at all -> empty", () => {
    expect(matchCrowdBand([published], "m2", "2026-08-01")).toBe("empty");
    expect(matchCrowdBand([published], "m1", "2026-09-01")).toBe("empty");
  });

  it("a bucket exists but is below the privacy floor -> empty (same as no bucket, by design)", () => {
    expect(matchCrowdBand([belowFloor], "m1", "2026-07-01")).toBe("empty");
  });

  it("picks the right bucket out of several markets/months", () => {
    expect(matchCrowdBand([published, belowFloor], "m1", "2026-07-01")).toBe("empty");
    expect(matchCrowdBand([published, belowFloor], "m1", "2026-08-01")).toBe(published);
  });

  it("empty input -> empty", () => {
    expect(matchCrowdBand([], "m1", "2026-08-01")).toBe("empty");
  });
});
