import { describe, it, expect } from 'vitest';
import {
  DEFAULT_VISION_PRICING,
  MAX_IMAGES_PER_OCR_CALL,
  decideOcrGate,
  estimateOcrCostMicroUsd,
} from '@/src/lib/ocr/costModel';

describe('estimateOcrCostMicroUsd', () => {
  it('is a conservative integer micro-USD estimate', () => {
    const cost = estimateOcrCostMicroUsd({
      imageCount: 1,
      estimatedImageTokens: 1600,
      promptTokens: 400,
      maxOutputTokens: 1200,
    });
    // input 2000 tok * 3000/1k = 6000 ; output 1200 * 15000/1k = 18000 ; images 0
    expect(cost).toBe(24_000);
    expect(Number.isInteger(cost)).toBe(true);
  });

  it('rounds each component up (never under-reserves)', () => {
    const cost = estimateOcrCostMicroUsd(
      { imageCount: 1, estimatedImageTokens: 1, promptTokens: 0, maxOutputTokens: 1 },
      { inputPer1kMicroUsd: 3000, outputPer1kMicroUsd: 15000, perImageMicroUsd: 0 },
    );
    // ceil(1*3000/1000)=3 ; ceil(1*15000/1000)=15 → 18
    expect(cost).toBe(18);
  });

  it('adds a per-image charge when the provider bills images separately', () => {
    const cost = estimateOcrCostMicroUsd(
      { imageCount: 3, estimatedImageTokens: 0, promptTokens: 0, maxOutputTokens: 0 },
      { ...DEFAULT_VISION_PRICING, perImageMicroUsd: 2000 },
    );
    expect(cost).toBe(6000);
  });

  it('rejects an image count outside the per-call ceiling', () => {
    expect(() =>
      estimateOcrCostMicroUsd({
        imageCount: MAX_IMAGES_PER_OCR_CALL + 1,
        estimatedImageTokens: 0,
        promptTokens: 0,
        maxOutputTokens: 0,
      }),
    ).toThrow(RangeError);
    expect(() =>
      estimateOcrCostMicroUsd({
        imageCount: 0,
        estimatedImageTokens: 0,
        promptTokens: 0,
        maxOutputTokens: 0,
      }),
    ).toThrow(RangeError);
  });

  it('rejects non-integer or negative token counts', () => {
    expect(() =>
      estimateOcrCostMicroUsd({
        imageCount: 1,
        estimatedImageTokens: -1,
        promptTokens: 0,
        maxOutputTokens: 0,
      }),
    ).toThrow(RangeError);
    expect(() =>
      estimateOcrCostMicroUsd({
        imageCount: 1,
        estimatedImageTokens: 10.5,
        promptTokens: 0,
        maxOutputTokens: 0,
      }),
    ).toThrow(RangeError);
  });
});

describe('decideOcrGate', () => {
  it('dispatches only when ip, session and budget all pass', () => {
    expect(
      decideOcrGate({ ipAllowed: true, sessionAllowed: true, budgetReserved: true }),
    ).toEqual({ action: 'dispatch' });
  });

  it('rejects the individual caller on a rate limit', () => {
    expect(
      decideOcrGate({ ipAllowed: false, sessionAllowed: true, budgetReserved: true }),
    ).toEqual({ action: 'reject', reason: 'ip_rate_limited' });
    expect(
      decideOcrGate({ ipAllowed: true, sessionAllowed: false, budgetReserved: true }),
    ).toEqual({ action: 'reject', reason: 'session_rate_limited' });
  });

  it('degrades EVERYONE to manual entry when the global budget is exhausted', () => {
    expect(
      decideOcrGate({ ipAllowed: true, sessionAllowed: true, budgetReserved: false }),
    ).toEqual({ action: 'degrade_to_manual', reason: 'budget_exhausted' });
  });

  it('rate-limit rejection takes precedence over budget (cheaper signal first)', () => {
    expect(
      decideOcrGate({ ipAllowed: false, sessionAllowed: true, budgetReserved: false }),
    ).toEqual({ action: 'reject', reason: 'ip_rate_limited' });
  });
});
