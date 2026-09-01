import { useEffect, useState } from "react";
import { Link, useLocation as useRouterLocation } from "wouter";
import { useLiveQuery } from "dexie-react-hooks";
import { db, getOpenDraft } from "../../lib/db.js";
import { formatNaira, parseNairaToKobo } from "../../lib/money.js";
import { commitTrip, getTripLines, mostRecentPriorLine, updateLine } from "../../lib/trips.js";
import { fetchCrowdBands, matchCrowdBand, type CrowdBandRow } from "../../lib/crowdBand.js";
import { monthStart } from "../../lib/budgets.js";
import type { LocalLine } from "../../lib/db.js";

/**
 * Screen 6 — Confirm and correct (§15.3), "the critical screen". Every field
 * editable in place. Outlier-flagged lines get a neutral "check this" prompt,
 * never an error/warning treatment (US-1.3 AC). No blocking modals.
 *
 * Crowd annotation ("Others paid…") — as of stage 7 ("user-contributed
 * aggregation... 'Others paid' annotations become live"), this is inline
 * per line again, using screen 6's third designed annotation variant
 * ("not enough shoppers yet") for real, not a stand-in. It loads
 * independently of everything else on the screen (a crowd-fetch failure or
 * slow network never blocks confirming and saving the trip itself) and
 * still links to Commodity Detail for the fuller history.
 */
export function ConfirmTrip({ userId }: { userId: string }) {
  const [, navigate] = useRouterLocation();
  const [tripId, setTripId] = useState<string | null>(null);
  const [marketId, setMarketId] = useState<string | null>(null);
  const [lastPaid, setLastPaid] = useState<Record<string, LocalLine | undefined>>({});
  const [crowdByCommodity, setCrowdByCommodity] = useState<
    Record<string, CrowdBandRow | "empty" | "unavailable" | "loading">
  >({});
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const draft = await getOpenDraft(userId);
      if (!draft) {
        navigate("/capture");
        return;
      }
      setTripId(draft.id);
      setMarketId(draft.marketId);
    })();
  }, [userId, navigate]);

  const lines = useLiveQuery(
    () => (tripId ? getTripLines(tripId) : Promise.resolve([])),
    [tripId],
  ) ?? [];
  const commodities = useLiveQuery(() => db.commodities.toArray(), []) ?? [];
  const units = useLiveQuery(() => db.units.toArray(), []) ?? [];

  useEffect(() => {
    void (async () => {
      const entries = await Promise.all(
        lines.map(async (l) => {
          const prior = await mostRecentPriorLine(userId, l.commodityId, l.id);
          return [l.id, prior] as const;
        }),
      );
      setLastPaid(Object.fromEntries(entries));
    })();
  }, [lines, userId]);

  useEffect(() => {
    if (!marketId) return;
    const commodityIds = [...new Set(lines.map((l) => l.commodityId))];
    const unfetched = commodityIds.filter((id) => !(id in crowdByCommodity));
    if (unfetched.length === 0) return;

    setCrowdByCommodity((prev) => {
      const next = { ...prev };
      for (const id of unfetched) next[id] = "loading";
      return next;
    });

    const month = monthStart();
    void Promise.all(
      unfetched.map(async (commodityId) => {
        try {
          const bands = await fetchCrowdBands(commodityId);
          return [commodityId, matchCrowdBand(bands, marketId, month)] as const;
        } catch {
          return [commodityId, "unavailable" as const] as const;
        }
      }),
    ).then((entries) => {
      setCrowdByCommodity((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    });
    // crowdByCommodity intentionally omitted from deps: it's an accumulating
    // cache keyed by commodityId, checked via `unfetched` above — including
    // it here would re-trigger this effect on every fetch it just completed.
  }, [lines, marketId]);

  const total = lines.reduce((sum, l) => sum + BigInt(l.paidPriceKobo), 0n);

  async function handleCommit() {
    if (!tripId) return;
    setError(null);
    setCommitting(true);
    try {
      await commitTrip(tripId);
      navigate(`/trips/${tripId}/summary`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitting(false);
    }
  }

  if (!tripId) return null;

  return (
    <main>
      <h1>Confirm your shop</h1>

      <ul aria-label="Trip lines">
        {lines.map((line) => {
          const commodity = commodities.find((c) => c.id === line.commodityId);
          const unit = units.find((u) => u.id === line.unitId);
          const prior = lastPaid[line.id];

          return (
            <li key={line.id} data-outlier={line.outlierFlagged}>
              <strong>
                <Link to={`/commodity/${line.commodityId}`}>
                  {commodity?.canonicalName ?? line.rawText ?? "Unknown item"}
                </Link>
              </strong>

              <label>
                Quantity
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={line.quantity}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    if (!Number.isNaN(value) && value > 0) {
                      void updateLine(line.id, { quantity: value });
                    }
                  }}
                />
                {unit?.unitCode}
              </label>

              <label>
                Price
                <input
                  inputMode="decimal"
                  value={formatNaira(BigInt(line.paidPriceKobo)).replace(/^₦/, "")}
                  onChange={(e) => {
                    const kobo = parseNairaToKobo(e.target.value);
                    if (kobo !== null && kobo > 0n) {
                      void updateLine(line.id, { paidPriceKobo: kobo.toString() });
                    }
                  }}
                />
              </label>

              {prior !== undefined && (
                <p>
                  You paid {formatNaira(BigInt(prior.paidPriceKobo))} for {prior.quantity}{" "}
                  {units.find((u) => u.id === prior.unitId)?.unitCode} last time
                </p>
              )}

              <CrowdAnnotation state={crowdByCommodity[line.commodityId]} />

              {line.outlierFlagged && !line.userConfirmed && (
                <p>
                  Check this — this price looks unusual for you.{" "}
                  <button type="button" onClick={() => void updateLine(line.id, { userConfirmed: true })}>
                    Looks right
                  </button>
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <p>
        <strong>Total: {formatNaira(total)}</strong>
      </p>

      {error && <p role="alert">{error}</p>}

      <button type="button" onClick={() => void handleCommit()} disabled={committing}>
        {committing ? "Saving…" : "Done"}
      </button>
    </main>
  );
}

/**
 * Screen 6's third annotation variant, rendered for real (§4 stage 7):
 * "not enough shoppers yet" is a designed state here, not a placeholder —
 * it's what most items will show for a long time on a cold-start product,
 * and that's expected, not broken.
 */
function CrowdAnnotation({
  state,
}: {
  state: CrowdBandRow | "empty" | "unavailable" | "loading" | undefined;
}) {
  if (state === undefined || state === "loading") return null;
  if (state === "unavailable") return null; // never blocks confirming; silent is correct here
  if (state === "empty") {
    return <p>Not enough other shoppers here yet to say what&rsquo;s typical.</p>;
  }
  // p25/p75 are non-null whenever median is (recompute_bucket sets all three
  // together or all NULL together, migration 20260831000001) — the "empty"
  // branch above already filtered out medianKobo === null, so this is safe.
  return (
    <p>
      Others here typically pay {formatNaira(state.p25Kobo!)}–{formatNaira(state.p75Kobo!)}.
    </p>
  );
}
