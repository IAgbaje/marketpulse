/**
 * Counts the local Dexie rows a given (anonymous) userId owns, for the
 * second-device merge decision (TR §2.3, `deviceMerge.ts`).
 *
 * `watchlistCount` is hardcoded to 0: that Dexie table doesn't exist yet
 * (`watchlist` is a Stage 9 feature). `budgetCount` is real as of Stage 5 —
 * see the note this replaced: when a table lands, wire it into this probe in
 * the same change, not after. `hasLocalData()` treats 0 as "nothing to
 * merge"; undercounting here would silently drop data.
 */

import { db } from "../db.js";
import type { LocalDataProbe } from "./deviceMerge.js";

export async function probeLocalData(userId: string): Promise<LocalDataProbe> {
  const [tripCount, purchaseLineCount, budgetCount] = await Promise.all([
    db.trips.where("userId").equals(userId).count(),
    db.lines.where("userId").equals(userId).count(),
    db.budgets.where("userId").equals(userId).count(),
  ]);
  return {
    tripCount,
    purchaseLineCount,
    budgetCount,
    watchlistCount: 0,
  };
}
