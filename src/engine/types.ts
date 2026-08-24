/**
 * Decomposition engine types.
 *
 * Spec: Technical Requirements §3 (and §3.1 for the representation rule).
 * Money is integer kobo throughout. Quantity is integer base units (grams /
 * millilitres / pieces x 1000). Neither is ever a float, and unit prices are
 * never materialised as scalars — see §3.1.
 */

/** Integer kobo. Negative values are legal (a spend delta can fall). */
export type Kobo = bigint;

/** Integer base units: grams, millilitres, or pieces x 1000. Never negative. */
export type BaseQty = bigint;

/**
 * One commodity's totals within a single period, already aggregated across
 * every line for that commodity in that period.
 */
export interface CommodityPeriodTotals {
  readonly commodityId: string;
  readonly cost: Kobo;
  readonly qty: BaseQty;
}

/**
 * A period's basket. `currency` is carried explicitly: a decomposition must
 * never span mixed currencies (§3.3).
 */
export interface Basket {
  readonly currency: string;
  readonly commodities: readonly CommodityPeriodTotals[];
  /**
   * Lines flagged by the outlier guard and not user-confirmed. Excluded from
   * the four main components and surfaced as their own reconciliation line so
   * the ledger still ties to the user's true delta (§3.2).
   */
  readonly excludedCost: Kobo;
}

/**
 * The five reconciliation lines. The invariant this engine exists to hold:
 *
 *   price + whatYouBought + newItems - stoppedBuying + excludedDelta === totalDelta
 *
 * exactly, in whole kobo, for every input. Enforced by property test, not review.
 */
export interface Decomposition {
  readonly price: Kobo;
  readonly whatYouBought: Kobo;
  readonly newItems: Kobo;
  readonly stoppedBuying: Kobo;
  readonly excludedDelta: Kobo;
  readonly totalDelta: Kobo;

  /** Counts shown alongside the reconciliation lines in the UI. */
  readonly newItemCount: number;
  readonly stoppedBuyingCount: number;

  /**
   * Intersection coverage as a percentage of prior-period spend by value.
   * Drives the <70% disclosure rule. Integer percent, 0-100.
   */
  readonly coveragePercent: number;
}
