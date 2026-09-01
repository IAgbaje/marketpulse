/**
 * Counts the local Dexie rows a given (anonymous) userId owns, for the
 * second-device merge decision (TR §2.3, `deviceMerge.ts`).
 *
 * `budgetCount` / `watchlistCount` are hardcoded to 0: those Dexie tables
 * don't exist yet (`user_budgets` / `watchlist` are Stage 5 / Stage 9
 * features, not stored locally). This must stay a correct LOWER bound —
 * `hasLocalData()` treats 0 as "nothing to merge", so a false negative here
 * would silently drop data. When those tables are added to `src/lib/db.ts`,
 * this probe must be extended in the same change, not after.
 */

import { db } from "../db.js";
import type { LocalDataProbe } from "./deviceMerge.js";

export async function probeLocalData(userId: string): Promise<LocalDataProbe> {
  const [tripCount, purchaseLineCount] = await Promise.all([
    db.trips.where("userId").equals(userId).count(),
    db.lines.where("userId").equals(userId).count(),
  ]);
  return {
    tripCount,
    purchaseLineCount,
    budgetCount: 0,
    watchlistCount: 0,
  };
}
