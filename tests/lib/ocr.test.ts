import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@/src/lib/supabase", () => ({
  supabase: { functions: { invoke: (...args: unknown[]) => invoke(...args) } },
}));

import { captureReceipts, MAX_IMAGES_PER_OCR_CALL } from "@/src/lib/ocr";
import { CONTRACT_ID } from "@/src/lib/ocr/extractionContract";

function fakeImageFile(name = "receipt.png"): File {
  return new File(["fake-image-bytes"], name, { type: "image/png" });
}

function validExtraction() {
  return {
    contract: CONTRACT_ID,
    notes: null,
    items: [
      {
        raw_text: "Rice 2kg 3600",
        name_guess: "rice",
        quantity: 2,
        unit_text: "kg",
        total_price_naira: 3600,
        unit_price_naira: 1800,
        confidence: 0.9,
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("captureReceipts", () => {
  it("rejects zero images without calling the function", async () => {
    const result = await captureReceipts([]);
    expect(result).toEqual({ kind: "error", message: expect.stringContaining("1 and 3") });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects more than MAX_IMAGES_PER_OCR_CALL without calling the function", async () => {
    const files = Array.from({ length: MAX_IMAGES_PER_OCR_CALL + 1 }, (_, i) =>
      fakeImageFile(`r${i}.png`),
    );
    const result = await captureReceipts(files);
    expect(result.kind).toBe("error");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("encodes files as data URIs and sends them to ocr-proxy", async () => {
    invoke.mockResolvedValue({ data: { extraction: validExtraction() }, error: null });
    await captureReceipts([fakeImageFile()]);

    expect(invoke).toHaveBeenCalledTimes(1);
    const [fnName, opts] = invoke.mock.calls[0] as [string, { body: { images: string[] } }];
    expect(fnName).toBe("ocr-proxy");
    expect(opts.body.images).toHaveLength(1);
    expect(opts.body.images[0]).toMatch(/^data:/);
  });

  it("maps a degrade response through with its reason", async () => {
    invoke.mockResolvedValue({
      data: { degrade: "manual_entry", reason: "budget_exhausted" },
      error: null,
    });
    const result = await captureReceipts([fakeImageFile()]);
    expect(result).toEqual({ kind: "degrade", reason: "budget_exhausted" });
  });

  it("validates a contract-shaped extraction into normalised draft items", async () => {
    invoke.mockResolvedValue({ data: { extraction: validExtraction() }, error: null });
    const result = await captureReceipts([fakeImageFile()]);
    expect(result.kind).toBe("extracted");
    if (result.kind !== "extracted") return;
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      rawText: "Rice 2kg 3600",
      nameGuess: "rice",
      quantity: 2,
      unitText: "kg",
      totalPriceKobo: 360000n, // 3600 naira -> kobo
      unitPriceKobo: 180000n,
    });
  });

  it("reports an off-contract payload as unreadable, without inventing a shape", async () => {
    invoke.mockResolvedValue({ data: { extraction: { anything: [1, 2, 3] } }, error: null });
    const result = await captureReceipts([fakeImageFile()]);
    expect(result).toEqual({ kind: "unreadable", extraction: { anything: [1, 2, 3] } });
  });

  it("surfaces an invoke-level error (network/auth) rather than swallowing it", async () => {
    invoke.mockResolvedValue({ data: null, error: new Error("unauthorized") });
    const result = await captureReceipts([fakeImageFile()]);
    expect(result).toEqual({ kind: "error", message: "unauthorized" });
  });

  it("an unrecognised response shape is reported as an error, not silently ignored", async () => {
    invoke.mockResolvedValue({ data: { something_unexpected: true }, error: null });
    const result = await captureReceipts([fakeImageFile()]);
    expect(result.kind).toBe("error");
  });
});
