import { useEffect, useState } from "react";
import { useLocation as useRouterLocation } from "wouter";
import { useLiveQuery } from "dexie-react-hooks";
import { db, getOpenDraft } from "../../lib/db.js";
import { formatNaira, parseNairaToKobo } from "../../lib/money.js";
import { commitTrip, getTripLines, mostRecentPriorLine, updateLine } from "../../lib/trips.js";
import type { LocalLine } from "../../lib/db.js";

/**
 * Screen 6 — Confirm and correct (§15.3), "the critical screen". Every field
 * editable in place. Outlier-flagged lines get a neutral "check this" prompt,
 * never an error/warning treatment (US-1.3 AC). No blocking modals.
 *
 * Crowd annotation ("Others paid…") intentionally renders nothing here —
 * that empty state is designed on purpose (screen 6's third annotation
 * variant), not a gap; crowd data doesn't exist until stage 4/7. See
 * Technical Requirements §3.1 (build-order note).
 */
export function ConfirmTrip({ userId }: { userId: string }) {
  const [, navigate] = useRouterLocation();
  const [tripId, setTripId] = useState<string | null>(null);
  const [lastPaid, setLastPaid] = useState<Record<string, LocalLine | undefined>>({});
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

  const total = lines.reduce((sum, l) => sum + BigInt(l.paidPriceKobo), 0n);

  async function handleCommit() {
    if (!tripId) return;
    setError(null);
    setCommitting(true);
    try {
      await commitTrip(tripId);
      navigate("/");
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
              <strong>{commodity?.canonicalName ?? line.rawText ?? "Unknown item"}</strong>

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
