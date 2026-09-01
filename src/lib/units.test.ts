import { describe, expect, it } from "vitest";
import { toBaseUnits } from "./units.js";
import type { LocalUnit } from "./db.js";

function unit(factorNum: string, factorDen = "1"): LocalUnit {
  return {
    id: "u1",
    unitCode: "kg",
    toBaseUnit: "g",
    commodityId: "c1",
    factorNum,
    factorDen,
    confidence: "high",
  };
}

describe("toBaseUnits", () => {
  it("converts quantity to integer base units via the stated factor", () => {
    expect(toBaseUnits(2, unit("1000"))).toBe(2000n);
  });

  it("rounds a fractional result to the nearest integer, ties to even", () => {
    expect(toBaseUnits(1.5, unit("1000"))).toBe(1500n);
    expect(toBaseUnits(0.001, unit("1000"))).toBe(1n);
  });

  it("handles a non-integer rational factor exactly (e.g. a derica-style measure)", () => {
    // 1 derica = 1 / 3 kg = 333.333... g -> factor 1000/3 g per unit.
    expect(toBaseUnits(1, unit("1000", "3"))).toBe(333n);
    expect(toBaseUnits(3, unit("1000", "3"))).toBe(1000n);
  });

  it("rejects a non-positive quantity", () => {
    expect(() => toBaseUnits(0, unit("1000"))).toThrow(/positive/);
    expect(() => toBaseUnits(-1, unit("1000"))).toThrow(/positive/);
  });
});
