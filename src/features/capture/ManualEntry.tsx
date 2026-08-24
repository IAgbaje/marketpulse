import { useEffect, useMemo, useState } from "react";
import { useLocation as useRouterLocation } from "wouter";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../../lib/db.js";
import { formatNaira, parseNairaToKobo } from "../../lib/money.js";
import {
  addLine,
  deleteLine,
  findLastTripAtLocation,
  getOrCreateDraft,
  getTripLines,
  repeatLastShop,
} from "../../lib/trips.js";
import type { LocalLine } from "../../lib/db.js";

/**
 * Screen 4 — Manual entry (§15.3). Running list at top, add-item form
 * pinned at the bottom in the thumb zone (§5 step 3 / screen 4 — the
 * no-scroll rule from an earlier draft was correctly dropped in favour of
 * this layout, per Technical Requirements §3.2 [screen-4 note]).
 *
 * No dedicated location-setup screen yet (§15.3 screen 2) — the market
 * picker here is a stand-in scoped for stage 2 capture, not the onboarding
 * flow. Flagged, not silently skipped.
 */
export function ManualEntry({ userId }: { userId: string }) {
  const [, navigate] = useRouterLocation();

  const commodities = useLiveQuery(() => db.commodities.toArray(), []) ?? [];
  const units = useLiveQuery(() => db.units.toArray(), []) ?? [];
  const markets = useLiveQuery(
    () => db.locations.where("level").equals("market").toArray(),
    [],
  ) ?? [];

  const [locationId, setLocationId] = useState<string>("");
  const [tripId, setTripId] = useState<string | null>(null);
  const [commodityQuery, setCommodityQuery] = useState("");
  const [selectedCommodityId, setSelectedCommodityId] = useState("");
  const [unitId, setUnitId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [purchaseForm, setPurchaseForm] = useState<LocalLine["purchaseForm"]>("loose");
  const [formError, setFormError] = useState<string | null>(null);
  const [hasRepeatOffer, setHasRepeatOffer] = useState<string | null>(null);

  const lines = useLiveQuery(
    () => (tripId ? getTripLines(tripId) : Promise.resolve([])),
    [tripId],
  ) ?? [];

  useEffect(() => {
    if (!locationId) return;
    void (async () => {
      const draft = await getOrCreateDraft(userId, locationId);
      setTripId(draft.id);

      const existingLines = await getTripLines(draft.id);
      if (existingLines.length === 0) {
        const lastTrip = await findLastTripAtLocation(userId, locationId);
        if (lastTrip) setHasRepeatOffer(lastTrip.id);
      }
    })();
  }, [locationId, userId]);

  const commodityMatches = useMemo(() => {
    if (commodityQuery.length < 2) return [];
    const q = commodityQuery.toLowerCase();
    return commodities.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
  }, [commodityQuery, commodities]);

  const unitsForCommodity = useMemo(
    () => units.filter((u) => u.commodityId === selectedCommodityId),
    [units, selectedCommodityId],
  );

  const runningTotalKobo = useMemo(
    () => lines.reduce((sum, l) => sum + BigInt(l.paidPriceKobo), 0n),
    [lines],
  );

  function selectCommodity(id: string, name: string) {
    setSelectedCommodityId(id);
    setCommodityQuery(name);
    const defaultUnit = units.find(
      (u) => u.commodityId === id && commodities.find((c) => c.id === id)?.defaultUnitId === u.id,
    );
    setUnitId(defaultUnit?.id ?? units.find((u) => u.commodityId === id)?.id ?? "");
  }

  async function handleAddLine() {
    setFormError(null);
    if (!tripId) return;
    if (!selectedCommodityId) {
      setFormError("Pick an item from the list.");
      return;
    }
    if (!unitId) {
      setFormError("Choose a unit.");
      return;
    }
    const qtyNum = Number(quantity);
    if (!quantity || Number.isNaN(qtyNum) || qtyNum <= 0) {
      setFormError("Enter a quantity above zero.");
      return;
    }
    const kobo = parseNairaToKobo(price);
    if (kobo === null || kobo <= 0n) {
      setFormError("Enter a price above zero.");
      return;
    }

    await addLine({
      tripId,
      userId,
      commodityId: selectedCommodityId,
      unitId,
      quantity: qtyNum,
      paidPriceKobo: kobo,
      purchaseForm,
    });

    // Reset the form for the next item; running list updates via useLiveQuery.
    setCommodityQuery("");
    setSelectedCommodityId("");
    setUnitId("");
    setQuantity("");
    setPrice("");
    setPurchaseForm("loose");
  }

  async function handleUseRepeat() {
    if (!tripId || !hasRepeatOffer) return;
    await repeatLastShop(userId, hasRepeatOffer, tripId);
    setHasRepeatOffer(null);
  }

  function handleProceed() {
    if (lines.length === 0) return;
    navigate("/capture/confirm");
  }

  if (!locationId) {
    return (
      <main>
        <h1>Where did you shop?</h1>
        <select
          aria-label="Market"
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
        >
          <option value="">Choose a market…</option>
          {markets.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </main>
    );
  }

  return (
    <main>
      <h1>{lines.length} item{lines.length === 1 ? "" : "s"} added</h1>

      {hasRepeatOffer && (
        <p>
          <button type="button" onClick={() => void handleUseRepeat()}>
            Repeat your last shop here — edit prices only
          </button>
        </p>
      )}

      <ul aria-label="Added items">
        {lines.map((line) => {
          const commodity = commodities.find((c) => c.id === line.commodityId);
          return (
            <li key={line.id}>
              {commodity?.name ?? line.rawText ?? "Unknown item"} — {line.quantity}{" "}
              {units.find((u) => u.id === line.unitId)?.unitName} —{" "}
              {formatNaira(BigInt(line.paidPriceKobo))}
              <button type="button" onClick={() => void deleteLine(line.id)} aria-label="Remove">
                ✕
              </button>
            </li>
          );
        })}
      </ul>

      <p>
        <strong>Total: {formatNaira(runningTotalKobo)}</strong>
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleAddLine();
        }}
      >
        <label>
          Item
          <input
            value={commodityQuery}
            onChange={(e) => {
              setCommodityQuery(e.target.value);
              setSelectedCommodityId("");
            }}
            placeholder="Start typing…"
            autoComplete="off"
          />
        </label>
        {commodityMatches.length > 0 && !selectedCommodityId && (
          <ul>
            {commodityMatches.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => selectCommodity(c.id, c.name)}>
                  {c.name}
                </button>
              </li>
            ))}
          </ul>
        )}

        <label>
          Quantity
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </label>

        <label>
          Unit
          <select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
            <option value="">—</option>
            {unitsForCommodity.map((u) => (
              <option key={u.id} value={u.id}>
                {u.unitName}
              </option>
            ))}
          </select>
        </label>

        <label>
          Price
          <input
            inputMode="decimal"
            placeholder="₦"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </label>

        <fieldset>
          <legend>How was it sold?</legend>
          {(["loose", "pre_packed", "bulk"] as const).map((form) => (
            <label key={form}>
              <input
                type="radio"
                name="purchaseForm"
                value={form}
                checked={purchaseForm === form}
                onChange={() => setPurchaseForm(form)}
              />
              {form.replace("_", "-")}
            </label>
          ))}
        </fieldset>

        {formError && <p role="alert">{formError}</p>}

        <button type="submit">Add</button>
      </form>

      <button type="button" onClick={handleProceed} disabled={lines.length === 0}>
        Continue
      </button>
    </main>
  );
}
