/**
 * Budget CRUD (Stage 5, screens 9/10). Local-first, same pattern as
 * trips/lines: written to Dexie immediately, drained to Supabase by the
 * sync queue (src/lib/sync.ts) — never a direct network call from a screen.
 */

import { db, type LocalBudget, type SyncStatus } from "./db.js";
import { getTripLines, listRecentTrips } from "./trips.js";

function newId(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

/** First day of the calendar month containing `date` (default: today), as an ISO date. */
export function monthStart(date: Date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

function addMonths(monthStartIso: string, delta: number): string {
  const d = new Date(monthStartIso + "T00:00:00Z");
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1)).toISOString().slice(0, 10);
}

/**
 * Screen 9's suggested starting figure: the latest trip's total. Doc says
 * "derived from latest trip" — literally the most recent single trip, not
 * an average, so that's what this returns. Null if the user has no trips
 * yet (budget setup is still reachable, just starts blank).
 */
export async function suggestBudgetFromLatestTrip(userId: string): Promise<bigint | null> {
  const [latest] = await listRecentTrips(userId, 1);
  if (!latest) return null;
  const lines = await getTripLines(latest.id);
  return lines.reduce((sum, l) => sum + BigInt(l.paidPriceKobo), 0n);
}

/**
 * Sets (or replaces) the budget effective from a given month. `effective_from`
 * is unique per (user, month) server-side (§ migration 20260831000001) —
 * upserting here, not inserting, so re-running Budget Setup for the same
 * month edits it rather than erroring or duplicating.
 */
export async function setBudget(
  userId: string,
  amountKobo: bigint,
  effectiveFrom: string,
  source: LocalBudget["source"],
): Promise<LocalBudget> {
  if (amountKobo < 0n) {
    throw new Error("setBudget: amount must not be negative");
  }
  const existing = await db.budgets
    .where("userId")
    .equals(userId)
    .filter((b) => b.effectiveFrom === effectiveFrom)
    .first();

  const budget: LocalBudget = {
    id: existing?.id ?? newId(),
    userId,
    amountKobo: amountKobo.toString(),
    currency: "NGN",
    periodKind: "monthly",
    effectiveFrom,
    source,
    clientUpdatedAt: nowIso(),
    syncStatus: "pending" as SyncStatus,
  };
  await db.budgets.put(budget);
  return budget;
}

/**
 * The budget in effect for a given month: the most recent budget whose
 * effectiveFrom is <= that month (budgets don't need to be re-set every
 * month to keep applying — matches the server column being a plain
 * "effective from" date, not a per-month row requirement).
 */
export async function getBudgetForMonth(
  userId: string,
  month: string = monthStart(),
): Promise<LocalBudget | undefined> {
  const budgets = await db.budgets
    .where("userId")
    .equals(userId)
    .filter((b) => b.effectiveFrom <= month)
    .sortBy("effectiveFrom");
  return budgets.at(-1);
}

/**
 * Count of COMPLETE calendar months in the user's purchase history — the
 * decomposition tier gate's input (`selectTier`, engine/tiers.ts): the
 * current, still-in-progress month never counts, no matter how many trips
 * are in it.
 */
export async function countCompleteMonths(userId: string): Promise<number> {
  const currentMonth = monthStart();
  const trips = await db.trips
    .where("userId")
    .equals(userId)
    .filter((t) => !t.isDraft)
    .toArray();
  const months = new Set(
    trips.map((t) => monthStart(new Date(t.tripDate))).filter((m) => m < currentMonth),
  );
  return months.size;
}

/** This month's and last complete month's committed trip lines, for Budget Analysis. */
export async function monthLines(userId: string, month: string) {
  const nextMonth = addMonths(month, 1);
  const trips = await db.trips
    .where("userId")
    .equals(userId)
    .filter((t) => !t.isDraft && t.tripDate >= month && t.tripDate < nextMonth)
    .toArray();
  const lines = await Promise.all(trips.map((t) => getTripLines(t.id)));
  return lines.flat();
}

export { addMonths };
