/**
 * Unit conversion — loosely-matched market units with per-entry confidence
 * (Handover §8.4). `factorToBase` multiplies a user-entered quantity to reach
 * integer base units (grams / millilitres / pieces x 1000).
 *
 * factorToBase is stored as a float in Postgres/Dexie (display/config data,
 * not money), but the conversion result is always rounded to an integer
 * before it becomes qty_in_base_unit — that integer is the only value the
 * decomposition engine ever sees.
 */

import type { LocalUnit } from "./db.js";

export function toBaseUnits(quantity: number, unit: LocalUnit): bigint {
  if (quantity <= 0) {
    throw new Error("toBaseUnits: quantity must be positive");
  }
  const base = quantity * unit.factorToBase;
  return BigInt(Math.round(base));
}
