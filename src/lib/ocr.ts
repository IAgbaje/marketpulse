/**
 * Client wrapper for the `ocr-proxy` Edge Function (Stage 6, TR §6.1). Thin
 * on purpose — all the actual cost/rate-limit logic lives server-side
 * (supabase/functions/ocr-proxy, migration 20260831000003) so it can't be
 * bypassed by a modified client. This shapes the request and validates the
 * response against the OCR extraction contract (src/lib/ocr/extractionContract)
 * before handing anything downstream — an unrecognised payload is reported
 * honestly, never misparsed against a guessed shape.
 */

import { supabase } from "./supabase.js";
import {
  parseOcrExtraction,
  toDraftItems,
  type OcrDraftItem,
} from "./ocr/extractionContract.js";

export const MAX_IMAGES_PER_OCR_CALL = 3;

export type OcrResult =
  /** Budget/rate-limit exhausted, or the vision call failed — the DESIGNED
   *  fallback (US-1.2), not an error. */
  | { kind: "degrade"; reason: string }
  /** The model returned at least one usable line item, validated + currency-normalised. */
  | { kind: "extracted"; items: OcrDraftItem[]; notes: string | null }
  /** The model replied but nothing matched the contract — surface honestly,
   *  keep the photo, offer manual entry. */
  | { kind: "unreadable"; extraction: unknown }
  /** The call itself failed (network, auth). Retryable. */
  | { kind: "error"; message: string };

/**
 * `file.arrayBuffer()` + `btoa` rather than `FileReader.readAsDataURL` —
 * both are standard and available in the browser AND in Node (this is
 * exercised directly in tests, no browser/jsdom shim needed). Chunked to
 * avoid a call-stack blowout on `String.fromCharCode(...bytes)` for a
 * multi-megabyte photo.
 */
async function fileToDataUri(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const base64 = btoa(binary);
  return `data:${file.type || "application/octet-stream"};base64,${base64}`;
}

export async function captureReceipts(files: File[]): Promise<OcrResult> {
  if (files.length === 0 || files.length > MAX_IMAGES_PER_OCR_CALL) {
    return { kind: "error", message: `Choose between 1 and ${MAX_IMAGES_PER_OCR_CALL} photos.` };
  }

  let images: string[];
  try {
    images = await Promise.all(files.map(fileToDataUri));
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }

  const { data, error } = await supabase.functions.invoke<{
    degrade?: string;
    reason?: string;
    extraction?: unknown;
    error?: string;
  }>("ocr-proxy", { body: { images } });

  if (error) {
    return { kind: "error", message: error.message };
  }
  if (data?.degrade) {
    return { kind: "degrade", reason: data.reason ?? "unavailable" };
  }
  if (data && "extraction" in data) {
    const parsed = parseOcrExtraction(data.extraction);
    if (!parsed) return { kind: "unreadable", extraction: data.extraction };
    return { kind: "extracted", items: toDraftItems(parsed), notes: parsed.notes };
  }
  return { kind: "error", message: "Unexpected response from the photo scanner." };
}
