/**
 * Variance decomposition — the product's differentiator and its riskiest
 * component (Technical Requirements §3). One pure module, client-side, no I/O,
 * following the `monie-lens/lib/engine/` pattern — explicitly NOT that repo's
 * float / `toFixed` money handling.
 *
 * The identity that must hold exactly, in kobo, every time:
 *
 *   PRICE + WHAT_YOU_BOUGHT + NEW_ITEMS − STOPPED_BUYING + EXCLUDED_DELTA = Δtotal
 *
 * Bennet indicator for the intersection basket:
 *
 *   PRICE           = Σ (P₁−P₀)·(Q₀+Q₁)/2
 *   WHAT_YOU_BOUGHT  = Σ (Q₁−Q₀)·(P₀+P₁)/2      where Pᵢ = cᵢ/qᵢ, Qᵢ = qᵢ
 *
 * Representation rule (TR §3.1 — the fix for blocking item 1):
 *   1. Aggregate the period's lines to integer totals c₀,c₁ (kobo), q₀,q₁ (base
 *      units). Intersection membership requires q₀ > 0 AND q₁ > 0.
 *   2. Compute PRICE as an exact BigInt rational:
 *        numerator   = (c₁·q₀ − c₀·q₁)·(q₀+q₁)
 *        denominator = 2·q₀·q₁
 *      Never materialise P as a scalar.
 *   3. Round PRICE only, once, ROUND_HALF_EVEN → p̂.
 *   4. Derive WHAT_YOU_BOUGHT := (c₁ − c₀) − p̂. By subtraction from an exact
 *      integer, never by evaluating its own formula.
 *
 * This guarantees PRICE + WHAT_YOU_BOUGHT = c₁ − c₀ exactly, per commodity, by
 * construction — one rounding operation total, absorbed into WHAT_YOU_BOUGHT at
 * ≤ 0.5 kobo. The basket tie then follows by summing exact integers.
 *
 * TR §7.6's remainder-assignment rule ("assign the accumulated remainder to
 * whichever of PRICE / WHAT_YOU_BOUGHT is larger") is SUPERSEDED and is not
 * implemented here — it is unnecessary under the rule above and non-deterministic
 * on an exact-magnitude tie.
 */

import { roundHalfEvenRational } from './rational';
import type {
  CommodityDecomposition,
  CommodityPeriod,
  Decomposition,
  DecompositionClassification,
  DecompositionInput,
} from './types';

interface Position {
  c: bigint;
  q: bigint;
}

const ZERO: Position = { c: 0n, q: 0n };

function indexPeriod(rows: readonly CommodityPeriod[], label: string): Map<string, Position> {
  const map = new Map<string, Position>();
  for (const row of rows) {
    if (map.has(row.commodityId)) {
      throw new Error(
        `decompose: duplicate commodityId "${row.commodityId}" in ${label}; aggregate to one row per commodity before calling`,
      );
    }
    if (row.costKobo < 0n) {
      throw new RangeError(
        `decompose: negative costKobo for "${row.commodityId}" in ${label} — data corruption, not a refund`,
      );
    }
    if (row.qtyBaseUnit < 0n) {
      throw new RangeError(
        `decompose: negative qtyBaseUnit for "${row.commodityId}" in ${label} — data corruption, not a refund`,
      );
    }
    if (row.qtyBaseUnit === 0n && row.costKobo !== 0n) {
      throw new RangeError(
        `decompose: "${row.commodityId}" in ${label} has zero quantity but non-zero cost — inconsistent aggregate`,
      );
    }
    map.set(row.commodityId, { c: row.costKobo, q: row.qtyBaseUnit });
  }
  return map;
}

/**
 * Decompose the change in total spend between two aggregated periods into the
 * exact ledger described above. Pure and total: given valid integer inputs it
 * always returns a `Decomposition` whose identity holds with zero tolerance.
 *
 * Commodity ids are processed in sorted order so the output is deterministic.
 */
export function decompose(input: DecompositionInput): Decomposition {
  if (typeof input.currency !== 'string' || input.currency.length === 0) {
    throw new Error('decompose: currency is a mandatory non-empty sibling of every amount');
  }

  const start = indexPeriod(input.periodStart, 'periodStart');
  const end = indexPeriod(input.periodEnd, 'periodEnd');

  const excluded = new Set(input.excludedCommodityIds ?? []);
  for (const id of excluded) {
    if (!start.has(id) && !end.has(id)) {
      throw new Error(`decompose: excluded commodityId "${id}" is not present in either period`);
    }
  }

  const allIds = [...new Set([...start.keys(), ...end.keys()])].sort();

  let totalChangeKobo = 0n;
  let priceKobo = 0n;
  let whatYouBoughtKobo = 0n;
  let newItemsKobo = 0n;
  let stoppedBuyingKobo = 0n;
  let excludedDeltaKobo = 0n;

  const intersection: CommodityDecomposition[] = [];
  const classification: DecompositionClassification = {
    intersectionCommodityIds: [],
    newCommodityIds: [],
    stoppedCommodityIds: [],
    excludedCommodityIds: [...excluded].sort(),
  };

  for (const id of allIds) {
    const s = start.get(id) ?? ZERO;
    const e = end.get(id) ?? ZERO;
    const deltaKobo = e.c - s.c;
    totalChangeKobo += deltaKobo;

    if (excluded.has(id)) {
      excludedDeltaKobo += deltaKobo;
      continue;
    }

    if (s.q > 0n && e.q > 0n) {
      // Intersection basket — Bennet PRICE via an exact rational, WHAT_YOU_BOUGHT
      // by subtraction. Denominator is strictly positive here (both q > 0).
      const numerator = (e.c * s.q - s.c * e.q) * (s.q + e.q);
      const denominator = 2n * s.q * e.q;
      const pHat = roundHalfEvenRational(numerator, denominator);
      const wyb = deltaKobo - pHat;

      priceKobo += pHat;
      whatYouBoughtKobo += wyb;
      intersection.push({
        commodityId: id,
        priceKobo: pHat,
        whatYouBoughtKobo: wyb,
        totalChangeKobo: deltaKobo,
      });
      classification.intersectionCommodityIds.push(id);
    } else if (e.q > 0n) {
      // New this period (q0 === 0). Also the destination for a commodity whose
      // quantity nets to zero in the prior period — never the intersection
      // (TR §3.3 zero-prior-quantity classification).
      newItemsKobo += e.c;
      classification.newCommodityIds.push(id);
    } else if (s.q > 0n) {
      // Stopped this period (q1 === 0). Positive magnitude; subtracted in the identity.
      stoppedBuyingKobo += s.c;
      classification.stoppedCommodityIds.push(id);
    }
    // else q0 === q1 === 0 → cost is 0 on both sides by the indexPeriod guard →
    // contributes nothing and belongs to no bucket.
  }

  return {
    currency: input.currency,
    totalChangeKobo,
    priceKobo,
    whatYouBoughtKobo,
    newItemsKobo,
    stoppedBuyingKobo,
    excludedDeltaKobo,
    intersection,
    classification,
  };
}

/**
 * Runtime re-check of the exact-tie identity. Cheap; wire it into dev builds and
 * CI as defence in depth. A failure here is a P0 — the ledger is the product.
 */
export function assertTies(d: Decomposition): void {
  const lhs =
    d.priceKobo + d.whatYouBoughtKobo + d.newItemsKobo - d.stoppedBuyingKobo + d.excludedDeltaKobo;
  if (lhs !== d.totalChangeKobo) {
    throw new Error(
      `decomposition identity broken: ${lhs} !== ${d.totalChangeKobo} ` +
        `(price=${d.priceKobo} whatYouBought=${d.whatYouBoughtKobo} new=${d.newItemsKobo} ` +
        `stopped=${d.stoppedBuyingKobo} excluded=${d.excludedDeltaKobo})`,
    );
  }
  for (const line of d.intersection) {
    if (line.priceKobo + line.whatYouBoughtKobo !== line.totalChangeKobo) {
      throw new Error(
        `per-commodity tie broken for "${line.commodityId}": ` +
          `${line.priceKobo} + ${line.whatYouBoughtKobo} !== ${line.totalChangeKobo}`,
      );
    }
  }
}
