import { describe, it, expect } from "vitest";
import {
  CONTRACT_ID,
  parseOcrExtraction,
  toDraftItems,
  nairaToKobo,
} from "@/src/lib/ocr/extractionContract";

const good = {
  contract: CONTRACT_ID,
  notes: "handwritten, faint",
  items: [
    {
      raw_text: "Tomatoes 1 basket 8000",
      name_guess: "tomatoes",
      quantity: 1,
      unit_text: "basket",
      total_price_naira: 8000,
      unit_price_naira: null,
      confidence: 0.8,
    },
    {
      raw_text: "Rice - 5000",
      name_guess: "rice",
      quantity: null,
      unit_text: null,
      total_price_naira: 5000,
      unit_price_naira: null,
      confidence: 0.4,
    },
  ],
};

describe("parseOcrExtraction", () => {
  it("accepts a clean contract payload", () => {
    const parsed = parseOcrExtraction(good);
    expect(parsed?.items).toHaveLength(2);
    expect(parsed?.notes).toBe("handwritten, faint");
  });

  it("unwraps a provider envelope and a stringified body", () => {
    expect(parseOcrExtraction({ extraction: good })?.items).toHaveLength(2);
    expect(parseOcrExtraction(JSON.stringify(good))?.items).toHaveLength(2);
    expect(parseOcrExtraction({ output: JSON.stringify(good) })?.items).toHaveLength(2);
  });

  it("unwraps an OpenAI-style chat envelope (choices[0].message.content)", () => {
    const wrapped = { choices: [{ message: { content: JSON.stringify(good) } }] };
    expect(parseOcrExtraction(wrapped)?.items).toHaveLength(2);
  });

  it("caps the item list so an adversarial reply can't freeze the render", () => {
    const many = { items: Array.from({ length: 5000 }, (_, i) => ({ raw_text: `Item ${i}`, confidence: 0.9 })) };
    const parsed = parseOcrExtraction(many);
    expect(parsed?.items.length).toBeLessThanOrEqual(100);
  });

  it("rejects an absurd magnitude instead of overflowing to Infinity", () => {
    const parsed = parseOcrExtraction({
      items: [{ raw_text: "Gold bar", total_price_naira: 1e309, quantity: 2, confidence: 0.9 }],
    });
    // 1e309 parses as Infinity in JSON → rejected as a number outright
    expect(parsed?.items[0]?.total_price_naira ?? null).toBeNull();
    const big = parseOcrExtraction({
      items: [{ raw_text: "Gold bar", total_price_naira: 5e11, confidence: 0.9 }],
    });
    expect(big?.items[0]?.total_price_naira).toBe(5e11); // under the 1e12 cap, fine
    const overCap = parseOcrExtraction({
      items: [{ raw_text: "Gold bar", total_price_naira: 2e12, confidence: 0.9 }],
    });
    expect(overCap?.items[0]?.total_price_naira ?? null).toBeNull();
  });

  it("drops items with no usable label but keeps the rest", () => {
    const parsed = parseOcrExtraction({
      items: [
        { raw_text: "  ", name_guess: null, confidence: 0.9 },
        { raw_text: "Palm oil 1 paint 6500", name_guess: "palm oil", confidence: 0.7 },
      ],
    });
    expect(parsed?.items).toHaveLength(1);
    expect(parsed?.items[0]?.raw_text).toBe("Palm oil 1 paint 6500");
  });

  it("treats a missing confidence as low, not high", () => {
    const parsed = parseOcrExtraction({ items: [{ raw_text: "Yam 2 tubers 3000" }] });
    expect(parsed?.items[0]?.confidence).toBeLessThan(0.5);
  });

  it("rejects a payload with no items array, and one with only junk items", () => {
    expect(parseOcrExtraction({ foo: "bar" })).toBeNull();
    expect(parseOcrExtraction("not json")).toBeNull();
    expect(parseOcrExtraction({ items: [] })).toBeNull();
    expect(parseOcrExtraction({ items: [{ name_guess: null, raw_text: "" }] })).toBeNull();
    expect(parseOcrExtraction(null)).toBeNull();
  });

  it("clamps confidence into 0..1 and ignores non-positive numbers", () => {
    const parsed = parseOcrExtraction({
      items: [
        { raw_text: "A", confidence: 2, quantity: -1, total_price_naira: 0, unit_price_naira: -5 },
      ],
    });
    expect(parsed?.items[0]?.confidence).toBe(1);
    expect(parsed?.items[0]?.quantity).toBeNull();
    expect(parsed?.items[0]?.total_price_naira).toBeNull();
    expect(parsed?.items[0]?.unit_price_naira).toBeNull();
  });
});

describe("nairaToKobo", () => {
  it("converts to integer kobo at the boundary, nearest kobo", () => {
    expect(nairaToKobo(3600)).toBe(360000n);
    expect(nairaToKobo(1499.99)).toBe(149999n);
    expect(nairaToKobo(0)).toBeNull();
    expect(nairaToKobo(null)).toBeNull();
    expect(nairaToKobo(Number.NaN)).toBeNull();
  });

  it("returns null (never throws) for a non-finite or absurd magnitude", () => {
    expect(nairaToKobo(Number.POSITIVE_INFINITY)).toBeNull();
    expect(nairaToKobo(1e13)).toBeNull(); // over the 1e12 cap
    expect(() => nairaToKobo(1e309)).not.toThrow();
  });
});

describe("toDraftItems", () => {
  it("normalises currency and derives a missing total from unit price x quantity", () => {
    const parsed = parseOcrExtraction({
      items: [
        {
          raw_text: "Onions 3 kg",
          name_guess: "onions",
          quantity: 3,
          unit_text: "kg",
          total_price_naira: null,
          unit_price_naira: 1200,
          confidence: 0.9,
        },
      ],
    })!;
    const [item] = toDraftItems(parsed);
    expect(item?.unitPriceKobo).toBe(120000n);
    expect(item?.totalPriceKobo).toBe(360000n); // 1200 * 3 -> kobo
  });

  it("leaves total null when neither a total nor (unit price + qty) is present", () => {
    const [item] = toDraftItems(parseOcrExtraction({ items: [{ raw_text: "Salt" }] })!);
    expect(item?.totalPriceKobo).toBeNull();
  });
});
