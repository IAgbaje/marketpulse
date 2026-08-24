import { describe, expect, it } from "vitest";
import { toBaseUnits } from "./units.js";
import type { LocalUnit } from "./db.js";

function unit(factorToBase: number): LocalUnit {
  return { id: "u1", commodityId: "c1", unitName: "kg", factorToBase, conversionConfidence: 1 };
}

describe("toBaseUnits", () => {
  it("converts quantity to integer base units via the stated factor", () => {
    expect(toBaseUnits(2, unit(1000))).toBe(2000n);
  });

  it("rounds a fractional result to the nearest integer", () => {
    expect(toBaseUnits(1.5, unit(1000))).toBe(1500n);
    expect(toBaseUnits(0.001, unit(1000))).toBe(1n);
  });

  it("rejects a non-positive quantity", () => {
    expect(() => toBaseUnits(0, unit(1000))).toThrow(/positive/);
    expect(() => toBaseUnits(-1, unit(1000))).toThrow(/positive/);
  });
});
