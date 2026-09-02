import { describe, it, expect } from "vitest";
import { matchCommodity, matchUnit, prepareOcrLines } from "@/src/lib/ocrMapping";
import type { LocalAlias, LocalCommodity, LocalUnit } from "@/src/lib/db";
import type { OcrDraftItem } from "@/src/lib/ocr/extractionContract";

const commodities: LocalCommodity[] = [
  mkC("rice_local", "Local rice"),
  mkC("tomato", "Tomatoes"),
  mkC("palm_oil", "Palm oil"),
  mkC("yam", "Yam"),
];

const aliases: LocalAlias[] = [
  { commodityId: "rice_local", alias: "ofada" },
  { commodityId: "tomato", alias: "tomato" },
  { commodityId: "palm_oil", alias: "red oil" },
];

const units: LocalUnit[] = [
  mkU("u_kg", "kg", null),
  mkU("u_g", "g", null),
  mkU("u_piece", "piece", null),
  mkU("u_paint", "paint_rubber", "palm_oil"),
  mkU("u_basket", "basket", "tomato"),
  mkU("u_tuber", "tuber", "yam"),
];

function mkC(id: string, name: string): LocalCommodity {
  return {
    id,
    canonicalName: name,
    category: "staple",
    baseUnit: "g",
    substituteGroup: null,
    perishable: false,
    gradeSensitive: false,
    provisional: false,
  };
}
function mkU(id: string, unitCode: string, commodityId: string | null): LocalUnit {
  return {
    id,
    unitCode,
    toBaseUnit: "g",
    commodityId,
    factorNum: "1000",
    factorDen: "1",
    confidence: "high",
  };
}

describe("matchCommodity", () => {
  it("matches on canonical name and on alias", () => {
    expect(matchCommodity("palm oil", "Palm oil 1 paint", { commodities, aliases, units })?.commodityId).toBe(
      "palm_oil",
    );
    expect(matchCommodity("red oil", "red oil 6500", { commodities, aliases, units })?.commodityId).toBe(
      "palm_oil",
    );
    expect(matchCommodity("ofada", "OFADA RICE", { commodities, aliases, units })?.commodityId).toBe(
      "rice_local",
    );
  });

  it("returns null below the confidence bar rather than guessing", () => {
    expect(matchCommodity("xyzzy widget", "xyzzy widget 100", { commodities, aliases, units })).toBeNull();
  });

  it("does NOT confidently match on a bare substring collision", () => {
    // "ice" ⊂ "local rice", "tin" ⊂ "plantain" — whole-token matching only.
    expect(matchCommodity("ice", "ice block 500", { commodities, aliases, units })).toBeNull();
    expect(matchCommodity("tin", "tin of milk 900", { commodities, aliases, units })).toBeNull();
  });
});

describe("matchUnit", () => {
  it("resolves exact codes and common Nigerian-market synonyms", () => {
    expect(matchUnit("kg", null, units)).toBe("u_kg");
    expect(matchUnit("KILOS", null, units)).toBe("u_kg");
    expect(matchUnit("pcs", null, units)).toBe("u_piece");
    expect(matchUnit("paint", "palm_oil", units)).toBe("u_paint");
  });

  it("returns null for an unknown unit and for an ambiguous loose match", () => {
    expect(matchUnit("blorp", null, units)).toBeNull();
    expect(matchUnit(null, null, units)).toBeNull();
  });

  it("does NOT let a single-character synonym swallow a longer word", () => {
    // "bag" must not match grams ("g"); "bottle" must not match litres ("l").
    expect(matchUnit("bag", null, units)).not.toBe("u_g");
    expect(matchUnit("bottle", null, units)).not.toBe("u_kg");
    expect(matchUnit("egg", null, units)).not.toBe("u_g");
  });

  it("only offers commodity-scoped units for the matched commodity", () => {
    expect(matchUnit("basket", "palm_oil", units)).toBeNull();
    expect(matchUnit("basket", "tomato", units)).toBe("u_basket");
  });
});

describe("prepareOcrLines", () => {
  const ref = { commodities, aliases, units };

  it("marks a fully-resolved high-confidence row as not needing review", () => {
    const items: OcrDraftItem[] = [
      {
        rawText: "Tomatoes 1 basket 8000",
        nameGuess: "tomatoes",
        quantity: 1,
        unitText: "basket",
        totalPriceKobo: 800000n,
        unitPriceKobo: null,
        confidence: 0.9,
      },
    ];
    const [row] = prepareOcrLines(items, ref);
    expect(row).toMatchObject({
      commodityId: "tomato",
      unitId: "u_basket",
      quantity: 1,
      paidPriceKobo: 800000n,
      needsReview: false,
    });
  });

  it("flags rows for review when the commodity is unmatched", () => {
    const items: OcrDraftItem[] = [
      {
        rawText: "Maggi cubes 200",
        nameGuess: "maggi cubes",
        quantity: 1,
        unitText: "piece",
        totalPriceKobo: 20000n,
        unitPriceKobo: null,
        confidence: 0.95,
      },
    ];
    const [row] = prepareOcrLines(items, ref);
    expect(row?.commodityId).toBeNull();
    expect(row?.needsReview).toBe(true);
  });

  it("flags rows for review when the model's own confidence is low", () => {
    const items: OcrDraftItem[] = [
      {
        rawText: "rice 3600",
        nameGuess: "local rice",
        quantity: 2,
        unitText: "kg",
        totalPriceKobo: 360000n,
        unitPriceKobo: null,
        confidence: 0.3,
      },
    ];
    const [row] = prepareOcrLines(items, ref);
    expect(row?.commodityId).toBe("rice_local");
    expect(row?.needsReview).toBe(true);
  });

  it("flags rows for review when the commodity match is weak (matched off raw text only)", () => {
    const items: OcrDraftItem[] = [
      {
        rawText: "tomatoes 1 basket 8000",
        nameGuess: null, // no clean guess — matched off the raw line, a weaker signal
        quantity: 1,
        unitText: "basket",
        totalPriceKobo: 800000n,
        unitPriceKobo: null,
        confidence: 0.95,
      },
    ];
    const [row] = prepareOcrLines(items, ref);
    expect(row?.commodityId).toBe("tomato");
    expect(row?.commodityConfidence).toBeLessThan(0.75);
    expect(row?.needsReview).toBe(true);
  });

  it("uses the contract module's price (never re-derives with an integer-rounded quantity)", () => {
    // total already resolved upstream by toDraftItems; prepareOcrLines trusts it.
    const items: OcrDraftItem[] = [
      {
        rawText: "Yam 0.5 tuber",
        nameGuess: "yam",
        quantity: 0.5,
        unitText: "tuber",
        totalPriceKobo: 45000n, // = 90000 unit × 0.5, resolved in toDraftItems
        unitPriceKobo: 90000n,
        confidence: 0.9,
      },
    ];
    const [row] = prepareOcrLines(items, ref);
    expect(row?.paidPriceKobo).toBe(45000n); // NOT 90000n (0.5 rounded to 1)
    expect(row?.needsReview).toBe(false);
  });
});
