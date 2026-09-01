/**
 * Exact rational arithmetic over BigInt — the substrate for the decomposition
 * engine (Technical Requirements §3.1, blocking item 1).
 *
 * Why this file exists: the Bennet PRICE term operates on *unit prices*
 * `P = cost / quantity`. With integer kobo over integer base-units, `P` is a
 * rational that is almost never an integer (₦1,500 / 700 g = 214.2857… kobo/g).
 * Materialising `P` as a JS `number` — or rounding it to whole kobo-per-unit —
 * loses up to 0.5 kobo *per base unit*, which across one 700 g line is ₦2+ of
 * error and silently breaks the exact tie the engine exists to guarantee.
 *
 * The rule (TR §3.1): never materialise `P` as a scalar. Carry PRICE as an
 * exact `numerator / denominator` pair of BigInts and round it exactly once.
 *
 * BigInt is load-bearing, not stylistic: the PRICE numerator is of order
 * `c · q²` and overflows 64-bit signed at realistic Nigerian basket sizes.
 */

/**
 * Floor division for BigInt: the largest integer `q` with `q * d <= n`.
 * Defined only for a positive divisor. Correct for negative `n` (native BigInt
 * `/` truncates toward zero, which is wrong for negatives).
 */
export function floorDiv(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new RangeError('floorDiv: divisor must be positive');
  const q = n / d;
  // Adjust down when the truncated quotient overshot a negative dividend.
  return n % d !== 0n && n < 0n ? q - 1n : q;
}

/**
 * Round the exact rational `n / d` (with `d > 0`) to the nearest integer,
 * ties to even — ROUND_HALF_EVEN / banker's rounding, the documented policy
 * for MarketPulse financial arithmetic. Correct across the sign boundary.
 *
 *   roundHalfEvenRational(5n, 2n)   // 2.5  → 2  (even)
 *   roundHalfEvenRational(7n, 2n)   // 3.5  → 4  (even)
 *   roundHalfEvenRational(-5n, 2n)  // -2.5 → -2 (even)
 *   roundHalfEvenRational(-7n, 2n)  // -3.5 → -4 (even)
 */
export function roundHalfEvenRational(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new RangeError('roundHalfEvenRational: denominator must be positive');
  const q = floorDiv(n, d); // n = q*d + r, with 0 <= r < d
  const r = n - q * d;
  const twiceR = 2n * r;
  if (twiceR < d) return q; // closer to q
  if (twiceR > d) return q + 1n; // closer to q + 1
  // Exact half: pick the even neighbour.
  return q % 2n === 0n ? q : q + 1n;
}

/**
 * Add two rationals a/ad + b/bd, returned in un-reduced `[num, den]` form with
 * `den > 0`. Used only where an *exact* aggregate rational is needed (e.g. the
 * "true aggregate PRICE" reference value in tests). The engine's hot path never
 * needs this — it rounds per commodity and sums integers.
 */
export function addRational(
  aNum: bigint,
  aDen: bigint,
  bNum: bigint,
  bDen: bigint,
): [bigint, bigint] {
  if (aDen <= 0n || bDen <= 0n) throw new RangeError('addRational: denominators must be positive');
  return [aNum * bDen + bNum * aDen, aDen * bDen];
}
