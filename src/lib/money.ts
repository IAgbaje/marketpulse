/**
 * Money formatting. Naira with comma thousand separators, never "NGN"
 * (Handover §15.1). Formatting only — no arithmetic lives here; the engine
 * (src/engine) owns that.
 */

export function formatNaira(kobo: bigint): string {
  const negative = kobo < 0n;
  const abs = negative ? -kobo : kobo;
  const naira = abs / 100n;
  const koboRemainder = abs % 100n;

  const grouped = naira.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const decimals = koboRemainder.toString().padStart(2, "0");

  return `${negative ? "-" : ""}₦${grouped}.${decimals}`;
}

/**
 * Parses a user-entered naira amount into kobo. Accepts "1500", "1500.50",
 * and the grouped form `formatNaira` itself emits ("1,500.50") — a price
 * field pre-filled from `formatNaira` must round-trip, or editing a value
 * ≥ ₦1,000 would silently parse to null.
 */
export function parseNairaToKobo(input: string): bigint | null {
  const trimmed = input.replace(/,/g, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;

  const parts = trimmed.split(".");
  const wholePart = parts[0] ?? "0";
  const decimalPart = (parts[1] ?? "").padEnd(2, "0");
  return BigInt(wholePart) * 100n + BigInt(decimalPart);
}
