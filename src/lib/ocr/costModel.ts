/**
 * OCR vision-model cost model (Technical Requirements §6.1).
 *
 * Pure. Turns a request shape into an integer micro-USD estimate the circuit
 * breaker reserves BEFORE dispatch, and reconciles to actual after. Money is
 * integer minor units end to end — here the unit is micro-USD (1e-6 USD),
 * because vision pricing is sub-cent per image. No floats past ingestion.
 *
 * Pricing is configuration, not a constant baked into logic — pass the current
 * `VisionPricing` in. Defaults reflect a typical mid-2026 vision model; verify
 * against the provider's live price sheet before launch (flagged, not resolved).
 */

export interface VisionPricing {
  /** Micro-USD per 1,000 input tokens. */
  inputPer1kMicroUsd: number;
  /** Micro-USD per 1,000 output tokens. */
  outputPer1kMicroUsd: number;
  /** Flat micro-USD per image, if the provider bills images separately from tokens. */
  perImageMicroUsd: number;
}

export const DEFAULT_VISION_PRICING: VisionPricing = {
  inputPer1kMicroUsd: 3000, // $0.003 / 1k input tokens
  outputPer1kMicroUsd: 15000, // $0.015 / 1k output tokens
  perImageMicroUsd: 0,
};

export interface OcrRequestShape {
  /** Number of receipt images in the request. MarketPulse caps this per call. */
  imageCount: number;
  /** Approx tokens the image(s) will occupy once tiled — provider-specific. */
  estimatedImageTokens: number;
  /** Prompt scaffold tokens (fixed instruction block). */
  promptTokens: number;
  /** Upper bound on the structured extraction we allow the model to return. */
  maxOutputTokens: number;
}

/** The per-call ceiling MarketPulse enforces before this function is even reached. */
export const MAX_IMAGES_PER_OCR_CALL = 3;

/**
 * Conservative (over-)estimate of a single OCR call's cost in integer micro-USD.
 * Over-estimating is deliberate: the breaker reserves this, and
 * `reconcile_ocr_spend` refunds the difference once the real usage is known, so
 * the system never dispatches a call it could not afford.
 */
export function estimateOcrCostMicroUsd(
  req: OcrRequestShape,
  pricing: VisionPricing = DEFAULT_VISION_PRICING,
): number {
  if (req.imageCount < 1 || req.imageCount > MAX_IMAGES_PER_OCR_CALL) {
    throw new RangeError(
      `estimateOcrCostMicroUsd: imageCount ${req.imageCount} outside 1..${MAX_IMAGES_PER_OCR_CALL}`,
    );
  }
  for (const [k, v] of Object.entries(req)) {
    if (!Number.isInteger(v) || v < 0) {
      throw new RangeError(`estimateOcrCostMicroUsd: ${k} must be a non-negative integer, got ${v}`);
    }
  }

  const inputTokens = req.estimatedImageTokens + req.promptTokens;
  const inputCost = Math.ceil((inputTokens * pricing.inputPer1kMicroUsd) / 1000);
  const outputCost = Math.ceil((req.maxOutputTokens * pricing.outputPer1kMicroUsd) / 1000);
  const imageCost = req.imageCount * pricing.perImageMicroUsd;

  return inputCost + outputCost + imageCost;
}

export interface OcrGateInputs {
  ipAllowed: boolean;
  sessionAllowed: boolean;
  budgetReserved: boolean;
}

export type OcrGateDecision =
  | { action: 'dispatch' }
  | { action: 'reject'; reason: 'ip_rate_limited' | 'session_rate_limited' }
  | { action: 'degrade_to_manual'; reason: 'budget_exhausted' };

/**
 * Final gate before dispatch. Budget exhaustion degrades to manual entry for
 * EVERYONE (US-1.2 fallback) rather than rejecting the individual — that is the
 * behaviour that actually bounds cost. Rate limits reject the individual caller.
 */
export function decideOcrGate(inputs: OcrGateInputs): OcrGateDecision {
  if (!inputs.ipAllowed) return { action: 'reject', reason: 'ip_rate_limited' };
  if (!inputs.sessionAllowed) return { action: 'reject', reason: 'session_rate_limited' };
  if (!inputs.budgetReserved) return { action: 'degrade_to_manual', reason: 'budget_exhausted' };
  return { action: 'dispatch' };
}
