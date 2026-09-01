/**
 * One market's published price board for a month — Market Detail's data
 * source (§4 stage 8, V1). Reads `price_aggregates` joined to `commodities`
 * for their display name; server-side RLS already makes both world-readable
 * (reference-data-equivalent), and this only ever selects PUBLISHED rows
 * (median_kobo not null) — below-floor buckets are never listed per-market
 * like this, same privacy rule as everywhere else (§7).
 */

import { supabase } from "./supabase.js";

export interface MarketCommodityBand {
  commodityId: string;
  canonicalName: string;
  medianKobo: bigint;
  p25Kobo: bigint;
  p75Kobo: bigint;
  gradeCaveat: boolean;
}

interface Row {
  commodity_id: string;
  median_kobo: number | string;
  p25_kobo: number | string;
  p75_kobo: number | string;
  grade_caveat: boolean;
  commodities: { canonical_name: string } | { canonical_name: string }[] | null;
}

export async function fetchMarketBands(marketId: string, periodMonth: string): Promise<MarketCommodityBand[]> {
  const { data, error } = await supabase
    .from("price_aggregates")
    .select("commodity_id, median_kobo, p25_kobo, p75_kobo, grade_caveat, commodities(canonical_name)")
    .eq("market_id", marketId)
    .eq("period_month", periodMonth)
    .not("median_kobo", "is", null)
    .order("median_kobo", { ascending: true });

  if (error) throw error;

  return (data as Row[]).map((r) => {
    const joined = Array.isArray(r.commodities) ? r.commodities[0] : r.commodities;
    return {
      commodityId: r.commodity_id,
      canonicalName: joined?.canonical_name ?? r.commodity_id,
      medianKobo: BigInt(r.median_kobo),
      p25Kobo: BigInt(r.p25_kobo),
      p75Kobo: BigInt(r.p75_kobo),
      gradeCaveat: r.grade_caveat,
    };
  });
}
