/**
 * Weekly report (§4 stage 9, `/reports/weekly`) — a PERSONAL recap, not a
 * crowd price trend. `price_aggregates` only aggregates by calendar MONTH
 * (migration 20260831000001) — there is no weekly crowd bucket anywhere in
 * the schema. Building a "week-over-week crowd price" view would mean
 * either fabricating a weekly figure out of a monthly one (misleading —
 * different granularities, would silently misstate real price movement) or
 * adding a whole second aggregation granularity to the schema (a real,
 * separate architecture decision, not a report-screen concern). Neither is
 * done here. What's real and available now: the user's own last 7 days of
 * purchases vs the 7 before that — local data, no schema change needed.
 */

import { db } from "./db.js";
import { getTripLines } from "./trips.js";

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export interface CommodityTotal {
  commodityId: string;
  spentKobo: bigint;
}

export interface WeeklyReport {
  thisWeekSpentKobo: bigint;
  lastWeekSpentKobo: bigint;
  thisWeekTripCount: number;
  topCommodities: CommodityTotal[];
}

export async function computeWeeklyReport(userId: string): Promise<WeeklyReport> {
  const today = daysAgoIso(0);
  const weekAgo = daysAgoIso(7);
  const twoWeeksAgo = daysAgoIso(14);

  const thisWeekTrips = await db.trips
    .where("userId")
    .equals(userId)
    .filter((t) => !t.isDraft && t.tripDate >= weekAgo && t.tripDate < today)
    .toArray();
  const thisWeekLines = (await Promise.all(thisWeekTrips.map((t) => getTripLines(t.id)))).flat();

  const lastWeekTrips = await db.trips
    .where("userId")
    .equals(userId)
    .filter((t) => !t.isDraft && t.tripDate >= twoWeeksAgo && t.tripDate < weekAgo)
    .toArray();
  const lastWeekLines = (await Promise.all(lastWeekTrips.map((t) => getTripLines(t.id)))).flat();

  const thisWeekSpentKobo = thisWeekLines.reduce((sum, l) => sum + BigInt(l.paidPriceKobo), 0n);
  const lastWeekSpentKobo = lastWeekLines.reduce((sum, l) => sum + BigInt(l.paidPriceKobo), 0n);

  const totals = new Map<string, bigint>();
  for (const l of thisWeekLines) {
    totals.set(l.commodityId, (totals.get(l.commodityId) ?? 0n) + BigInt(l.paidPriceKobo));
  }
  const topCommodities = [...totals.entries()]
    .map(([commodityId, spentKobo]) => ({ commodityId, spentKobo }))
    .sort((a, b) => (a.spentKobo < b.spentKobo ? 1 : -1))
    .slice(0, 5);

  return {
    thisWeekSpentKobo,
    lastWeekSpentKobo,
    thisWeekTripCount: thisWeekTrips.length,
    topCommodities,
  };
}

/** Plain-text summary for the Share button — no PII beyond what the user is actively sharing themselves. */
export function formatShareText(report: WeeklyReport, formatNaira: (k: bigint) => string): string {
  const lines = [
    `My week on MarketPulse: ${formatNaira(report.thisWeekSpentKobo)} across ${report.thisWeekTripCount} shop${report.thisWeekTripCount === 1 ? "" : "s"}.`,
  ];
  if (report.lastWeekSpentKobo > 0n) {
    const diff = report.thisWeekSpentKobo - report.lastWeekSpentKobo;
    lines.push(diff === 0n ? "Same as last week." : `${diff > 0n ? "Up" : "Down"} ${formatNaira(diff < 0n ? -diff : diff)} from last week.`);
  }
  return lines.join(" ");
}
