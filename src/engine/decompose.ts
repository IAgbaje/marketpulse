/**
 * Bennet-indicator variance decomposition.
 *
 * Spec: Technical Requirements §3.1 (representation), §3.2 (exclusions),
 * §3.3 (classification). Handover §7.1 (the identity).
 *
 * The invariant, which must hold exactly in whole kobo for every input:
 *
 *   price + whatYouBought + newItems - stoppedBuying + excludedDelta === totalDelta
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import type { Basket, CommodityPeriodTotals, Decomposition, Kobo } from "./types.js";

/**
 * Round an exact rational num/den to the nearest integer, ties to even.
 *
 * Ties-to-even is applied to the magnitude and mirrored across zero, so the
 * result is symmetric: round(-x) === -round(x). Rounding on magnitude keeps
 * the 0.5-kobo error bound in §3.1 valid for negative deltas, which are the
 * common case when prices fall.
 */
export function roundHalfEven(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new Error("roundHalfEven: zero denominator");

  let n = num;
  let d = den;
  if (d < 0n) {
    n = -n;
    d = -d;
  }

  const negative = n < 0n;
  const abs = negative ? -n : n;

  let q = abs / d;
  const r = abs - q * d;
  const twice = 2n * r;

  if (twice > d) {
    q += 1n;
  } else if (twice === d && q % 2n !== 0n) {
    q += 1n;
  }

  return negative ? -q : q;
}

function indexByCommodity(
  basket: Basket,
): ReadonlyMap<string, CommodityPeriodTotals> {
  const map = new Map<string, CommodityPeriodTotals>();
  for (const c of basket.commodities) map.set(c.commodityId, c);
  return map;
}

function assertQuantitiesValid(basket: Basket, label: string): void {
  for (const c of basket.commodities) {
    if (c.qty < 0n) {
      // A negative quantity is data corruption, not a refund: you cannot buy
      // negative grams. Fail loudly rather than let it reclassify silently to
      // a reconciliation line, where it would look like a legitimate figure.
      throw new Error(
        `decompose: negative quantity for commodity ${c.commodityId} in ${label} basket`,
      );
    }
  }
}

export function decompose(prior: Basket, current: Basket): Decomposition {
  if (prior.currency !== current.currency) {
    throw new Error(
      `decompose: currency mismatch (${prior.currency} vs ${current.currency}) — ` +
        "a decomposition must never span mixed currencies",
    );
  }

  assertQuantitiesValid(prior, "prior");
  assertQuantitiesValid(current, "current");

  const priorById = indexByCommodity(prior);
  const currentById = indexByCommodity(current);
  const allIds = new Set([...priorById.keys(), ...currentById.keys()]);

  let price: Kobo = 0n;
  let whatYouBought: Kobo = 0n;
  let newItems: Kobo = 0n;
  let stoppedBuying: Kobo = 0n;
  let intersectionPriorCost: Kobo = 0n;
  let newItemCount = 0;
  let stoppedBuyingCount = 0;

  for (const id of allIds) {
    const p = priorById.get(id);
    const c = currentById.get(id);

    // A commodity belongs to the intersection only when quantity is strictly
    // positive in BOTH periods — that is exactly the condition under which
    // both unit prices are defined, so the division below can never be by
    // zero. Anything else routes to the new/stopped reconciliation lines.
    // This is a classification rule, not an arithmetic one (§3.3): the sum
    // ties either way, but the narrative is only correct with this guard.
    if (p !== undefined && c !== undefined && p.qty > 0n && c.qty > 0n) {
      const c0 = p.cost;
      const c1 = c.cost;
      const q0 = p.qty;
      const q1 = c.qty;

      // PRICE as an exact rational — unit prices are never materialised.
      //   (P1 - P0) * (q0 + q1) / 2, with P0 = c0/q0 and P1 = c1/q1
      // = (c1*q0 - c0*q1) * (q0 + q1) / (2 * q0 * q1)
      const num = (c1 * q0 - c0 * q1) * (q0 + q1);
      const den = 2n * q0 * q1;
      const rounded = roundHalfEven(num, den);

      // Derive by subtraction from the exact integer cost delta, so the pair
      // ties by construction with exactly one rounding operation (§3.1).
      price += rounded;
      whatYouBought += c1 - c0 - rounded;

      intersectionPriorCost += c0;
      continue;
    }

    const priorCost = p?.cost ?? 0n;
    const currentCost = c?.cost ?? 0n;

    newItems += currentCost;
    stoppedBuying += priorCost;
    if (currentCost !== 0n) newItemCount += 1;
    if (priorCost !== 0n) stoppedBuyingCount += 1;
  }

  const excludedDelta = current.excludedCost - prior.excludedCost;

  let priorTotal: Kobo = prior.excludedCost;
  for (const c of prior.commodities) priorTotal += c.cost;
  let currentTotal: Kobo = current.excludedCost;
  for (const c of current.commodities) currentTotal += c.cost;

  const totalDelta = currentTotal - priorTotal;

  // Coverage is a share of prior-period spend by value. With no prior spend
  // there is nothing to cover; report 0 so the <70% disclosure banner shows,
  // which is the honest default rather than an unearned 100%.
  let priorSpend: Kobo = prior.excludedCost;
  for (const c of prior.commodities) priorSpend += c.cost;
  const coveragePercent =
    priorSpend === 0n
      ? 0
      : Number((intersectionPriorCost * 100n) / priorSpend);

  return {
    price,
    whatYouBought,
    newItems,
    stoppedBuying,
    excludedDelta,
    totalDelta,
    newItemCount,
    stoppedBuyingCount,
    coveragePercent,
  };
}

/**
 * The invariant, as a callable predicate. Exported so callers (and the
 * property suite) assert the same expression the spec states.
 */
export function tiesExactly(d: Decomposition): boolean {
  return (
    d.price + d.whatYouBought + d.newItems - d.stoppedBuying + d.excludedDelta ===
    d.totalDelta
  );
}
