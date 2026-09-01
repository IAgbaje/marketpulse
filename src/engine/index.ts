/**
 * MarketPulse decomposition engine — public surface.
 *
 * Pure, client-side, no I/O. Consumes locally-synced `purchase_lines` already
 * aggregated to (commodity, complete-calendar-month) integer totals.
 */

export { decompose, assertTies } from './decomposition';
export {
  selectTier,
  projectToPriceEffect,
  toDisplayModel,
  type Tier,
  type TierInputs,
  type PriceEffectTier,
  type DecompositionDisplayModel,
} from './tiers';
export {
  detectSubstitutions,
  type SubstituteGroup,
  type SubstitutionNarrative,
} from './substitution';
export {
  roundHalfEvenRational,
  floorDiv,
  addRational,
} from './rational';
export type {
  CurrencyCode,
  CommodityPeriod,
  DecompositionInput,
  CommodityDecomposition,
  DecompositionClassification,
  Decomposition,
} from './types';
