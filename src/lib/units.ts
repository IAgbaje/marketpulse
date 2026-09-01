/**
 * Unit conversion — loosely-matched market units with per-entry confidence
 * (Handover §8.4). `factorNum`/`factorDen` multiply a user-entered quantity
 * to reach integer base units (grams / millilitres / pieces x 1000).
 *
 * `commodity_units.factor_num`/`factor_den` are an EXACT rational (server
 * schema §1.3) — never a float. The quantity the user types is scaled to a
 * 4-decimal-place integer (matching the server's `qty_entered numeric(14,4)`)
 * and the whole conversion is carried as an exact BigInt rational, rounded
 * once with the same ROUND_HALF_EVEN policy the decomposition engine uses —
 * that integer is the only value that becomes `qty_in_base_unit`.
 */

import { roundHalfEvenRational } from "../engine/rational.js";
import type { LocalUnit } from "./db.js";

const QTY_SCALE = 10_000n; // matches numeric(14,4)

export function toBaseUnits(quantity: number, unit: LocalUnit): bigint {
  if (quantity <= 0) {
    throw new Error("toBaseUnits: quantity must be positive");
  }
  if (!Number.isFinite(quantity)) {
    throw new Error("toBaseUnits: quantity must be finite");
  }

  const quantityScaled = BigInt(Math.round(quantity * Number(QTY_SCALE)));
  const factorNum = BigInt(unit.factorNum);
  const factorDen = BigInt(unit.factorDen);

  // quantity * factorNum / factorDen, with quantity itself scaled by 1e4 —
  // divide that scale back out in the same rational, one rounding operation.
  const numerator = quantityScaled * factorNum;
  const denominator = QTY_SCALE * factorDen;
  return roundHalfEvenRational(numerator, denominator);
}
