import { describe, it, expect } from 'vitest';
import { decompose } from '@/src/engine/decomposition';
import { detectSubstitutions, type SubstituteGroup } from '@/src/engine/substitution';
import type { DecompositionInput } from '@/src/engine/types';

const groups: SubstituteGroup[] = [
  { groupId: 'tomato_base', commodityIds: ['fresh_tomato', 'tomato_paste', 'tinned_tomato'] },
  { groupId: 'protein_swap', commodityIds: ['fresh_fish', 'frozen_chicken', 'beef'] },
];

const input = (partial: Partial<DecompositionInput>): DecompositionInput => ({
  periodStart: [],
  periodEnd: [],
  currency: 'NGN',
  ...partial,
});

describe('detectSubstitutions — narrative only, never a fifth component (Handover §7.2)', () => {
  it('golden case: tomato → paste renders as ONE switch, not a quantity-drop plus a new item', () => {
    const d = decompose(
      input({
        periodStart: [{ commodityId: 'fresh_tomato', costKobo: 300_000n, qtyBaseUnit: 5000n }],
        periodEnd: [{ commodityId: 'tomato_paste', costKobo: 250_000n, qtyBaseUnit: 400n }],
      }),
    );

    // Engine side: tomato stopped, paste new, no intersection, no fifth figure.
    expect(d.classification.stoppedCommodityIds).toEqual(['fresh_tomato']);
    expect(d.classification.newCommodityIds).toEqual(['tomato_paste']);
    expect(d.intersection).toEqual([]);

    // Narrative side: exactly one sentence.
    const narratives = detectSubstitutions(d.classification, groups);
    expect(narratives).toEqual([
      { groupId: 'tomato_base', fromCommodityId: 'fresh_tomato', toCommodityId: 'tomato_paste' },
    ]);
  });

  it('does not invent a switch across unrelated commodities', () => {
    const d = decompose(
      input({
        periodStart: [{ commodityId: 'fresh_tomato', costKobo: 300_000n, qtyBaseUnit: 5000n }],
        periodEnd: [{ commodityId: 'rice', costKobo: 500_000n, qtyBaseUnit: 10_000n }],
      }),
    );
    expect(detectSubstitutions(d.classification, groups)).toEqual([]);
  });

  it('pairs deterministically when a group has several stopped and several new', () => {
    const d = decompose(
      input({
        periodStart: [
          { commodityId: 'fresh_fish', costKobo: 400_000n, qtyBaseUnit: 2000n },
          { commodityId: 'beef', costKobo: 500_000n, qtyBaseUnit: 1500n },
        ],
        periodEnd: [{ commodityId: 'frozen_chicken', costKobo: 300_000n, qtyBaseUnit: 2500n }],
      }),
    );
    // Two stopped, one new in the group → one pair, lexicographically first stopped id.
    expect(detectSubstitutions(d.classification, groups)).toEqual([
      { groupId: 'protein_swap', fromCommodityId: 'beef', toCommodityId: 'frozen_chicken' },
    ]);
    // 'fresh_fish' stays an ordinary stopped line.
    expect(d.classification.stoppedCommodityIds).toContain('fresh_fish');
  });
});
