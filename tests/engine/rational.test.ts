import { describe, it, expect } from 'vitest';
import { floorDiv, roundHalfEvenRational, addRational } from '@/src/engine/rational';

describe('floorDiv', () => {
  it('matches truncation for exact and positive cases', () => {
    expect(floorDiv(6n, 2n)).toBe(3n);
    expect(floorDiv(7n, 2n)).toBe(3n);
    expect(floorDiv(0n, 5n)).toBe(0n);
  });

  it('rounds toward negative infinity for negative dividends', () => {
    expect(floorDiv(-6n, 2n)).toBe(-3n); // exact
    expect(floorDiv(-5n, 2n)).toBe(-3n); // -2.5 → -3
    expect(floorDiv(-1n, 3n)).toBe(-1n); // -0.33 → -1
  });

  it('rejects a non-positive divisor', () => {
    expect(() => floorDiv(1n, 0n)).toThrow(RangeError);
    expect(() => floorDiv(1n, -2n)).toThrow(RangeError);
  });
});

describe('roundHalfEvenRational', () => {
  it('rounds toward the nearer integer', () => {
    expect(roundHalfEvenRational(10n, 3n)).toBe(3n); // 3.33
    expect(roundHalfEvenRational(11n, 3n)).toBe(4n); // 3.66
    expect(roundHalfEvenRational(-10n, 3n)).toBe(-3n); // -3.33
    expect(roundHalfEvenRational(-11n, 3n)).toBe(-4n); // -3.66
  });

  it('breaks exact halves toward the even integer, across the sign boundary', () => {
    expect(roundHalfEvenRational(1n, 2n)).toBe(0n); // 0.5 → 0
    expect(roundHalfEvenRational(3n, 2n)).toBe(2n); // 1.5 → 2
    expect(roundHalfEvenRational(5n, 2n)).toBe(2n); // 2.5 → 2
    expect(roundHalfEvenRational(7n, 2n)).toBe(4n); // 3.5 → 4
    expect(roundHalfEvenRational(-1n, 2n)).toBe(0n); // -0.5 → 0
    expect(roundHalfEvenRational(-3n, 2n)).toBe(-2n); // -1.5 → -2
    expect(roundHalfEvenRational(-5n, 2n)).toBe(-2n); // -2.5 → -2
    expect(roundHalfEvenRational(-7n, 2n)).toBe(-4n); // -3.5 → -4
  });

  it('is exact for integer-valued rationals', () => {
    expect(roundHalfEvenRational(200n, 1n)).toBe(200n);
    expect(roundHalfEvenRational(-4200n, 7n)).toBe(-600n); // -600 exactly
  });

  it('worked example from TR §3.1: 2/7 kobo/g over 700 g is 200 kobo, not ~0', () => {
    // The scalar-rounding bug would drop 2/7 kobo/g to 0 and lose ₦2.00 on the line.
    expect(roundHalfEvenRational(2n * 700n, 7n)).toBe(200n);
  });

  it('rejects a non-positive denominator', () => {
    expect(() => roundHalfEvenRational(1n, 0n)).toThrow(RangeError);
    expect(() => roundHalfEvenRational(1n, -2n)).toThrow(RangeError);
  });

  it('reversing a rounded split reproduces the exact integer delta', () => {
    // Rounding-policy test (fintech standard): p̂ + (delta - p̂) === delta, exactly.
    const num = 123_456_789n;
    const den = 1_000_000n;
    const delta = 987n;
    const pHat = roundHalfEvenRational(num, den);
    expect(pHat + (delta - pHat)).toBe(delta);
  });
});

describe('addRational', () => {
  it('adds without reducing and keeps a positive denominator', () => {
    expect(addRational(1n, 2n, 1n, 3n)).toEqual([5n, 6n]);
    expect(addRational(-1n, 4n, 1n, 4n)).toEqual([0n, 16n]);
  });
});
