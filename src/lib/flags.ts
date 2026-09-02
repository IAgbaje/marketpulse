/**
 * Feature flags — deliberately the smallest thing that works.
 *
 * No service, no network, no per-user targeting. A flag's value is resolved,
 * in precedence order:
 *
 *   1. a `localStorage` override  — for flipping a flag on one device (a
 *      reviewer's phone) without a redeploy; set via `setFlagOverride`.
 *   2. a build-time env var       — `VITE_FLAG_<NAME>` = "true" | "1".
 *   3. the registered default.
 *
 * Add a flag by adding one entry to `REGISTRY`. That entry is the whole
 * contract — name, default, env key and why it exists — so a flag can never
 * be a bare string scattered through the codebase.
 */

interface FlagDef {
  /** Build-time override: import.meta.env[envKey] === "true" | "1". */
  envKey: string;
  default: boolean;
  description: string;
}

const REGISTRY = {
  /**
   * Stage 5b — the full PRICE / WHAT-YOU-BOUGHT / basket-change / excluded
   * decomposition on the budget screen. Off by default: the engine and the
   * display model are done and tested, but §7.7 gates the fuller view behind
   * ≥ 2 complete months AND this flag, so most users stay on the price-effect
   * tier until it is deliberately turned on.
   */
  fullDecompositionSplit: {
    envKey: "VITE_FLAG_FULL_DECOMPOSITION_SPLIT",
    default: false,
    description: "Stage 5b: full budget decomposition split (price / what-you-bought / basket / excluded).",
  },
} satisfies Record<string, FlagDef>;

export type FlagName = keyof typeof REGISTRY;

const OVERRIDE_PREFIX = "mp.flag.";

function readOverride(name: FlagName): boolean | null {
  try {
    const raw = localStorage.getItem(OVERRIDE_PREFIX + name);
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    return null;
  } catch {
    return null; // storage unavailable / blocked — fall through to env + default
  }
}

function readEnv(envKey: string): boolean | null {
  const v = import.meta.env[envKey];
  if (v === "true" || v === "1" || v === true) return true;
  if (v === "false" || v === "0" || v === false) return false;
  return null;
}

/** Resolve a flag now. Cheap — safe to call per render or per effect. */
export function flag(name: FlagName): boolean {
  const def = REGISTRY[name];
  return readOverride(name) ?? readEnv(def.envKey) ?? def.default;
}

/** Persist a per-device override (or clear it with `null`). */
export function setFlagOverride(name: FlagName, value: boolean | null): void {
  try {
    if (value === null) localStorage.removeItem(OVERRIDE_PREFIX + name);
    else localStorage.setItem(OVERRIDE_PREFIX + name, String(value));
  } catch {
    /* no-op: a device that can't persist an override just uses env + default */
  }
}

/** For a debug surface: every flag and how it currently resolves. */
export function allFlags(): { name: FlagName; value: boolean; description: string }[] {
  return (Object.keys(REGISTRY) as FlagName[]).map((name) => ({
    name,
    value: flag(name),
    description: REGISTRY[name].description,
  }));
}
