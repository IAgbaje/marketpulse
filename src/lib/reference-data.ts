/**
 * Reference-data sync: commodities, units, locations are read-only reference
 * tables (Phase 0 content, currently stub — see the seed migration). Cached
 * into Dexie so capture and autocomplete work offline (Handover §9.1).
 *
 * This is a pull-and-replace, not incremental: reference data is small
 * (dozens to low hundreds of rows at MVP scale) and changes rarely, so a full
 * refresh on each app boot is simpler and cheaper than diffing.
 */

import { supabase } from "./supabase.js";
import { db, type LocalCommodity, type LocalLocation, type LocalUnit } from "./db.js";

interface CommodityRow {
  id: string;
  slug: string;
  name: string;
  category: string;
  substitute_group: string | null;
  default_unit_id: string | null;
}

interface UnitRow {
  id: string;
  commodity_id: string;
  unit_name: string;
  factor_to_base: number;
  conversion_confidence: number;
}

interface LocationRow {
  id: string;
  parent_id: string | null;
  level: LocalLocation["level"];
  name: string;
  market_type: LocalLocation["marketType"];
}

export async function refreshReferenceData(): Promise<void> {
  const [commodities, units, locations] = await Promise.all([
    supabase.from("commodities").select("id, slug, name, category, substitute_group, default_unit_id"),
    supabase.from("commodity_units").select("id, commodity_id, unit_name, factor_to_base, conversion_confidence"),
    supabase.from("locations").select("id, parent_id, level, name, market_type"),
  ]);

  if (commodities.error) throw commodities.error;
  if (units.error) throw units.error;
  if (locations.error) throw locations.error;

  const localCommodities: LocalCommodity[] = (commodities.data as CommodityRow[]).map((c) => ({
    id: c.id,
    slug: c.slug,
    name: c.name,
    category: c.category,
    substituteGroup: c.substitute_group,
    defaultUnitId: c.default_unit_id,
  }));

  const localUnits: LocalUnit[] = (units.data as UnitRow[]).map((u) => ({
    id: u.id,
    commodityId: u.commodity_id,
    unitName: u.unit_name,
    factorToBase: u.factor_to_base,
    conversionConfidence: u.conversion_confidence,
  }));

  const localLocations: LocalLocation[] = (locations.data as LocationRow[]).map((l) => ({
    id: l.id,
    parentId: l.parent_id,
    level: l.level,
    name: l.name,
    marketType: l.market_type,
  }));

  await db.transaction("rw", db.commodities, db.units, db.locations, async () => {
    await db.commodities.clear();
    await db.units.clear();
    await db.locations.clear();
    await db.commodities.bulkAdd(localCommodities);
    await db.units.bulkAdd(localUnits);
    await db.locations.bulkAdd(localLocations);
  });
}

/** True once at least one commodity has been cached — cheap boot-time check. */
export async function hasReferenceData(): Promise<boolean> {
  return (await db.commodities.count()) > 0;
}
