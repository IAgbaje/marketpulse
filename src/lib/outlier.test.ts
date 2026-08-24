import { describe, expect, it } from "vitest";
import { isOutlier, median } from "./outlier.js";

describe("median", () => {
  it("returns null for an empty series", () => {
    expect(median([])).toBeNull();
  });

  it("returns the middle value for an odd-length series", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("averages the two middle values for an even-length series", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("isOutlier — the §7.5 outlier guard", () => {
  it("never flags a first-ever observation (no history to deviate from)", () => {
    expect(isOutlier(1000, [])).toBe(false);
  });

  it("flags a price more than 3x the trailing median", () => {
    expect(isOutlier(301, [100, 100, 100])).toBe(true);
  });

  it("does not flag a price at or below 3x", () => {
    expect(isOutlier(300, [100, 100, 100])).toBe(false);
  });

  it("flags a price less than 1/3 of the trailing median — the '2 paint read as 1 paint' case, inverted", () => {
    expect(isOutlier(33, [100, 100, 100])).toBe(true);
  });

  it("does not flag an ordinary price rise well under the 3x threshold", () => {
    expect(isOutlier(200, [100, 100, 100])).toBe(false);
  });
});
