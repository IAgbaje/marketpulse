/**
 * Outlier guard: flag a line whose unit_price_normalized deviates more than
 * 3x from the user's trailing median for that commodity (Handover §7.5, US-1.3
 * AC). A flagged, unconfirmed line is excluded from the decomposition and
 * disclosed (Technical Requirements §3.2) — this module only decides the
 * flag; exclusion and disclosure happen at the engine boundary.
 *
 * With fewer than one prior observation there is no median to deviate from,
 * so the guard cannot fire — a user's very first purchase of a commodity is
 * never flagged, which is correct: there is nothing yet to compare it to.
 */

const OUTLIER_MULTIPLE = 3;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const midValue = sorted[mid];
  if (midValue === undefined) return null; // unreachable given the length check above
  if (sorted.length % 2 === 1) return midValue;
  const lower = sorted[mid - 1];
  return lower === undefined ? midValue : (lower + midValue) / 2;
}

export function isOutlier(
  unitPriceNormalized: number,
  trailingUnitPrices: readonly number[],
): boolean {
  const m = median(trailingUnitPrices);
  if (m === null || m === 0) return false;
  return (
    unitPriceNormalized > m * OUTLIER_MULTIPLE ||
    unitPriceNormalized < m / OUTLIER_MULTIPLE
  );
}
