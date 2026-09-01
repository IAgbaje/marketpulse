import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/src/lib/db";

const from = vi.fn();
vi.mock("@/src/lib/supabase", () => ({ supabase: { from: (...a: unknown[]) => from(...a) } }));

import { addWatch, fetchAlerts, listWatches, markAlertRead, removeWatch } from "@/src/lib/watchlist";

const USER = "watchlist-test-user";

beforeEach(async () => {
  await db.open();
  await db.watchlist.where("userId").equals(USER).delete();
  vi.clearAllMocks();
});

afterEach(async () => {
  await db.watchlist.where("userId").equals(USER).delete();
});

describe("addWatch / listWatches / removeWatch", () => {
  it("adds a watch with a threshold and lists it back", async () => {
    const w = await addWatch(USER, "rice_local", "m1", 300000n);
    const all = await listWatches(USER);
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(w.id);
    expect(all[0]?.thresholdKobo).toBe("300000");
    expect(all[0]?.marketId).toBe("m1");
    expect(all[0]?.syncStatus).toBe("pending");
  });

  it("a watch with no threshold is just tracking (thresholdKobo null)", async () => {
    await addWatch(USER, "onion", null, null);
    const all = await listWatches(USER);
    expect(all[0]?.thresholdKobo).toBeNull();
    expect(all[0]?.marketId).toBeNull();
  });

  it("rejects a negative threshold", async () => {
    await expect(addWatch(USER, "rice_local", null, -1n)).rejects.toThrow(/negative/);
  });

  it("removeWatch deletes it locally", async () => {
    const w = await addWatch(USER, "rice_local", null, null);
    await removeWatch(w.id);
    expect(await listWatches(USER)).toEqual([]);
  });
});

describe("fetchAlerts / markAlertRead", () => {
  it("maps alert rows and converts money fields to bigint", async () => {
    const order = vi.fn().mockResolvedValue({
      data: [
        {
          id: "a1",
          commodity_id: "rice_local",
          market_id: "m1",
          period_month: "2026-08-01",
          triggered_price_kobo: 280000,
          threshold_kobo: 300000,
          created_at: "2026-08-15T00:00:00Z",
          read_at: null,
        },
      ],
      error: null,
    });
    from.mockReturnValue({ select: () => ({ order }) });

    const alerts = await fetchAlerts();
    expect(alerts).toEqual([
      {
        id: "a1",
        commodityId: "rice_local",
        marketId: "m1",
        periodMonth: "2026-08-01",
        triggeredPriceKobo: 280000n,
        thresholdKobo: 300000n,
        createdAt: "2026-08-15T00:00:00Z",
        readAt: null,
      },
    ]);
  });

  it("throws on a query error", async () => {
    const order = vi.fn().mockResolvedValue({ data: null, error: new Error("boom") });
    from.mockReturnValue({ select: () => ({ order }) });
    await expect(fetchAlerts()).rejects.toThrow("boom");
  });

  it("markAlertRead sets read_at via an update, scoped by id", async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn(() => ({ eq }));
    from.mockReturnValue({ update });

    await markAlertRead("a1");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ read_at: expect.any(String) }));
    expect(eq).toHaveBeenCalledWith("id", "a1");
  });

  it("markAlertRead surfaces an update error", async () => {
    const eq = vi.fn().mockResolvedValue({ error: new Error("denied") });
    from.mockReturnValue({ update: () => ({ eq }) });
    await expect(markAlertRead("a1")).rejects.toThrow("denied");
  });
});
