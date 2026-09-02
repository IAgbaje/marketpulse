/**
 * Maps validated OCR draft items (src/lib/ocr/extractionContract.ts) onto the
 * commodity master list and unit table — the bridge between "the model read a
 * receipt" and "these are editable trip lines".
 *
 * Pure: reference data is passed in (the same `LocalCommodity` / `LocalAlias`
 * / `LocalUnit` shapes Dexie caches), so this is unit-testable with no DB and
 * no browser. The caller (PhotoCapture) supplies the cached reference data and
 * turns a `PreparedOcrLine` into a real line via `addLine` once the user has
 * filled any gap the match left.
 *
 * Matching is deliberately conservative — a wrong auto-match on the "critical
 * screen" (§15.3) is worse than an honest blank the user fills in. Anything
 * below the confidence bar is surfaced as `needsReview`, never silently used.
 */

import type { LocalAlias, LocalCommodity, LocalLine, LocalUnit } from "./db.js";
import type { OcrDraftItem } from "./ocr/extractionContract.js";

export interface OcrRefData {
  commodities: readonly LocalCommodity[];
  aliases: readonly LocalAlias[];
  units: readonly LocalUnit[];
}

export interface PreparedOcrLine {
  rawText: string;
  /** Matched commodity, or null when the user must pick. */
  commodityId: string | null;
  commodityConfidence: number;
  /** Matched unit (scoped to the commodity or commodity-independent), or null. */
  unitId: string | null;
  quantity: number | null;
  paidPriceKobo: bigint | null;
  purchaseForm: LocalLine["purchaseForm"];
  /** True when a human must touch this row before it can become a line. */
  needsReview: boolean;
}

const COMMODITY_MATCH_BAR = 0.55;

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normalise(s).split(" ").filter(Boolean);
}

/**
 * Token-set score in [0,1] between the model's guess (+ raw line as a weaker
 * fallback signal) and a commodity's canonical name / aliases.
 *
 * Deliberately NOT raw substring containment: "ice" ⊂ "local rice" and
 * "tin" ⊂ "plantain" are exactly the confident false matches that would put a
 * wrong commodity on the critical screen. Matching is on whole tokens only —
 * a subset relation or Jaccard overlap, nothing character-level.
 */
function scoreCommodity(
  nameGuess: string | null,
  rawText: string,
  commodity: LocalCommodity,
  aliasNames: readonly string[],
): number {
  const haystacks = [commodity.canonicalName, ...aliasNames].map(normalise).filter(Boolean);
  const candidates: { needle: string; weight: number }[] = [
    { needle: normalise(nameGuess ?? ""), weight: 1 },
    { needle: normalise(rawText), weight: 0.7 }, // raw line is a weaker signal
  ].filter((c) => c.needle);

  let best = 0;
  for (const hay of haystacks) {
    const hayTokens = new Set(tokens(hay));
    for (const { needle, weight } of candidates) {
      const nTokens = tokens(needle);
      if (nTokens.length === 0) continue;
      const nSet = new Set(nTokens);

      let score: number;
      if (needle === hay) {
        score = 1;
      } else if (nTokens.every((t) => hayTokens.has(t)) && needle.length >= 3) {
        // whole guess is contained in the name/alias ("rice" → "local rice")
        score = 0.9;
      } else if ([...hayTokens].every((t) => nSet.has(t)) && hay.length >= 3) {
        // whole name/alias is contained in the guess ("local rice" → guess "local rice 2kg")
        score = 0.8;
      } else {
        const inter = nTokens.filter((t) => hayTokens.has(t)).length;
        const union = new Set([...nSet, ...hayTokens]).size;
        score = union === 0 ? 0 : (inter / union) * 0.9;
      }
      best = Math.max(best, score * weight);
    }
  }
  return best;
}

export interface CommodityMatch {
  commodityId: string;
  confidence: number;
}

export function matchCommodity(
  nameGuess: string | null,
  rawText: string,
  ref: OcrRefData,
): CommodityMatch | null {
  const aliasesByCommodity = new Map<string, string[]>();
  for (const a of ref.aliases) {
    const list = aliasesByCommodity.get(a.commodityId) ?? [];
    list.push(a.alias);
    aliasesByCommodity.set(a.commodityId, list);
  }

  let best: CommodityMatch | null = null;
  for (const c of ref.commodities) {
    const score = scoreCommodity(nameGuess, rawText, c, aliasesByCommodity.get(c.id) ?? []);
    if (score > (best?.confidence ?? 0)) best = { commodityId: c.id, confidence: score };
  }
  return best && best.confidence >= COMMODITY_MATCH_BAR ? best : null;
}

/** Common Nigerian-market unit spellings → the `unit_code`s the seed uses. */
const UNIT_SYNONYMS: Record<string, string[]> = {
  kg: ["kg", "kilo", "kilos", "kilogram", "kilogramme", "kgs"],
  g: ["g", "gram", "grams", "gramme", "grammes", "gm"],
  l: ["l", "litre", "litres", "liter", "liters", "ltr"],
  ml: ["ml", "millilitre", "millilitres"],
  piece: ["piece", "pieces", "pcs", "pc", "each", "unit", "units", "no", "nos"],
  paint_rubber: ["paint", "paint rubber", "rubber", "painter", "garri rubber"],
  derica: ["derica", "derica", "kongo", "congo", "cup"],
  mudu: ["mudu", "muddu", "tiya"],
  bag: ["bag", "sack", "bag 50kg", "50kg bag"],
  basket: ["basket", "baskets"],
  tuber: ["tuber", "tubers"],
  bunch: ["bunch", "bunches"],
  paint_tin: ["tin", "tins", "custard tin"],
};

export function matchUnit(
  unitText: string | null,
  commodityId: string | null,
  units: readonly LocalUnit[],
): string | null {
  if (!unitText) return null;
  const want = normalise(unitText);
  if (!want) return null;
  const wantTokens = tokens(want);

  const candidates = units.filter(
    (u) => u.commodityId === commodityId || u.commodityId === null,
  );

  // 1. exact unit_code
  const exact = candidates.find((u) => normalise(u.unitCode) === want);
  if (exact) return exact.id;

  // 2. synonym class — whole-token match only. NOT `want.includes(s)`: with
  //    single-character synonyms ("g", "l") that makes "bag" → grams and
  //    "bottle" → litres. A spelling matches iff it equals `want` or is one
  //    of its whole tokens.
  const canonical = Object.entries(UNIT_SYNONYMS).find(([, spellings]) =>
    spellings.some((s) => s === want || wantTokens.includes(s)),
  )?.[0];
  if (canonical) {
    const bySynonym = candidates.find((u) => normalise(u.unitCode) === canonical);
    if (bySynonym) return bySynonym.id;
  }

  // 3. loose containment, only when unambiguous AND both sides are ≥ 3 chars
  //    (so a 1–2 char unit code can never be loose-matched).
  if (want.length >= 3) {
    const contains = candidates.filter((u) => {
      const code = normalise(u.unitCode);
      return code.length >= 3 && (code.includes(want) || want.includes(code));
    });
    if (contains.length === 1) return contains[0]!.id;
  }
  return null;
}

/**
 * Turn currency-normalised draft items into rows the review screen renders.
 * A row `needsReview` unless it has a matched commodity, a matched unit, a
 * positive quantity and a positive price — i.e. everything `addLine` needs.
 */
const COMMODITY_REVIEW_BAR = 0.75;

export function prepareOcrLines(items: readonly OcrDraftItem[], ref: OcrRefData): PreparedOcrLine[] {
  return items.map((it) => {
    const commodity = matchCommodity(it.nameGuess, it.rawText, ref);
    const commodityId = commodity?.commodityId ?? null;
    const commodityConfidence = commodity?.confidence ?? 0;
    const unitId = matchUnit(it.unitText, commodityId, ref.units);

    // `totalPriceKobo` is already `total ?? (unitPrice × qty)` from
    // toDraftItems (exact, fractional-quantity-safe) — trust it, don't
    // re-derive here with an integer-rounded quantity.
    const paidPriceKobo = it.totalPriceKobo;

    const complete =
      commodityId !== null &&
      unitId !== null &&
      it.quantity !== null &&
      it.quantity > 0 &&
      paidPriceKobo !== null &&
      paidPriceKobo > 0n;

    return {
      rawText: it.rawText,
      commodityId,
      commodityConfidence,
      unitId,
      quantity: it.quantity,
      paidPriceKobo,
      purchaseForm: "loose",
      // A weak commodity match is a suggestion, never a silent auto-fill —
      // it still shows, but the row is flagged for a human look.
      needsReview:
        !complete || it.confidence < 0.6 || commodityConfidence < COMMODITY_REVIEW_BAR,
    };
  });
}
