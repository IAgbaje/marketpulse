import { describe, it, expect } from 'vitest';
import { decompose, assertTies } from '@/src/engine/decomposition';
import { selectTier, projectToPriceEffect, toDisplayModel } from '@/src/engine/tiers';
import type { CommodityPeriod, DecompositionInput } from '@/src/engine/types';

const line = (commodityId: string, naira: number, qty: number): CommodityPeriod => ({
  commodityId,
  costKobo: BigInt(Math.round(naira * 100)),
  qtyBaseUnit: BigInt(qty),
});

const input = (partial: Partial<DecompositionInput>): DecompositionInput => ({
  periodStart: [],
  periodEnd: [],
  currency: 'NGN',
  ...partial,
});

describe('decompose — the exact-tie identity', () => {
  it('ties for a plain intersection basket (price up, quantity up)', () => {
    const d = decompose(
      input({
        periodStart: [line('rice', 3000, 10_000), line('garri', 1000, 8000)],
        periodEnd: [line('rice', 3300, 12_000), line('garri', 1100, 8000)],
      }),
    );
    expect(() => assertTies(d)).not.toThrow();
    expect(
      d.priceKobo + d.whatYouBoughtKobo + d.newItemsKobo - d.stoppedBuyingKobo + d.excludedDeltaKobo,
    ).toBe(d.totalChangeKobo);
    expect(d.classification.intersectionCommodityIds).toEqual(['garri', 'rice']);
  });

  it('quantity-only change lands entirely in WHAT_YOU_BOUGHT, price change entirely in PRICE', () => {
    const priceOnly = decompose(
      input({
        periodStart: [line('rice', 3000, 10_000)],
        periodEnd: [line('rice', 3600, 10_000)],
      }),
    );
    expect(priceOnly.priceKobo).toBe(60_000n); // ₦600
    expect(priceOnly.whatYouBoughtKobo).toBe(0n);

    const qtyOnly = decompose(
      input({
        periodStart: [line('rice', 3000, 10_000)],
        periodEnd: [line('rice', 4500, 15_000)], // same ₦0.30/g, 50% more
      }),
    );
    expect(qtyOnly.priceKobo).toBe(0n);
    expect(qtyOnly.whatYouBoughtKobo).toBe(150_000n); // ₦1,500
  });
});

describe('decompose — TR §3.1 rational unit prices (blocking item 1)', () => {
  it('does not lose sub-kobo-per-gram error: ₦1,500 / 700 g vs ₦1,800 / 700 g', () => {
    // Scalar rounding of P (214.28…→214, 257.14…→257) would misstate PRICE by ~₦2.
    const d = decompose(
      input({
        periodStart: [line('tomato', 1500, 700)],
        periodEnd: [line('tomato', 1800, 700)],
      }),
    );
    // Quantity identical → the entire ₦300 change is price, exactly.
    expect(d.priceKobo).toBe(30_000n);
    expect(d.whatYouBoughtKobo).toBe(0n);
    expect(d.totalChangeKobo).toBe(30_000n);
  });

  it('odd quantities on both sides still tie to the exact integer delta', () => {
    const d = decompose(
      input({
        periodStart: [line('pepper', 1234.56, 333), line('onion', 999.99, 777)],
        periodEnd: [line('pepper', 1500.01, 411), line('onion', 850.5, 690)],
      }),
    );
    expect(() => assertTies(d)).not.toThrow();
    for (const c of d.intersection) {
      expect(c.priceKobo + c.whatYouBoughtKobo).toBe(c.totalChangeKobo);
    }
  });

  it('holds at basket sizes that overflow 64-bit signed (BigInt is load-bearing)', () => {
    // c ~ ₦5,000,000 (5e8 kobo), q ~ 500,000 base units → numerator ~ c·q² ~ 1e20 > 2^63.
    const d = decompose(
      input({
        periodStart: [{ commodityId: 'bulk', costKobo: 500_000_000n, qtyBaseUnit: 500_000n }],
        periodEnd: [{ commodityId: 'bulk', costKobo: 540_000_000n, qtyBaseUnit: 480_000n }],
      }),
    );
    expect(() => assertTies(d)).not.toThrow();
    expect(d.priceKobo + d.whatYouBoughtKobo).toBe(d.totalChangeKobo);
    expect(d.totalChangeKobo).toBe(40_000_000n);
  });
});

describe('decompose — classification (TR §3.3)', () => {
  it('all-new: period 0 empty', () => {
    const d = decompose(
      input({ periodEnd: [line('rice', 3000, 10_000), line('beans', 1500, 3000)] }),
    );
    expect(d.classification.newCommodityIds).toEqual(['beans', 'rice']);
    expect(d.classification.intersectionCommodityIds).toEqual([]);
    expect(d.priceKobo).toBe(0n);
    expect(d.whatYouBoughtKobo).toBe(0n);
    expect(d.newItemsKobo).toBe(450_000n);
    expect(d.totalChangeKobo).toBe(450_000n);
    expect(() => assertTies(d)).not.toThrow();
  });

  it('all-dropped: period 1 empty', () => {
    const d = decompose(
      input({ periodStart: [line('rice', 3000, 10_000), line('beans', 1500, 3000)] }),
    );
    expect(d.classification.stoppedCommodityIds).toEqual(['beans', 'rice']);
    expect(d.stoppedBuyingKobo).toBe(450_000n);
    expect(d.totalChangeKobo).toBe(-450_000n);
    expect(() => assertTies(d)).not.toThrow();
  });

  it('empty intersection: disjoint commodity sets', () => {
    const d = decompose(
      input({
        periodStart: [line('rice', 3000, 10_000)],
        periodEnd: [line('beans', 1500, 3000)],
      }),
    );
    expect(d.classification.intersectionCommodityIds).toEqual([]);
    expect(d.classification.stoppedCommodityIds).toEqual(['rice']);
    expect(d.classification.newCommodityIds).toEqual(['beans']);
    expect(() => assertTies(d)).not.toThrow();
  });

  it('zero-prior-quantity routes to NEW, never the intersection — whether the row is absent or present-as-zero', () => {
    const absent = decompose(
      input({
        periodStart: [line('rice', 3000, 10_000)],
        periodEnd: [line('rice', 3000, 10_000), line('beans', 1500, 3000)],
      }),
    );
    expect(absent.classification.newCommodityIds).toEqual(['beans']);

    const zeroRow = decompose(
      input({
        periodStart: [line('rice', 3000, 10_000), { commodityId: 'beans', costKobo: 0n, qtyBaseUnit: 0n }],
        periodEnd: [line('rice', 3000, 10_000), line('beans', 1500, 3000)],
      }),
    );
    expect(zeroRow.classification.newCommodityIds).toEqual(['beans']);
    expect(zeroRow.classification.intersectionCommodityIds).toEqual(['rice']);
  });

  it('a commodity whose quantity nets to zero this period routes to STOPPED', () => {
    const d = decompose(
      input({
        periodStart: [line('rice', 3000, 10_000), line('beans', 1500, 3000)],
        periodEnd: [line('rice', 3000, 10_000), { commodityId: 'beans', costKobo: 0n, qtyBaseUnit: 0n }],
      }),
    );
    expect(d.classification.stoppedCommodityIds).toEqual(['beans']);
    expect(d.stoppedBuyingKobo).toBe(150_000n);
    expect(() => assertTies(d)).not.toThrow();
  });
});

describe('decompose — excluded outlier lines (TR §3.2, US-3.3)', () => {
  it('excluded lines become a fifth reconciliation line; the ledger still ties to the TRUE delta', () => {
    const d = decompose(
      input({
        periodStart: [line('rice', 5000, 10_000), line('palm_oil', 2000, 5000), line('garri', 1000, 8000)],
        periodEnd: [line('rice', 5200, 10_000), line('palm_oil', 9000, 5000), line('garri', 1100, 8000)],
        excludedCommodityIds: ['palm_oil'],
      }),
    );
    // True month-over-month delta includes the ₦7,000 palm-oil spike the user really paid.
    expect(d.totalChangeKobo).toBe(730_000n);
    expect(d.excludedDeltaKobo).toBe(700_000n);
    expect(d.classification.excludedCommodityIds).toEqual(['palm_oil']);
    expect(d.classification.intersectionCommodityIds).toEqual(['garri', 'rice']);
    expect(() => assertTies(d)).not.toThrow();
  });

  it('rejects an excluded id that is in neither period', () => {
    expect(() =>
      decompose(input({ periodStart: [line('rice', 3000, 10_000)], excludedCommodityIds: ['ghost'] })),
    ).toThrow(/not present in either period/);
  });
});

describe('decompose — input guards (money safety, TR §7)', () => {
  it('rejects negative cost or quantity as corruption, not a refund', () => {
    expect(() =>
      decompose(input({ periodEnd: [{ commodityId: 'x', costKobo: -1n, qtyBaseUnit: 1n }] })),
    ).toThrow(RangeError);
    expect(() =>
      decompose(input({ periodEnd: [{ commodityId: 'x', costKobo: 1n, qtyBaseUnit: -1n }] })),
    ).toThrow(RangeError);
  });

  it('rejects zero quantity paired with non-zero cost', () => {
    expect(() =>
      decompose(input({ periodEnd: [{ commodityId: 'x', costKobo: 100n, qtyBaseUnit: 0n }] })),
    ).toThrow(/zero quantity but non-zero cost/);
  });

  it('rejects a duplicate commodity row within a period', () => {
    expect(() =>
      decompose(input({ periodStart: [line('rice', 1, 1), line('rice', 2, 2)] })),
    ).toThrow(/duplicate commodityId/);
  });

  it('rejects a missing or empty currency', () => {
    expect(() => decompose(input({ currency: '' }))).toThrow(/currency/);
  });

  it('is deterministic and order-independent', () => {
    const a = decompose(
      input({
        periodStart: [line('rice', 3000, 10_000), line('garri', 1000, 8000)],
        periodEnd: [line('garri', 1100, 8000), line('rice', 3300, 12_000)],
      }),
    );
    const b = decompose(
      input({
        periodStart: [line('garri', 1000, 8000), line('rice', 3000, 10_000)],
        periodEnd: [line('rice', 3300, 12_000), line('garri', 1100, 8000)],
      }),
    );
    expect(a).toEqual(b);
    expect(a.intersection.map((c) => c.commodityId)).toEqual(['garri', 'rice']); // sorted
  });
});

describe('tier selection & display projection (stage 5a / 5b)', () => {
  it('gates on complete calendar months, then on the 5b flag', () => {
    expect(selectTier({ completeMonths: 0, fullSplitEnabled: true })).toBe('none');
    expect(selectTier({ completeMonths: 1, fullSplitEnabled: true })).toBe('none');
    expect(selectTier({ completeMonths: 2, fullSplitEnabled: false })).toBe('price_effect_only');
    expect(selectTier({ completeMonths: 2, fullSplitEnabled: true })).toBe('full');
    expect(selectTier({ completeMonths: 9, fullSplitEnabled: true })).toBe('full');
  });

  it('price-effect tier exposes exactly one figure plus the total', () => {
    const d = decompose(
      input({
        periodStart: [line('rice', 3000, 10_000)],
        periodEnd: [line('rice', 3600, 12_000)],
      }),
    );
    const tier = projectToPriceEffect(d);
    expect(Object.keys(tier).sort()).toEqual(['currency', 'priceKobo', 'totalChangeKobo']);
    expect(tier.priceKobo).toBe(d.priceKobo);
  });

  it('full display model regroups the same tie: hero + reconciliation === total change', () => {
    const d = decompose(
      input({
        periodStart: [line('rice', 5000, 10_000), line('palm_oil', 2000, 5000), line('milk', 1200, 400)],
        periodEnd: [line('rice', 5200, 10_000), line('palm_oil', 9000, 5000), line('eggs', 2500, 30)],
        excludedCommodityIds: ['palm_oil'],
      }),
    );
    const m = toDisplayModel(d);
    expect(
      m.hero.priceKobo +
        m.hero.whatYouBoughtKobo +
        m.reconciliation.basketChangeKobo +
        m.reconciliation.excludedDeltaKobo,
    ).toBe(m.totalChangeKobo);
    expect(m.reconciliation.basketChangeKobo).toBe(d.newItemsKobo - d.stoppedBuyingKobo);
    expect(m.detail.excludedCount).toBe(1);
  });
});
