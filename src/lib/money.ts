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

/** Parses a user-entered naira amount (e.g. "1500", "1500.50") into kobo. */
export function parseNairaToKobo(input: string): bigint | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;

  const parts = trimmed.split(".");
  const wholePart = parts[0] ?? "0";
  const decimalPart = (parts[1] ?? "").padEnd(2, "0");
  return BigInt(wholePart) * 100n + BigInt(decimalPart);
}
