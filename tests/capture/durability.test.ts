/**
 * TR §5's named offline-durability test: a force-quit (or crash, or a tab
 * the OS just kills) mid-capture must lose at most the keystrokes in the
 * unsubmitted form — never a line the user already added, and the app must
 * resume the in-progress trip rather than restart it.
 *
 * This exercises the actual persistence mechanism, not a mock of it: writes
 * go through the real `trips.ts` functions against a real Dexie instance
 * (fake-indexeddb backs `indexedDB` for the test process — see
 * vitest.config.ts). Closing and reopening the connection mid-test is the
 * faithful proxy for "the tab was killed and reopened": it forces every
 * subsequent read through Dexie's actual IndexedDB round-trip rather than
 * relying on anything an open connection might hold in memory.
 *
 * The UI half of this guarantee (ManualEntry checking `getOpenDraft` before
 * ever showing the market picker, so a resumed session lands on the
 * in-progress list instead of "pick a market again") is verified live in a
 * browser, not here — Dexie's in-memory query caching and React's render
 * behavior are two different things, and only one of them is what this file
 * can honestly claim to prove.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, getOpenDraft, type LocalTrip } from "@/src/lib/db";
import { addLine, getOrCreateDraft, getTripLines } from "@/src/lib/trips";

const USER = "durability-test-user";
const MARKET = "durability-test-market";

async function seedOneUnit(): Promise<string> {
  const unitId = "durability-test-unit";
  await db.units.put({
    id: unitId,
    unitCode: "kg",
    toBaseUnit: "g",
    commodityId: null,
    factorNum: "1000",
    factorDen: "1",
    confidence: "high",
  });
  return unitId;
}

beforeEach(async () => {
  await db.open();
  await db.trips.where("userId").equals(USER).delete();
  await db.lines.where("userId").equals(USER).delete();
});

afterEach(async () => {
  await db.trips.where("userId").equals(USER).delete();
  await db.lines.where("userId").equals(USER).delete();
});

describe("offline durability (TR §5)", () => {
  it("a line added before the tab dies is still there, and the draft is still open, after the connection is closed and reopened", async () => {
    const unitId = await seedOneUnit();

    const draft = await getOrCreateDraft(USER, MARKET);
    const line = await addLine({
      tripId: draft.id,
      userId: USER,
      commodityId: "rice_local",
      unitId,
      quantity: 2,
      paidPriceKobo: 150000n,
      purchaseForm: "loose",
    });

    // Simulate the tab dying and reopening: force a real round-trip through
    // IndexedDB rather than continuing to use the still-open connection.
    db.close();
    await db.open();

    const resumedDraft = await getOpenDraft(USER);
    expect(resumedDraft?.id).toBe(draft.id);
    expect(resumedDraft?.isDraft).toBe(true);
    expect(resumedDraft?.marketId).toBe(MARKET);

    const resumedLines = await getTripLines(draft.id);
    expect(resumedLines).toHaveLength(1);
    expect(resumedLines[0]?.id).toBe(line.id);
    expect(resumedLines[0]?.paidPriceKobo).toBe("150000");
  });

  it("adding a second line after reopening appends to the SAME draft, not a new one", async () => {
    const unitId = await seedOneUnit();

    const draft = await getOrCreateDraft(USER, MARKET);
    await addLine({
      tripId: draft.id,
      userId: USER,
      commodityId: "rice_local",
      unitId,
      quantity: 1,
      paidPriceKobo: 100000n,
      purchaseForm: "loose",
    });

    db.close();
    await db.open();

    // Reopen exactly as a resumed ManualEntry mount would: look up the open
    // draft first, add to it — never create a second one.
    const resumed = (await getOpenDraft(USER)) as LocalTrip;
    await addLine({
      tripId: resumed.id,
      userId: USER,
      commodityId: "onion",
      unitId,
      quantity: 1,
      paidPriceKobo: 50000n,
      purchaseForm: "loose",
    });

    const openDrafts = await db.trips
      .where("userId")
      .equals(USER)
      .filter((t) => t.isDraft)
      .toArray();
    expect(openDrafts).toHaveLength(1);

    const lines = await getTripLines(resumed.id);
    expect(lines).toHaveLength(2);
  });

  it("an unsubmitted form (no addLine call) leaves no trace — only what was actually added survives", async () => {
    const draft = await getOrCreateDraft(USER, MARKET);
    // No addLine call: this represents keystrokes in the form that were
    // never submitted before the tab died.
    db.close();
    await db.open();

    const resumed = await getOpenDraft(USER);
    expect(resumed?.id).toBe(draft.id);
    const lines = await getTripLines(draft.id);
    expect(lines).toHaveLength(0);
  });
});
