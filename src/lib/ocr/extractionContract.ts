/**
 * OCR extraction contract (Stage 6, Technical Requirements §6.1).
 *
 * The vision model's response shape is not defined by any upstream doc — so
 * MarketPulse defines it here and OWNS BOTH ENDS: `ocr-proxy` instructs the
 * model to emit exactly this JSON (`VISION_INSTRUCTION` + `VISION_JSON_SCHEMA`),
 * and every consumer (proxy + client) validates against `parseOcrExtraction`
 * before trusting a single field. Anything that doesn't match is rejected
 * whole — a real receipt is never silently misparsed against a guessed shape.
 *
 * Pure, no I/O — shared by the Deno Edge Function and the browser client the
 * same way `costModel.ts` is. Versioned (`CONTRACT_ID`) so a future shape
 * change is a new id, not a mutation.
 *
 * Money: the model reports naira as printed on the receipt; we convert to
 * integer kobo AT THIS BOUNDARY (nearest kobo — a displayed price, not
 * financial arithmetic; the user confirms every line downstream anyway).
 */

export const CONTRACT_ID = "marketpulse.ocr.extraction.v1";

/** One line as the vision model read it. All fields but `raw_text`/`confidence` may be null. */
export interface OcrExtractionItem {
  raw_text: string;
  name_guess: string | null;
  quantity: number | null;
  unit_text: string | null;
  total_price_naira: number | null;
  unit_price_naira: number | null;
  /** Model's self-rated legibility for this line, 0..1. */
  confidence: number;
}

export interface OcrExtractionV1 {
  contract: typeof CONTRACT_ID;
  items: OcrExtractionItem[];
  notes: string | null;
}

/** Post-validation, currency-normalised. Commodity/unit matching happens later
 *  (src/lib/ocrMapping.ts) — kept out of here so this module stays I/O-free. */
export interface OcrDraftItem {
  rawText: string;
  nameGuess: string | null;
  quantity: number | null;
  unitText: string | null;
  totalPriceKobo: bigint | null;
  unitPriceKobo: bigint | null;
  /** 0..1, clamped. */
  confidence: number;
}

/** Instruction sent to the vision model. Deliberately explicit about Nigerian
 *  open-market reality (loose units, handwritten lists, no receipt). */
export const VISION_INSTRUCTION = [
  "You are reading a Nigerian shopping receipt or a handwritten/printed shopping list.",
  "Extract every distinct purchased line item. Return STRICT JSON only, no prose, matching this shape:",
  `{"contract":"${CONTRACT_ID}","items":[{"raw_text":string,"name_guess":string|null,`,
  `"quantity":number|null,"unit_text":string|null,"total_price_naira":number|null,`,
  `"unit_price_naira":number|null,"confidence":number}],"notes":string|null}`,
  "Rules:",
  "- raw_text: the line exactly as printed/written, trimmed.",
  "- name_guess: the plain commodity name in English (e.g. 'rice', 'tomatoes', 'palm oil'); null if illegible.",
  "- quantity/unit_text: the amount and its unit as written ('2', 'kg' / '1', 'paint' / '3', 'derica'); null if absent.",
  "- total_price_naira: the line's total price in naira as a number, no currency symbol, no thousands separators; null if absent.",
  "- unit_price_naira: per-unit price in naira if the line shows one separately; else null.",
  "- confidence: your legibility confidence for THIS line, 0 to 1.",
  "- Do NOT invent items, prices or quantities. Omit subtotals, totals, change, VAT and store metadata.",
  "- notes: anything the reader should know (e.g. 'handwritten, faint'); else null.",
].join("\n");

/** JSON schema for providers that accept a response_format/tool schema. */
export const VISION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["contract", "items", "notes"],
  properties: {
    contract: { const: CONTRACT_ID },
    notes: { type: ["string", "null"] },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "raw_text",
          "name_guess",
          "quantity",
          "unit_text",
          "total_price_naira",
          "unit_price_naira",
          "confidence",
        ],
        properties: {
          raw_text: { type: "string" },
          name_guess: { type: ["string", "null"] },
          quantity: { type: ["number", "null"] },
          unit_text: { type: ["string", "null"] },
          total_price_naira: { type: ["number", "null"] },
          unit_price_naira: { type: ["number", "null"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
  },
} as const;

// --- validation -------------------------------------------------------------

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function asNullableString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * A single line's quantity or price. Rejects non-positive, and rejects an
 * absurd magnitude outright — a receipt line is never a trillion naira or a
 * billion kg, and an unbounded value can overflow `naira * 100` to Infinity
 * and make `BigInt(Math.round(...))` throw.
 */
const MAX_LINE_MAGNITUDE = 1e12;
function asNullablePositiveNumber(v: unknown): number | null {
  return isFiniteNumber(v) && v > 0 && v < MAX_LINE_MAGNITUDE ? v : null;
}

/** Hard cap on line items parsed from one reply — a real receipt has dozens,
 *  not thousands; an adversarial reply could otherwise freeze the render. */
const MAX_ITEMS = 100;

/**
 * Accepts the raw upstream payload (already-parsed object, a JSON string, or a
 * provider envelope like `{extraction: {...}}` / `{output: "...json..."}`) and
 * returns a validated `OcrExtractionV1`, or `null` if it cannot be trusted.
 *
 * Tolerant on the OUTER shape (providers wrap responses differently), strict on
 * the INNER contract (every item must have a usable `raw_text`).
 */
export function parseOcrExtraction(payload: unknown): OcrExtractionV1 | null {
  let root: unknown = payload;

  // Unwrap common provider envelopes / stringified bodies, a few levels deep.
  for (let depth = 0; depth < 4 && root != null; depth++) {
    if (typeof root === "string") {
      try {
        root = JSON.parse(root);
        continue;
      } catch {
        return null;
      }
    }
    if (typeof root === "object") {
      const obj = root as Record<string, unknown>;
      if (Array.isArray(obj["items"])) break;
      // OpenAI-style chat envelope: choices[0].message.content (a JSON string).
      if (Array.isArray(obj["choices"])) {
        const first = obj["choices"][0] as Record<string, unknown> | undefined;
        const msg = first?.["message"] as Record<string, unknown> | undefined;
        const next = msg?.["content"] ?? first?.["text"];
        if (next != null) {
          root = next;
          continue;
        }
      }
      const nextKey = ["extraction", "output", "result", "data", "json", "content", "message"].find(
        (k) => obj[k] != null && typeof obj[k] !== "number",
      );
      if (!nextKey) break;
      root = obj[nextKey];
      continue;
    }
    break;
  }

  if (typeof root !== "object" || root === null) return null;
  const obj = root as Record<string, unknown>;
  if (!Array.isArray(obj["items"])) return null;

  const items: OcrExtractionItem[] = [];
  for (const raw of (obj["items"] as unknown[]).slice(0, MAX_ITEMS)) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const rawText = asNullableString(r["raw_text"]) ?? asNullableString(r["name_guess"]);
    if (!rawText) continue; // a line we can't even label is not a line

    const confidence = isFiniteNumber(r["confidence"])
      ? Math.min(1, Math.max(0, r["confidence"]))
      : 0.3; // unstated ⇒ treat as low, not high

    items.push({
      raw_text: rawText,
      name_guess: asNullableString(r["name_guess"]),
      quantity: asNullablePositiveNumber(r["quantity"]),
      unit_text: asNullableString(r["unit_text"]),
      total_price_naira: asNullablePositiveNumber(r["total_price_naira"]),
      unit_price_naira: asNullablePositiveNumber(r["unit_price_naira"]),
      confidence,
    });
  }

  if (items.length === 0) return null;

  return {
    contract: CONTRACT_ID,
    items,
    notes: asNullableString(obj["notes"]),
  };
}

/** Nearest-kobo conversion of a printed naira amount. Boundary conversion only. */
export function nairaToKobo(naira: number | null): bigint | null {
  if (naira === null || !Number.isFinite(naira) || naira <= 0 || naira >= MAX_LINE_MAGNITUDE) {
    return null;
  }
  const kobo = Math.round(naira * 100);
  return Number.isFinite(kobo) ? BigInt(kobo) : null;
}

/** Validated extraction → currency-normalised draft items. */
export function toDraftItems(extraction: OcrExtractionV1): OcrDraftItem[] {
  return extraction.items.map((it) => {
    const total = nairaToKobo(it.total_price_naira);
    const unit = nairaToKobo(it.unit_price_naira);
    // Derive the missing side where the other two are known.
    const derivedTotal =
      total ?? (unit !== null && it.quantity !== null && it.quantity > 0
        ? BigInt(Math.round(Number(unit) * it.quantity))
        : null);
    return {
      rawText: it.raw_text,
      nameGuess: it.name_guess,
      quantity: it.quantity,
      unitText: it.unit_text,
      totalPriceKobo: derivedTotal,
      unitPriceKobo: unit,
      confidence: it.confidence,
    };
  });
}
