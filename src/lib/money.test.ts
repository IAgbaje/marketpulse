import { describe, expect, it } from "vitest";
import { formatNaira, parseNairaToKobo } from "./money.js";

describe("formatNaira", () => {
  it("formats whole naira with thousand separators", () => {
    expect(formatNaira(150_000n)).toBe("₦1,500.00");
    expect(formatNaira(100n)).toBe("₦1.00");
  });

  it("formats kobo remainders", () => {
    expect(formatNaira(15_050n)).toBe("₦150.50");
    expect(formatNaira(199n)).toBe("₦1.99");
  });

  it("formats negative deltas with a leading minus, not inside the number", () => {
    expect(formatNaira(-150_000n)).toBe("-₦1,500.00");
  });

  it("formats zero", () => {
    expect(formatNaira(0n)).toBe("₦0.00");
  });
});

describe("parseNairaToKobo", () => {
  it("parses whole numbers", () => {
    expect(parseNairaToKobo("1500")).toBe(150_000n);
  });

  it("parses two decimal places", () => {
    expect(parseNairaToKobo("1500.50")).toBe(150_050n);
  });

  it("parses one decimal place", () => {
    expect(parseNairaToKobo("1500.5")).toBe(150_050n);
  });

  it("rejects more than two decimal places", () => {
    expect(parseNairaToKobo("1500.505")).toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(parseNairaToKobo("abc")).toBeNull();
    expect(parseNairaToKobo("")).toBeNull();
    expect(parseNairaToKobo("-100")).toBeNull();
  });

  it("accepts the grouped form formatNaira emits, so a pre-filled field round-trips", () => {
    expect(parseNairaToKobo("1,500")).toBe(150_000n);
    expect(parseNairaToKobo("2,450.75")).toBe(245_075n);
    expect(parseNairaToKobo("1,234,567.89")).toBe(123_456_789n);
  });

  it("round-trips a value ≥ ₦1,000 out of formatNaira and back without loss", () => {
    for (const kobo of [150_000n, 245_075n, 1_234_567_89n]) {
      const text = formatNaira(kobo).replace(/^₦/, "");
      expect(parseNairaToKobo(text)).toBe(kobo);
    }
  });

  it("round-trips through formatNaira", () => {
    const kobo = parseNairaToKobo("2450.75");
    expect(kobo).not.toBeNull();
    expect(formatNaira(kobo!)).toBe("₦2,450.75");
  });
});
