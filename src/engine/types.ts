/**
 * Domain types for the variance-decomposition engine.
 *
 * Non-negotiable invariants carried in from Technical Requirements §7:
 *  - Money is integer kobo (`bigint`) end to end. No floats. No `toFixed`.
 *  - Every amount has an explicit `currency` sibling. A decomposition never
 *    spans mixed currencies — the caller segments by currency and calls once
 *    per currency (TR §3.3).
 *  - Quantities are integers in the commodity's base unit. Negative cost or
 *    quantity is data corruption, not a refund — the engine throws rather than
 *    silently reclassifying it to a reconciliation line (TR §3.1).
 */

/** MVP is NGN-only. The type is widened deliberately so a mixed-currency call
 *  is a compile-time smell, not a silent runtime sum. */
export type CurrencyCode = 'NGN' | (string & {});

/**
 * One commodity's aggregated position within a single complete calendar month.
 * Produced upstream by summing every `purchase_line` for that (commodity, month)
 * into integer totals — see TR §3.1 step 1.
 */
export interface CommodityPeriod {
  commodityId: string;
  /** Total kobo paid for this commodity in the period. Integer, `>= 0`. */
  costKobo: bigint;
  /** Total quantity in the commodity's base unit for the period. Integer, `>= 0`.
   *  `qtyBaseUnit === 0n` requires `costKobo === 0n` (you cannot pay for nothing). */
  qtyBaseUnit: bigint;
}

export interface DecompositionInput {
  /** The earlier period (period 0). Aggregated, one row per commodity. */
  periodStart: CommodityPeriod[];
  /** The later period (period 1). Aggregated, one row per commodity. */
  periodEnd: CommodityPeriod[];
  /**
   * Commodity ids whose lines were flagged as outliers and left unconfirmed
   * (US-3.3). They are pulled out of PRICE / WHAT_YOU_BOUGHT and surfaced as a
   * single always-visible `EXCLUDED_DELTA` reconciliation line, so the ledger
   * still ties to the user's *true* month-over-month delta rather than a
   * filtered one (TR §3.2). Each id must appear in at least one period.
   */
  excludedCommodityIds?: readonly string[];
  /** Single currency for the whole call. See `CurrencyCode`. */
  currency: CurrencyCode;
}

/** Per-commodity PRICE / WHAT_YOU_BOUGHT split for one intersection-basket item. */
export interface CommodityDecomposition {
  commodityId: string;
  /** Bennet PRICE term, rounded once (ROUND_HALF_EVEN) from an exact rational. */
  priceKobo: bigint;
  /** Derived by subtraction: `(c1 - c0) - priceKobo`. Never its own formula. */
  whatYouBoughtKobo: bigint;
  /** `c1 - c0` for this commodity. `priceKobo + whatYouBoughtKobo` equals this exactly. */
  totalChangeKobo: bigint;
}

export interface DecompositionClassification {
  /** In both periods with `q0 > 0 AND q1 > 0`. */
  intersectionCommodityIds: string[];
  /** `q0 === 0 AND q1 > 0` — bought this period, not last. */
  newCommodityIds: string[];
  /** `q0 > 0 AND q1 === 0` — bought last period, not this. */
  stoppedCommodityIds: string[];
  /** Passed in `excludedCommodityIds`; removed from the four buckets above. */
  excludedCommodityIds: string[];
}

/**
 * The exact ledger. The identity that holds with zero tolerance, every time:
 *
 *   priceKobo + whatYouBoughtKobo + newItemsKobo
 *     - stoppedBuyingKobo + excludedDeltaKobo === totalChangeKobo
 *
 * `stoppedBuyingKobo` is a positive magnitude (Σ c0 over stopped commodities)
 * and is *subtracted* in the identity — matched by UI copy ("you stopped
 * buying X: −₦Y").
 */
export interface Decomposition {
  currency: CurrencyCode;
  /** `Σ (c1 - c0)` over every commodity, including excluded ones. The true delta. */
  totalChangeKobo: bigint;
  /** `Σ` rounded per-commodity PRICE over the intersection basket. */
  priceKobo: bigint;
  /** `Σ ((c1 - c0) - priceKobo)` over the intersection basket. */
  whatYouBoughtKobo: bigint;
  /** `Σ c1` over commodities new this period. */
  newItemsKobo: bigint;
  /** `Σ c0` over commodities stopped this period. Positive magnitude; subtracted. */
  stoppedBuyingKobo: bigint;
  /** `Σ (c1 - c0)` over excluded commodities. */
  excludedDeltaKobo: bigint;
  intersection: CommodityDecomposition[];
  classification: DecompositionClassification;
}
