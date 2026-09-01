/**
 * Cross-market comparison (§4 stage 8, V1: Price Comparison / Basket
 * Comparison). Built entirely on `price_aggregates` (crowd bands) — never
 * raw purchase_lines at scale, same rule as everywhere else that reads
 * crowd data (§7). Pure/testable; the network fetch stays in crowdBand.ts.
 *
 * Money note: a basket total here is a SUM OF MEDIANS across commodities,
 * not an observed basket cost. That's a real, disclosed estimate — the UI
 * must say "estimate" and disclose how many items a market couldn't price
 * (no band there yet), never present it as if it were an actual receipt.
 */

import type { CrowdBandRow } from "./crowdBand.js";

/** Published (non-below-floor) bands for one specific month, across markets. */
export function bandsForMonth(bands: readonly CrowdBandRow[], month: string): CrowdBandRow[] {
  return bands.filter((b) => b.periodMonth === month && b.medianKobo !== null);
}

export interface MarketBasketTotal {
  marketId: string;
  /** Sum of median prices for every commodity this market has a band for. */
  totalKobo: bigint;
  itemsPriced: number;
  itemsMissing: number;
}

/**
 * One market total per market that has a band for AT LEAST ONE basket item —
 * a market with zero overlap isn't listed at all (there's nothing to show,
 * not a zero total, which would misleadingly look like "free"). Sorted
 * cheapest first; ties broken by fewest missing items (a more complete,
 * comparable total ranks above a cheaper-but-thinner one).
 */
export function computeBasketTotals(
  bandsByCommodity: ReadonlyMap<string, readonly CrowdBandRow[]>,
  commodityIds: readonly string[],
  month: string,
): MarketBasketTotal[] {
  const marketIds = new Set<string>();
  for (const bands of bandsByCommodity.values()) {
    for (const b of bandsForMonth(bands, month)) marketIds.add(b.marketId);
  }

  const totals: MarketBasketTotal[] = [];
  for (const marketId of marketIds) {
    let totalKobo = 0n;
    let itemsPriced = 0;
    for (const commodityId of commodityIds) {
      const match = bandsForMonth(bandsByCommodity.get(commodityId) ?? [], month).find(
        (b) => b.marketId === marketId,
      );
      if (match) {
        // matchCrowdBand-filtered bands always have a non-null median.
        totalKobo += match.medianKobo!;
        itemsPriced++;
      }
    }
    if (itemsPriced > 0) {
      totals.push({ marketId, totalKobo, itemsPriced, itemsMissing: commodityIds.length - itemsPriced });
    }
  }

  return totals.sort((a, b) => {
    if (a.totalKobo !== b.totalKobo) return a.totalKobo < b.totalKobo ? -1 : 1;
    return a.itemsMissing - b.itemsMissing;
  });
}
