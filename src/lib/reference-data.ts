/**
 * Reference-data sync: commodities, commodity_aliases, commodity_units,
 * locations are read-only reference tables (server schema §1). Cached into
 * Dexie so capture and autocomplete work offline (Handover §9.1).
 *
 * This is a pull-and-replace, not incremental: reference data is small
 * (dozens to low hundreds of rows at MVP scale) and changes rarely, so a full
 * refresh on each app boot is simpler and cheaper than diffing.
 */

import { supabase } from "./supabase.js";
import {
  db,
  type LocalAlias,
  type LocalCommodity,
  type LocalLocation,
  type LocalUnit,
} from "./db.js";

interface CommodityRow {
  id: string;
  canonical_name: string;
  category: string;
  base_unit: LocalCommodity["baseUnit"];
  substitute_group: string | null;
  perishable: boolean;
  grade_sensitive: boolean;
}

interface AliasRow {
  commodity_id: string;
  alias: string;
}

interface UnitRow {
  id: string;
  unit_code: string;
  to_base_unit: LocalUnit["toBaseUnit"];
  commodity_id: string | null;
  factor_num: number | string;
  factor_den: number | string;
  confidence: LocalUnit["confidence"];
}

interface LocationRow {
  id: string;
  parent_id: string | null;
  level: LocalLocation["level"];
  name: string;
  market_type: LocalLocation["marketType"];
}

export async function refreshReferenceData(): Promise<void> {
  const [commodities, aliases, units, locations] = await Promise.all([
    supabase
      .from("commodities")
      .select("id, canonical_name, category, base_unit, substitute_group, perishable, grade_sensitive")
      .eq("retired", false)
      .eq("provisional", false),
    supabase.from("commodity_aliases").select("commodity_id, alias"),
    supabase.from("commodity_units").select("id, unit_code, to_base_unit, commodity_id, factor_num, factor_den, confidence"),
    supabase.from("locations").select("id, parent_id, level, name, market_type"),
  ]);

  if (commodities.error) throw commodities.error;
  if (aliases.error) throw aliases.error;
  if (units.error) throw units.error;
  if (locations.error) throw locations.error;

  const localCommodities: LocalCommodity[] = (commodities.data as CommodityRow[]).map((c) => ({
    id: c.id,
    canonicalName: c.canonical_name,
    category: c.category,
    baseUnit: c.base_unit,
    substituteGroup: c.substitute_group,
    perishable: c.perishable,
    gradeSensitive: c.grade_sensitive,
    provisional: false,
  }));

  const localAliases: LocalAlias[] = (aliases.data as AliasRow[]).map((a) => ({
    commodityId: a.commodity_id,
    alias: a.alias,
  }));

  const localUnits: LocalUnit[] = (units.data as UnitRow[]).map((u) => ({
    id: u.id,
    unitCode: u.unit_code,
    toBaseUnit: u.to_base_unit,
    commodityId: u.commodity_id,
    factorNum: String(u.factor_num),
    factorDen: String(u.factor_den),
    confidence: u.confidence,
  }));

  const localLocations: LocalLocation[] = (locations.data as LocationRow[]).map((l) => ({
    id: l.id,
    parentId: l.parent_id,
    level: l.level,
    name: l.name,
    marketType: l.market_type,
  }));

  await db.transaction(
    "rw",
    db.commodities,
    db.aliases,
    db.units,
    db.locations,
    async () => {
      await db.commodities.clear();
      await db.aliases.clear();
      await db.units.clear();
      await db.locations.clear();
      await db.commodities.bulkAdd(localCommodities);
      await db.aliases.bulkAdd(localAliases);
      await db.units.bulkAdd(localUnits);
      await db.locations.bulkAdd(localLocations);
    },
  );
}

/** True once at least one commodity has been cached — cheap boot-time check. */
export async function hasReferenceData(): Promise<boolean> {
  return (await db.commodities.count()) > 0;
}
