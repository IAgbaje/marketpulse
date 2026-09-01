/**
 * Progressive-disclosure tier selection and display projection
 * (Technical Requirements §4 stage 5a/5b, Handover §7.7).
 *
 * The engine (`decompose`) is pure and total and always computes the full
 * ledger. What the user is *shown* is a separate, equally-pure decision:
 *
 *  - `none`               — < 2 complete calendar months of history. No
 *                           decomposition at all.
 *  - `price_effect_only`  — P0 milestone (stage 5a). Exactly one figure: the
 *                           net price effect. Shippable before ≥ 2 months of
 *                           data exist for anyone.
 *  - `full`               — P1 (stage 5b). Two hero figures + two always-visible
 *                           reconciliation lines. Unlocked at ≥ 2 complete
 *                           months AND the 5b feature flag.
 */

import type { CurrencyCode, Decomposition } from './types';

export type Tier = 'none' | 'price_effect_only' | 'full';

export interface TierInputs {
  /** Count of *complete* calendar months of the user's purchase history. */
  completeMonths: number;
  /** Stage 5b shipped and enabled for this user. */
  fullSplitEnabled: boolean;
}

export function selectTier({ completeMonths, fullSplitEnabled }: TierInputs): Tier {
  if (completeMonths < 2) return 'none';
  return fullSplitEnabled ? 'full' : 'price_effect_only';
}

export interface PriceEffectTier {
  currency: CurrencyCode;
  /** The single figure shown in the stage-5a tier. */
  priceKobo: bigint;
  /** Carried so the UI can still show "of a ₦X total change". */
  totalChangeKobo: bigint;
}

export function projectToPriceEffect(d: Decomposition): PriceEffectTier {
  return {
    currency: d.currency,
    priceKobo: d.priceKobo,
    totalChangeKobo: d.totalChangeKobo,
  };
}

/**
 * The stage-5b display model: two hero figures (PRICE, WHAT_YOU_BOUGHT) plus two
 * always-visible reconciliation lines — basket change (NEW − STOPPED) and
 * EXCLUDED — matching Handover §15.3 screen 10 exactly, so engineering and design
 * cannot diverge on the shape (the TR §3.2 hazard).
 *
 * Display identity (same tie, regrouped):
 *   hero.priceKobo + hero.whatYouBoughtKobo
 *     + reconciliation.basketChangeKobo + reconciliation.excludedDeltaKobo
 *     === totalChangeKobo
 */
export interface DecompositionDisplayModel {
  currency: CurrencyCode;
  totalChangeKobo: bigint;
  hero: {
    priceKobo: bigint;
    whatYouBoughtKobo: bigint;
  };
  reconciliation: {
    /** One line: `newItemsKobo - stoppedBuyingKobo`. */
    basketChangeKobo: bigint;
    /** One line: the "N lines excluded, check them →" affordance, carrying its ₦ figure. */
    excludedDeltaKobo: bigint;
  };
  /** Sub-breakdown for the expandable detail under the basket-change line. */
  detail: {
    newItemsKobo: bigint;
    stoppedBuyingKobo: bigint;
    excludedCount: number;
  };
}

export function toDisplayModel(d: Decomposition): DecompositionDisplayModel {
  return {
    currency: d.currency,
    totalChangeKobo: d.totalChangeKobo,
    hero: {
      priceKobo: d.priceKobo,
      whatYouBoughtKobo: d.whatYouBoughtKobo,
    },
    reconciliation: {
      basketChangeKobo: d.newItemsKobo - d.stoppedBuyingKobo,
      excludedDeltaKobo: d.excludedDeltaKobo,
    },
    detail: {
      newItemsKobo: d.newItemsKobo,
      stoppedBuyingKobo: d.stoppedBuyingKobo,
      excludedCount: d.classification.excludedCommodityIds.length,
    },
  };
}
