import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { flag, setFlagOverride, allFlags } from "@/src/lib/flags";

/** Minimal in-memory localStorage for the override path (node test env has none). */
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  // @ts-expect-error test cleanup
  delete globalThis.localStorage;
});

describe("flag()", () => {
  it("returns the registered default when nothing overrides it", () => {
    expect(flag("fullDecompositionSplit")).toBe(false);
  });

  it("honours a build-time env var", () => {
    vi.stubEnv("VITE_FLAG_FULL_DECOMPOSITION_SPLIT", "true");
    expect(flag("fullDecompositionSplit")).toBe(true);
    vi.stubEnv("VITE_FLAG_FULL_DECOMPOSITION_SPLIT", "0");
    expect(flag("fullDecompositionSplit")).toBe(false);
  });

  it("a per-device override beats both env and default", () => {
    globalThis.localStorage = new MemStorage() as unknown as Storage;
    vi.stubEnv("VITE_FLAG_FULL_DECOMPOSITION_SPLIT", "false");

    setFlagOverride("fullDecompositionSplit", true);
    expect(flag("fullDecompositionSplit")).toBe(true);

    setFlagOverride("fullDecompositionSplit", null); // cleared → falls back to env
    expect(flag("fullDecompositionSplit")).toBe(false);
  });

  it("never throws when storage access is blocked", () => {
    globalThis.localStorage = {
      getItem() {
        throw new Error("SecurityError");
      },
      setItem() {
        throw new Error("SecurityError");
      },
      removeItem() {
        throw new Error("SecurityError");
      },
    } as unknown as Storage;
    expect(() => flag("fullDecompositionSplit")).not.toThrow();
    expect(() => setFlagOverride("fullDecompositionSplit", true)).not.toThrow();
    expect(flag("fullDecompositionSplit")).toBe(false);
  });
});

describe("allFlags()", () => {
  it("lists every registered flag with its resolved value", () => {
    const names = allFlags().map((f) => f.name);
    expect(names).toContain("fullDecompositionSplit");
    for (const f of allFlags()) expect(typeof f.value).toBe("boolean");
  });
});
