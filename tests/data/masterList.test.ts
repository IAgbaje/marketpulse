import { describe, it, expect } from 'vitest';
import commoditiesDoc from '@/data/commodities.json';
import groupsDoc from '@/data/substitute-groups.json';
import conversionsDoc from '@/data/unit-conversions.json';

/**
 * Blocking item 4 (Technical Requirements §8.1). These assertions make the
 * commodity master list SELF-CHECKING, so an owner maintaining it gets an
 * immediate red build on a structural mistake rather than discovering it as a
 * degraded aggregate weeks later.
 */

const commodities = commoditiesDoc.commodities;
const groups = groupsDoc.groups;
const conversions = conversionsDoc.conversions;

const commodityIds = new Set(commodities.map((c) => c.id));
const groupIds = new Set(groups.map((g) => g.groupId));
const baseUnits = new Set(commoditiesDoc.baseUnits);
const categories = new Set(commoditiesDoc.categories);
const purchaseForms = new Set(commoditiesDoc.purchaseForms);

describe('commodities.json', () => {
  it('has a workable MVP-sized master list (~60 items)', () => {
    expect(commodities.length).toBeGreaterThanOrEqual(55);
    expect(commodities.length).toBeLessThanOrEqual(80);
  });

  it('every id is unique', () => {
    expect(commodityIds.size).toBe(commodities.length);
  });

  it('every commodity uses a declared category, baseUnit and purchaseForms', () => {
    for (const c of commodities) {
      expect(categories.has(c.category), `${c.id} category`).toBe(true);
      expect(baseUnits.has(c.baseUnit), `${c.id} baseUnit`).toBe(true);
      expect(c.purchaseForms.length, `${c.id} purchaseForms`).toBeGreaterThan(0);
      for (const f of c.purchaseForms) expect(purchaseForms.has(f), `${c.id} form ${f}`).toBe(true);
    }
  });

  it('every substituteGroup reference resolves to a real group', () => {
    for (const c of commodities) {
      if ('substituteGroup' in c && c.substituteGroup) {
        expect(groupIds.has(c.substituteGroup), `${c.id} → ${c.substituteGroup}`).toBe(true);
      }
    }
  });

  it('the high-salience perishables carry NO NBS HFCP mapping (TR §11.4)', () => {
    const mustBeUnmapped = [
      'tomato_fresh', 'pepper_rodo', 'onion', 'palm_oil', 'chicken_frozen',
      'fish_fresh_tilapia', 'fish_fresh_catfish',
    ];
    for (const id of mustBeUnmapped) {
      const c = commodities.find((x) => x.id === id);
      expect(c, id).toBeDefined();
      expect(c!.nbsHfcpMapped, id).toBe(false);
    }
  });

  it('has enough alias coverage to resist the "request a commodity" dead end', () => {
    for (const c of commodities) {
      expect(Array.isArray(c.aliases), `${c.id} aliases`).toBe(true);
      expect(c.aliases.length, `${c.id} aliases`).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('substitute-groups.json', () => {
  it('every group has a unique id and at least two members', () => {
    expect(groupIds.size).toBe(groups.length);
    for (const g of groups) expect(g.commodityIds.length, g.groupId).toBeGreaterThanOrEqual(2);
  });

  it('15–20 groups (TR §8.1)', () => {
    expect(groups.length).toBeGreaterThanOrEqual(15);
    expect(groups.length).toBeLessThanOrEqual(20);
  });

  it('groups are DISJOINT — a commodity is in at most one group (unambiguous pairing)', () => {
    const seen = new Map<string, string>();
    for (const g of groups) {
      for (const id of g.commodityIds) {
        expect(seen.has(id), `${id} in both ${seen.get(id)} and ${g.groupId}`).toBe(false);
        seen.set(id, g.groupId);
      }
    }
  });

  it('every member id exists in commodities.json and back-references the group', () => {
    for (const g of groups) {
      for (const id of g.commodityIds) {
        expect(commodityIds.has(id), `${g.groupId} → ${id}`).toBe(true);
        const c = commodities.find((x) => x.id === id)!;
        expect((c as { substituteGroup?: string }).substituteGroup, id).toBe(g.groupId);
      }
    }
  });
});

describe('unit-conversions.json', () => {
  it('covers at least the top 15 informal measures (TR §8.1)', () => {
    expect(conversions.length).toBeGreaterThanOrEqual(15);
  });

  it('every conversion is an exact positive rational into a real base unit', () => {
    for (const conv of conversions) {
      expect(Number.isInteger(conv.factorNum) && conv.factorNum > 0, conv.id).toBe(true);
      expect(Number.isInteger(conv.factorDen) && conv.factorDen > 0, conv.id).toBe(true);
      expect(['g', 'ml', 'piece'].includes(conv.toBaseUnit), conv.id).toBe(true);
      expect(['high', 'medium', 'low'].includes(conv.confidence), conv.id).toBe(true);
    }
  });

  it('a commodity-scoped conversion names a real commodity and matches its base unit', () => {
    for (const conv of conversions) {
      if (conv.scope === '*') continue;
      expect(commodityIds.has(conv.scope), conv.id).toBe(true);
      const c = commodities.find((x) => x.id === conv.scope)!;
      expect(conv.toBaseUnit, `${conv.id} base unit vs ${c.id}`).toBe(c.baseUnit);
    }
  });

  it('(fromUnit, scope, toBaseUnit) triples are unique', () => {
    const seen = new Set<string>();
    for (const conv of conversions) {
      const key = `${conv.fromUnit}::${conv.scope}::${conv.toBaseUnit}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it('gradeSensitive conversions are never high-confidence (they need grading first, TR §11.2)', () => {
    for (const conv of conversions) {
      if ((conv as { gradeSensitive?: boolean }).gradeSensitive) {
        expect(conv.confidence, conv.id).not.toBe('high');
      }
    }
  });
});
