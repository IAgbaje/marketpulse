/**
 * Reads from `price_aggregates` — the privacy-floored crowd band (§7): rows
 * exist per (commodity, market, month), with p25/median/p75 populated only
 * once a bucket has cleared >= 5 distinct users after per-day dedupe; below
 * that floor the row exists (bookkeeping) but the band columns are NULL.
 * Never read raw `purchase_lines` for this — always this materialised table.
 */

import { supabase } from "./supabase.js";

export interface CrowdBandRow {
  marketId: string;
  periodMonth: string; // ISO date, first of month
  distinctUserCount: number;
  p25Kobo: bigint | null;
  medianKobo: bigint | null;
  p75Kobo: bigint | null;
  gradeCaveat: boolean;
}

interface PriceAggregateRow {
  market_id: string;
  period_month: string;
  distinct_user_count: number;
  p25_kobo: number | string | null;
  median_kobo: number | string | null;
  p75_kobo: number | string | null;
  grade_caveat: boolean;
}

/** Every published (or below-floor) bucket for a commodity, newest month first. */
export async function fetchCrowdBands(commodityId: string): Promise<CrowdBandRow[]> {
  const { data, error } = await supabase
    .from("price_aggregates")
    .select("market_id, period_month, distinct_user_count, p25_kobo, median_kobo, p75_kobo, grade_caveat")
    .eq("commodity_id", commodityId)
    .order("period_month", { ascending: false });

  if (error) throw error;

  return (data as PriceAggregateRow[]).map((r) => ({
    marketId: r.market_id,
    periodMonth: r.period_month,
    distinctUserCount: r.distinct_user_count,
    p25Kobo: r.p25_kobo === null ? null : BigInt(r.p25_kobo),
    medianKobo: r.median_kobo === null ? null : BigInt(r.median_kobo),
    p75Kobo: r.p75_kobo === null ? null : BigInt(r.p75_kobo),
    gradeCaveat: r.grade_caveat,
  }));
}
