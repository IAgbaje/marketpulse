import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { decompose, assertTies } from '@/src/engine/decomposition';
import { addRational, roundHalfEvenRational } from '@/src/engine/rational';
import type { CommodityPeriod, DecompositionInput } from '@/src/engine/types';

const abs = (x: bigint) => (x < 0n ? -x : x);

/** A commodity's position in one period, or absent. Enforces q === 0 ⇒ c === 0. */
const cellArb = fc
  .record({
    present: fc.boolean(),
    q: fc.bigInt({ min: 0n, max: 1_000_000n }),
    c: fc.bigInt({ min: 0n, max: 5_000_000_000n }), // up to ₦50m in kobo
  })
  .map(({ present, q, c }) => (present ? { q, c: q === 0n ? 0n : c } : null));

interface BasketRow {
  id: string;
  start: { q: bigint; c: bigint } | null;
  end: { q: bigint; c: bigint } | null;
  excluded: boolean;
}

const basketArb: fc.Arbitrary<BasketRow[]> = fc
  .array(fc.record({ start: cellArb, end: cellArb, excluded: fc.boolean() }), {
    minLength: 0,
    maxLength: 12,
  })
  .map((rows) =>
    rows
      .map((r, i): BasketRow => ({ id: `c${i}`, start: r.start, end: r.end, excluded: r.excluded }))
      // A commodity absent from both periods is simply not in play.
      .filter((r) => r.start !== null || r.end !== null),
  );

function toInput(basket: BasketRow[], currency = 'NGN'): DecompositionInput {
  const periodStart: CommodityPeriod[] = [];
  const periodEnd: CommodityPeriod[] = [];
  const excludedCommodityIds: string[] = [];
  for (const row of basket) {
    if (row.start) periodStart.push({ commodityId: row.id, costKobo: row.start.c, qtyBaseUnit: row.start.q });
    if (row.end) periodEnd.push({ commodityId: row.id, costKobo: row.end.c, qtyBaseUnit: row.end.q });
    if (row.excluded) excludedCommodityIds.push(row.id);
  }
  return { periodStart, periodEnd, excludedCommodityIds, currency };
}

describe('decompose — property: the exact-tie identity holds with zero tolerance', () => {
  it('price + whatYouBought + new − stopped + excludedDelta === totalChange', () => {
    fc.assert(
      fc.property(basketArb, (basket) => {
        const d = decompose(toInput(basket));
        expect(() => assertTies(d)).not.toThrow();
        expect(
          d.priceKobo +
            d.whatYouBoughtKobo +
            d.newItemsKobo -
            d.stoppedBuyingKobo +
            d.excludedDeltaKobo,
        ).toBe(d.totalChangeKobo);
      }),
      { numRuns: 2000 },
    );
  });

  it('every intersection line ties on its own: priceKobo + whatYouBoughtKobo === totalChangeKobo', () => {
    fc.assert(
      fc.property(basketArb, (basket) => {
        const d = decompose(toInput(basket));
        for (const line of d.intersection) {
          expect(line.priceKobo + line.whatYouBoughtKobo).toBe(line.totalChangeKobo);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('totalChange always equals the raw sum of (c1 − c0) over the union', () => {
    fc.assert(
      fc.property(basketArb, (basket) => {
        const d = decompose(toInput(basket));
        let raw = 0n;
        for (const row of basket) raw += (row.end?.c ?? 0n) - (row.start?.c ?? 0n);
        expect(d.totalChangeKobo).toBe(raw);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('decompose — property: classification is a clean partition', () => {
  it('buckets are disjoint; excluded wins; every active non-excluded commodity lands in exactly one bucket', () => {
    fc.assert(
      fc.property(basketArb, (basket) => {
        const d = decompose(toInput(basket));
        const { intersectionCommodityIds, newCommodityIds, stoppedCommodityIds, excludedCommodityIds } =
          d.classification;
        const buckets = [
          intersectionCommodityIds,
          newCommodityIds,
          stoppedCommodityIds,
          excludedCommodityIds,
        ];

        // Pairwise disjoint.
        const seen = new Set<string>();
        for (const b of buckets) {
          for (const id of b) {
            expect(seen.has(id)).toBe(false);
            seen.add(id);
          }
        }

        for (const row of basket) {
          const sq = row.start?.q ?? 0n;
          const eq = row.end?.q ?? 0n;
          if (row.excluded) {
            expect(excludedCommodityIds).toContain(row.id);
          } else if (sq > 0n && eq > 0n) {
            expect(intersectionCommodityIds).toContain(row.id);
          } else if (eq > 0n) {
            expect(newCommodityIds).toContain(row.id);
          } else if (sq > 0n) {
            expect(stoppedCommodityIds).toContain(row.id);
          } else {
            // both quantities zero and not excluded → belongs to no bucket
            expect(seen.has(row.id)).toBe(false);
          }
        }
      }),
      { numRuns: 2000 },
    );
  });
});

describe('decompose — property: per-commodity rounding drift is bounded and immaterial', () => {
  it('Σ rounded PRICE differs from the once-rounded exact aggregate by ≤ (n+1)/2 kobo', () => {
    fc.assert(
      fc.property(basketArb, (basket) => {
        const d = decompose(toInput(basket));

        // Exact aggregate PRICE over the intersection, as one rational, rounded once.
        let num = 0n;
        let den = 1n;
        const input = toInput(basket);
        const startMap = new Map<string, CommodityPeriod>(
          input.periodStart.map((r) => [r.commodityId, r] as const),
        );
        const endMap = new Map<string, CommodityPeriod>(
          input.periodEnd.map((r) => [r.commodityId, r] as const),
        );
        for (const id of d.classification.intersectionCommodityIds) {
          const s = startMap.get(id)!;
          const e = endMap.get(id)!;
          const termNum = (e.costKobo * s.qtyBaseUnit - s.costKobo * e.qtyBaseUnit) * (s.qtyBaseUnit + e.qtyBaseUnit);
          const termDen = 2n * s.qtyBaseUnit * e.qtyBaseUnit;
          [num, den] = addRational(num, den, termNum, termDen);
        }
        const exactAggregateRounded = roundHalfEvenRational(num, den);

        const n = BigInt(d.intersection.length);
        expect(2n * abs(d.priceKobo - exactAggregateRounded) <= n + 1n).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('decompose — property: order independence', () => {
  it('shuffling the input rows does not change the result', () => {
    fc.assert(
      fc.property(basketArb, fc.integer({ min: 0, max: 2 ** 31 }), (basket, seed) => {
        const base = decompose(toInput(basket));
        const shuffledBasket = [...basket];
        // Deterministic Fisher–Yates from the seed.
        let s = seed || 1;
        const rand = () => {
          s = (s * 1103515245 + 12345) & 0x7fffffff;
          return s / 0x7fffffff;
        };
        for (let i = shuffledBasket.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [shuffledBasket[i], shuffledBasket[j]] = [shuffledBasket[j]!, shuffledBasket[i]!];
        }
        expect(decompose(toInput(shuffledBasket))).toEqual(base);
      }),
      { numRuns: 500 },
    );
  });
});
