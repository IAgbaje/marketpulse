import { useMemo, useState } from "react";
import { useLocation as useRouterLocation } from "wouter";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../../lib/db.js";
import { formatNaira, parseNairaToKobo } from "../../lib/money.js";
import { addLine, getOrCreateDraft } from "../../lib/trips.js";
import { captureReceipts, MAX_IMAGES_PER_OCR_CALL, type OcrResult } from "../../lib/ocr.js";
import { prepareOcrLines, type PreparedOcrLine } from "../../lib/ocrMapping.js";

/**
 * Screen 5 — Photo capture (§4 stage 6). Fronts the `ocr-proxy` Edge
 * Function, which owns every cost/rate-limit decision server-side (TR §6.1,
 * blocking item 3). This screen shapes the request, then turns a validated
 * extraction (src/lib/ocr/extractionContract) into editable trip lines —
 * commodity/unit auto-matched where confident, surfaced for review where not
 * (US-1.2, US-1.3). Every path ends somewhere useful; nothing is a dead end.
 *
 *  - `pick-market` — the photo flow needs a trip context like manual entry does.
 *  - `degrade`     — budget exhausted / rate-limited / vision failed. The
 *    DESIGNED fallback (US-1.2): straight to manual entry, plainly explained.
 *  - `unreadable`  — the model replied but nothing matched the contract. Keep
 *    the photo, offer manual entry — never a misparse.
 *  - `review`      — extracted lines, each editable in place; low-confidence
 *    fields marked; incomplete rows must be finished or removed before they
 *    become lines.
 */

type Stage =
  | { name: "pick-market" }
  | { name: "choose" }
  | { name: "processing" }
  | { name: "degrade"; reason: string }
  | { name: "unreadable" }
  | { name: "review"; rows: ReviewRow[]; notes: string | null }
  | { name: "error"; message: string };

interface ReviewRow extends PreparedOcrLine {
  key: string;
}

export function PhotoCapture({ userId }: { userId: string }) {
  const [, navigate] = useRouterLocation();

  const commodities = useLiveQuery(() => db.commodities.toArray(), []) ?? [];
  const aliases = useLiveQuery(() => db.aliases.toArray(), []) ?? [];
  const units = useLiveQuery(() => db.units.toArray(), []) ?? [];
  const markets =
    useLiveQuery(() => db.locations.where("level").equals("market").toArray(), []) ?? [];

  const [marketId, setMarketId] = useState<string>("");
  const [files, setFiles] = useState<File[]>([]);
  const [stage, setStage] = useState<Stage>({ name: "pick-market" });
  const [addError, setAddError] = useState<string | null>(null);

  function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    setFiles(Array.from(e.target.files ?? []).slice(0, MAX_IMAGES_PER_OCR_CALL));
  }

  async function handleScan() {
    setStage({ name: "processing" });
    const outcome: OcrResult = await captureReceipts(files);
    switch (outcome.kind) {
      case "degrade":
        setStage({ name: "degrade", reason: outcome.reason });
        return;
      case "unreadable":
        setStage({ name: "unreadable" });
        return;
      case "error":
        setStage({ name: "error", message: outcome.message });
        return;
      case "extracted": {
        const prepared = prepareOcrLines(outcome.items, { commodities, aliases, units });
        setStage({
          name: "review",
          notes: outcome.notes,
          rows: prepared.map((r, i) => ({ ...r, key: `ocr-${i}` })),
        });
        return;
      }
    }
  }

  function patchRow(key: string, patch: Partial<ReviewRow>) {
    setStage((s) =>
      s.name === "review"
        ? { ...s, rows: s.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) }
        : s,
    );
  }

  function removeRow(key: string) {
    setStage((s) => (s.name === "review" ? { ...s, rows: s.rows.filter((r) => r.key !== key) } : s));
  }

  function rowComplete(r: ReviewRow): boolean {
    return (
      r.commodityId !== null &&
      r.unitId !== null &&
      r.quantity !== null &&
      r.quantity > 0 &&
      r.paidPriceKobo !== null &&
      r.paidPriceKobo > 0n
    );
  }

  async function handleAddAll() {
    if (stage.name !== "review") return;
    setAddError(null);
    const complete = stage.rows.filter(rowComplete);
    if (complete.length === 0) {
      setAddError("Fill in the item, unit, quantity and price on at least one row first.");
      return;
    }
    let added = 0;
    try {
      const draft = await getOrCreateDraft(userId, marketId);
      for (const r of complete) {
        await addLine({
          tripId: draft.id,
          userId,
          commodityId: r.commodityId!,
          unitId: r.unitId!,
          quantity: r.quantity!,
          paidPriceKobo: r.paidPriceKobo!,
          purchaseForm: r.purchaseForm,
          rawText: r.rawText,
        });
        added += 1;
      }
    } catch (err) {
      setAddError(
        `Saved ${added} of ${complete.length}, then hit a problem: ${
          err instanceof Error ? err.message : String(err)
        }. Your other items are safe — try again or type the rest in.`,
      );
      return;
    }
    const remaining = stage.rows.filter((r) => !rowComplete(r));
    if (remaining.length === 0) {
      navigate("/capture/confirm");
    } else {
      setStage({ ...stage, rows: remaining });
      setAddError(
        `Added ${complete.length}. ${remaining.length} still ${
          remaining.length === 1 ? "needs" : "need"
        } an item, unit, quantity or price — finish or remove ${
          remaining.length === 1 ? "it" : "them"
        }.`,
      );
    }
  }

  // --- render ---------------------------------------------------------------

  if (stage.name === "pick-market") {
    return (
      <main>
        <h1>Where did you shop?</h1>
        <select
          aria-label="Market"
          value={marketId}
          onChange={(e) => setMarketId(e.target.value)}
        >
          <option value="">Choose a market…</option>
          {markets.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <p>
          <button type="button" disabled={!marketId} onClick={() => setStage({ name: "choose" })}>
            Next
          </button>
        </p>
        <p>
          <button type="button" onClick={() => navigate("/capture/manual")}>
            Type it in instead
          </button>
        </p>
      </main>
    );
  }

  if (stage.name === "processing") {
    return (
      <main aria-busy="true">
        Reading your photo{files.length > 1 ? "s" : ""}…
        <p>
          <button type="button" onClick={() => navigate("/capture/manual")}>
            Switch to typing
          </button>
        </p>
      </main>
    );
  }

  if (stage.name === "degrade") {
    return (
      <main>
        <h1>Let&rsquo;s do this one by hand</h1>
        <p>
          {stage.reason === "budget_exhausted" ||
          stage.reason === "session_rate_limited" ||
          stage.reason === "ip_rate_limited"
            ? "Photo scanning is busy right now — typing it in only takes a bit longer."
            : "Couldn't read that photo clearly enough — typing it in will be quicker than retaking it."}
        </p>
        <button type="button" onClick={() => navigate("/capture/manual")}>
          Type it in
        </button>
      </main>
    );
  }

  if (stage.name === "unreadable") {
    return (
      <main>
        <h1>Got your photo</h1>
        <p>
          We couldn&rsquo;t make out a clear list of items from that image. Nothing&rsquo;s lost —
          add the items yourself and it&rsquo;ll take about the same time.
        </p>
        <button type="button" onClick={() => navigate("/capture/manual")}>
          Add items
        </button>
      </main>
    );
  }

  if (stage.name === "error") {
    return (
      <main>
        <h1>Snap your receipt or list</h1>
        <p role="alert">{stage.message}</p>
        <button type="button" onClick={() => setStage({ name: "choose" })}>
          Try again
        </button>
        <p>
          <button type="button" onClick={() => navigate("/capture/manual")}>
            Type it in instead
          </button>
        </p>
      </main>
    );
  }

  if (stage.name === "review") {
    return (
      <main>
        <h1>Check the scanned items</h1>
        {stage.notes && <p>Note from the scan: {stage.notes}</p>}
        <p>Fix anything that looks off, then add them to your shop.</p>

        <ol aria-label="Scanned items">
          {stage.rows.map((r) => (
            <ReviewLine
              key={r.key}
              row={r}
              commodities={commodities}
              aliases={aliases}
              units={units}
              onPatch={(patch) => patchRow(r.key, patch)}
              onRemove={() => removeRow(r.key)}
            />
          ))}
        </ol>

        {stage.rows.length === 0 && <p>No items left. Add some by hand instead.</p>}
        {addError && <p role="alert">{addError}</p>}

        <button type="button" onClick={() => void handleAddAll()} disabled={stage.rows.length === 0}>
          Add {stage.rows.filter(rowComplete).length || ""} item
          {stage.rows.filter(rowComplete).length === 1 ? "" : "s"} to my shop
        </button>
        <p>
          <button type="button" onClick={() => navigate("/capture/manual")}>
            Type the rest in
          </button>
        </p>
      </main>
    );
  }

  // stage.name === "choose"
  return (
    <main>
      <h1>Snap your receipt or list</h1>
      <p>Up to {MAX_IMAGES_PER_OCR_CALL} photos. Printed or handwritten both work.</p>

      <label htmlFor="receipt-photos">Photos</label>
      <input
        id="receipt-photos"
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        onChange={handleFiles}
      />

      {files.length > 0 && (
        <p>
          {files.length} photo{files.length === 1 ? "" : "s"} chosen.
        </p>
      )}

      <button type="button" onClick={() => void handleScan()} disabled={files.length === 0}>
        Scan
      </button>

      <p>
        <button type="button" onClick={() => navigate("/capture/manual")}>
          Type it in instead
        </button>
      </p>
    </main>
  );
}

// --- one editable review row ------------------------------------------------

function ReviewLine({
  row,
  commodities,
  aliases,
  units,
  onPatch,
  onRemove,
}: {
  row: ReviewRow;
  commodities: { id: string; canonicalName: string }[];
  aliases: { commodityId: string; alias: string }[];
  units: { id: string; unitCode: string; commodityId: string | null }[];
  onPatch: (patch: Partial<ReviewRow>) => void;
  onRemove: () => void;
}) {
  const [query, setQuery] = useState("");
  const matchedName = commodities.find((c) => c.id === row.commodityId)?.canonicalName ?? null;

  const matches = useMemo(() => {
    if (query.length < 2) return [];
    const q = query.toLowerCase();
    const aliasIds = new Set(
      aliases.filter((a) => a.alias.toLowerCase().includes(q)).map((a) => a.commodityId),
    );
    return commodities
      .filter((c) => c.canonicalName.toLowerCase().includes(q) || aliasIds.has(c.id))
      .slice(0, 8);
  }, [query, commodities, aliases]);

  const unitsForCommodity = units.filter(
    (u) => u.commodityId === row.commodityId || u.commodityId === null,
  );

  const priceNaira =
    row.paidPriceKobo !== null ? formatNaira(row.paidPriceKobo).replace(/^₦/, "") : "";

  const lowConfidence = row.commodityConfidence > 0 && row.commodityConfidence < 0.75;

  return (
    <li data-review={row.needsReview ? "true" : "false"}>
      <p>
        <small>Scanned: “{row.rawText}”</small>
      </p>

      <label>
        Item
        {matchedName ? (
          <>
            <span> {matchedName}</span>
            {lowConfidence && <span> — check this is right</span>}{" "}
            <button type="button" onClick={() => onPatch({ commodityId: null, unitId: null })}>
              change
            </button>
          </>
        ) : (
          <>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Start typing the item…"
              autoComplete="off"
            />
            {matches.length > 0 && (
              <ul>
                {matches.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => {
                        // New commodity ⇒ the old auto-matched unit may be
                        // scoped to a different commodity; force a re-pick.
                        onPatch({ commodityId: c.id, commodityConfidence: 1, unitId: null });
                        setQuery("");
                      }}
                    >
                      {c.canonicalName}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </label>

      <label>
        Quantity
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          value={row.quantity ?? ""}
          onChange={(e) => {
            const v = Number(e.target.value);
            onPatch({ quantity: e.target.value === "" || Number.isNaN(v) ? null : v });
          }}
        />
      </label>

      <label>
        Unit
        <select
          value={row.unitId ?? ""}
          onChange={(e) => onPatch({ unitId: e.target.value || null })}
        >
          <option value="">—</option>
          {unitsForCommodity.map((u) => (
            <option key={u.id} value={u.id}>
              {u.unitCode}
            </option>
          ))}
        </select>
      </label>

      <label>
        Price
        <input
          inputMode="decimal"
          placeholder="₦"
          defaultValue={priceNaira}
          onChange={(e) => {
            const kobo = parseNairaToKobo(e.target.value);
            onPatch({ paidPriceKobo: kobo });
          }}
        />
      </label>

      <fieldset>
        <legend>How was it sold?</legend>
        {(["loose", "pre_packed", "bulk"] as const).map((form) => (
          <label key={form}>
            <input
              type="radio"
              name={`form-${row.key}`}
              value={form}
              checked={row.purchaseForm === form}
              onChange={() => onPatch({ purchaseForm: form })}
            />
            {form.replace("_", "-")}
          </label>
        ))}
      </fieldset>

      <button type="button" onClick={onRemove} aria-label="Remove this item">
        Remove
      </button>
    </li>
  );
}
