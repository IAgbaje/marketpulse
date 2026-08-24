/**
 * The exact-tie property suite.
 *
 * Technical Requirements §9 makes this a ship gate: the identity is enforced
 * here, not by review. Zero tolerance — no epsilon, no rounding slack.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { decompose, roundHalfEven, tiesExactly } from "./decompose.js";
import type { Basket, CommodityPeriodTotals } from "./types.js";

const NGN = "NGN";

function basket(
  commodities: readonly CommodityPeriodTotals[],
  excludedCost = 0n,
): Basket {
  return { currency: NGN, commodities, excludedCost };
}

function line(commodityId: string, cost: bigint, qty: bigint): CommodityPeriodTotals {
  return { commodityId, cost, qty };
}

/** Kobo values across a plausible household range, plus negatives and zero. */
const arbCost = fc.bigInt({ min: -50_000_00n, max: 50_000_00n });
/** Grams: 1g to 100kg. Strictly positive — zero is generated deliberately. */
const arbQty = fc.bigInt({ min: 1n, max: 100_000n });

const arbCommodity = (id: string) =>
  fc.record({ cost: arbCost, qty: arbQty }).map(({ cost, qty }) => line(id, cost, qty));

/**
 * Two baskets over a shared commodity-id pool, so intersections, entries and
 * exits all arise naturally rather than being hand-picked.
 */
const arbBasketPair = fc
  .array(fc.constantFrom("rice", "tomato", "paste", "oil", "beans", "fish", "yam"), {
    minLength: 0,
    maxLength: 7,
  })
  .chain((ids) => {
    const unique = [...new Set(ids)];
    return fc.record({
      priorIds: fc.subarray(unique),
      currentIds: fc.subarray(unique),
      excludedPrior: arbCost,
      excludedCurrent: arbCost,
    }).chain(({ priorIds, currentIds, excludedPrior, excludedCurrent }) =>
      fc.record({
        prior: fc.tuple(...priorIds.map((id) => arbCommodity(id))),
        current: fc.tuple(...currentIds.map((id) => arbCommodity(id))),
      }).map(({ prior, current }) => ({
        prior: basket(prior, excludedPrior),
        current: basket(current, excludedCurrent),
      })),
    );
  });

describe("roundHalfEven", () => {
  it("rounds to nearest", () => {
    expect(roundHalfEven(7n, 2n)).toBe(4n); // 3.5 -> 4 (even)
    expect(roundHalfEven(5n, 2n)).toBe(2n); // 2.5 -> 2 (even)
    expect(roundHalfEven(1n, 3n)).toBe(0n); // 0.333 -> 0
    expect(roundHalfEven(2n, 3n)).toBe(1n); // 0.666 -> 1
  });

  it("is symmetric across zero", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -1_000_000n, max: 1_000_000n }),
        fc.bigInt({ min: 1n, max: 10_000n }),
        (num, den) => {
          expect(roundHalfEven(-num, den)).toBe(-roundHalfEven(num, den));
        },
      ),
    );
  });

  it("normalises a negative denominator", () => {
    expect(roundHalfEven(7n, -2n)).toBe(-4n);
  });

  it("throws on a zero denominator", () => {
    expect(() => roundHalfEven(1n, 0n)).toThrow(/zero denominator/);
  });
});

describe("decompose — the exact-tie invariant", () => {
  it("ties exactly for arbitrary basket pairs", () => {
    fc.assert(
      fc.property(arbBasketPair, ({ prior, current }) => {
        const d = decompose(prior, current);
        expect(tiesExactly(d)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  // The named scenarios §3.3 requires explicitly, rather than trusting random
  // generation to reach them.
  it("ties with an empty intersection", () => {
    const d = decompose(
      basket([line("rice", 500_00n, 5000n)]),
      basket([line("yam", 300_00n, 3000n)]),
    );
    expect(tiesExactly(d)).toBe(true);
    expect(d.price).toBe(0n);
    expect(d.whatYouBought).toBe(0n);
    expect(d.newItems).toBe(300_00n);
    expect(d.stoppedBuying).toBe(500_00n);
  });

  it("ties when every item is new", () => {
    const d = decompose(basket([]), basket([line("rice", 500_00n, 5000n)]));
    expect(tiesExactly(d)).toBe(true);
    expect(d.newItemCount).toBe(1);
    expect(d.totalDelta).toBe(500_00n);
  });

  it("ties when every item was dropped", () => {
    const d = decompose(basket([line("rice", 500_00n, 5000n)]), basket([]));
    expect(tiesExactly(d)).toBe(true);
    expect(d.stoppedBuyingCount).toBe(1);
    expect(d.totalDelta).toBe(-500_00n);
  });

  it("ties for a single-item intersection with a repeating unit price", () => {
    // ₦1,500 over 700g — the §3.1 worked example, unit price 214.2857... kobo/g
    const d = decompose(
      basket([line("tomato", 150_000n, 700n)]),
      basket([line("tomato", 180_000n, 700n)]),
    );
    expect(tiesExactly(d)).toBe(true);
    expect(d.totalDelta).toBe(30_000n);
    // Quantity unchanged, so the whole delta is a price effect.
    expect(d.price).toBe(30_000n);
    expect(d.whatYouBought).toBe(0n);
  });

  it("ties when excluded outlier lines are present on both sides", () => {
    const d = decompose(
      basket([line("rice", 500_00n, 5000n)], 12_345n),
      basket([line("rice", 600_00n, 5000n)], 999n),
    );
    expect(tiesExactly(d)).toBe(true);
    expect(d.excludedDelta).toBe(999n - 12_345n);
  });
});

describe("decompose — classification (§3.3)", () => {
  it("routes a zero-quantity period to stopped-buying, never the intersection", () => {
    const d = decompose(
      basket([line("tomato", 150_00n, 700n)]),
      basket([line("tomato", 0n, 0n)]),
    );
    expect(tiesExactly(d)).toBe(true);
    // Must NOT be treated as a price effect on an intersection member.
    expect(d.price).toBe(0n);
    expect(d.whatYouBought).toBe(0n);
    expect(d.stoppedBuying).toBe(150_00n);
  });

  it("routes a zero-quantity prior period to new-items", () => {
    const d = decompose(
      basket([line("tomato", 0n, 0n)]),
      basket([line("tomato", 150_00n, 700n)]),
    );
    expect(tiesExactly(d)).toBe(true);
    expect(d.price).toBe(0n);
    expect(d.newItems).toBe(150_00n);
  });

  it("never divides by zero when quantity is zero on either side", () => {
    expect(() =>
      decompose(basket([line("x", 100n, 0n)]), basket([line("x", 100n, 0n)])),
    ).not.toThrow();
  });
});

describe("decompose — guards", () => {
  it("rejects a currency mismatch", () => {
    expect(() =>
      decompose(
        { currency: "NGN", commodities: [], excludedCost: 0n },
        { currency: "USD", commodities: [], excludedCost: 0n },
      ),
    ).toThrow(/currency mismatch/);
  });

  it("rejects a negative quantity as data corruption", () => {
    expect(() =>
      decompose(basket([line("rice", 100n, -5n)]), basket([])),
    ).toThrow(/negative quantity/);
  });
});

describe("decompose — coverage disclosure", () => {
  it("reports intersection coverage as a share of prior spend", () => {
    const d = decompose(
      basket([line("rice", 700_00n, 5000n), line("yam", 300_00n, 3000n)]),
      basket([line("rice", 800_00n, 5000n)]),
    );
    expect(d.coveragePercent).toBe(70);
  });

  it("reports zero coverage when there is no prior spend", () => {
    const d = decompose(basket([]), basket([line("rice", 500_00n, 5000n)]));
    expect(d.coveragePercent).toBe(0);
  });
});
