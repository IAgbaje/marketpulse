import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@/src/lib/supabase", () => ({
  supabase: { functions: { invoke: (...args: unknown[]) => invoke(...args) } },
}));

import { captureReceipts, MAX_IMAGES_PER_OCR_CALL } from "@/src/lib/ocr";

function fakeImageFile(name = "receipt.png"): File {
  return new File(["fake-image-bytes"], name, { type: "image/png" });
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
    const files = Array.from({ length: MAX_IMAGES_PER_OCR_CALL + 1 }, (_, i) => fakeImageFile(`r${i}.png`));
    const result = await captureReceipts(files);
    expect(result.kind).toBe("error");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("encodes files as data URIs and sends them to ocr-proxy", async () => {
    invoke.mockResolvedValue({ data: { extraction: { raw: "ok" } }, error: null });
    await captureReceipts([fakeImageFile()]);

    expect(invoke).toHaveBeenCalledTimes(1);
    const [fnName, opts] = invoke.mock.calls[0] as [string, { body: { images: string[] } }];
    expect(fnName).toBe("ocr-proxy");
    expect(opts.body.images).toHaveLength(1);
    expect(opts.body.images[0]).toMatch(/^data:/);
  });

  it("maps a degrade response through with its reason", async () => {
    invoke.mockResolvedValue({ data: { degrade: "manual_entry", reason: "budget_exhausted" }, error: null });
    const result = await captureReceipts([fakeImageFile()]);
    expect(result).toEqual({ kind: "degrade", reason: "budget_exhausted" });
  });

  it("maps an extraction response through opaquely, without inventing a shape", async () => {
    invoke.mockResolvedValue({ data: { extraction: { anything: [1, 2, 3] } }, error: null });
    const result = await captureReceipts([fakeImageFile()]);
    expect(result).toEqual({ kind: "extraction", extraction: { anything: [1, 2, 3] } });
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
