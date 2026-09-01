/**
 * Counts the local Dexie rows a given (anonymous) userId owns, for the
 * second-device merge decision (TR §2.3, `deviceMerge.ts`). All four counts
 * are real as of Stage 9 — every synced local table is now wired in here,
 * per the standing rule this file has carried since Stage 3: a table that
 * exists locally must be counted here in the same change it's added, not
 * after. `hasLocalData()` treats 0 as "nothing to merge"; undercounting
 * would silently drop data.
 */

import { db } from "../db.js";
import type { LocalDataProbe } from "./deviceMerge.js";

export async function probeLocalData(userId: string): Promise<LocalDataProbe> {
  const [tripCount, purchaseLineCount, budgetCount, watchlistCount] = await Promise.all([
    db.trips.where("userId").equals(userId).count(),
    db.lines.where("userId").equals(userId).count(),
    db.budgets.where("userId").equals(userId).count(),
    db.watchlist.where("userId").equals(userId).count(),
  ]);
  return {
    tripCount,
    purchaseLineCount,
    budgetCount,
    watchlistCount,
  };
}
