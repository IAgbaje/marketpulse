# MarketPulse

Price-aware shopping intelligence for Nigerian grocery markets — log what
you actually paid, see how it compares to last time and to what others in
your market are paying, and (once you have enough history) see how much of
any change is prices moving versus what you bought.

Full spec: `../PROJECT ME/.claude/Price-Aware-Shopping-Intelligence-Technical-Requirements.md`
("TR" below). Architecture decisions: [`docs/adr/`](docs/adr/).

## Status

All nine build-order stages (TR §4) exist in this repo. That does not mean
the product is finished — see **What's not done** below before assuming
anything works end-to-end without setup.

| Stage | What | Status |
|---|---|---|
| 1 | Foundation data (commodities, units, locations, seed) | Done |
| 2 | Manual capture + confirm + local storage | Done, incl. offline-durability resume |
| 3 | Anonymous auth + sync + account upgrade | Done |
| 4 | Personal trip comparison, Home, Commodity Detail | Done |
| 5 | Decomposition engine -> budget vs actual | Done (P0 tier only — see below) |
| 6 | OCR layer | Done (proxy wired; extraction parsing blocked, see below) |
| 7 | Crowd annotations live | Done |
| 8 | Map + comparison modes | Partial — Market Detail/Price Comparison/Basket Comparison done, map itself deferred (see [ADR 0001](docs/adr/0001-price-map-geo-data-source.md)) |
| 9 | Sharing + weekly reports, watchlist | Done (in-app delivery only — see below) |

## Setup

```bash
npm install
cp .env.example .env.local   # fill in VITE_SUPABASE_ANON_KEY from the dashboard
npm run dev
```

Node 22+. The Supabase project (`qkohesyqyknavriyhlsc`, org "Ibraheem
Agbaje") already has every migration in `supabase/migrations/` applied and
the seed data loaded — `npm run dev` should work against it directly, no
`supabase db push` needed for a fresh clone.

## Verify

```bash
npm run typecheck
npm test                 # unit/property/persistence suite, no live DB needed
npm run build             # also runs the bundle-size gate via CI
node scripts/check-bundle-size.mjs   # <=300KB gzipped, TR §12
SUPABASE_DB_URL=... npm run test:integration   # needs a live DB connection string
```

CI (`.github/workflows/ci.yml`) runs typecheck/test/build/bundle-size on
every push and PR, plus a Supabase security-advisor lint gate that
activates once `SUPABASE_DB_URL` is set as a repo secret.

## What's not done, and why (not a hidden TODO list — read before assuming something works)

- **OCR/CAPTCHA Edge Function secrets are unset.** `ocr-proxy` and
  `anon-signin-gate` are deployed and reachable, but degrade gracefully
  (not crash) until `OCR_IP_SALT`, `VISION_API_URL`, `VISION_API_KEY`,
  `VISION_MODEL`, `CAPTCHA_SECRET`, `CAPTCHA_VERIFY_URL` are set via
  `supabase secrets set`. Real credentials — not something to invent.
- **OCR extraction -> line items is not built.** No source doc defines the
  vision model's response shape. `PhotoCapture.tsx` calls the real proxy
  and handles the degrade path fully; a successful extraction is shown to
  the user honestly rather than parsed against an invented schema.
- **The Price Map itself isn't built.** Geo-data licensing is resolved
  (ADR 0001) and `postgis` is enabled, but no mapping library is wired in —
  every mainstream option would likely blow the 300KB gzipped bundle
  budget on its own, a real trade-off, not a default to pick silently.
- **Stage 5 ships P0 (price-effect-only) only.** Stage 5b (full PRICE /
  WHAT_YOU_BOUGHT split) needs a feature-flag system that doesn't exist
  yet; the engine and display code for it are already implemented behind
  one constant (`FULL_SPLIT_ENABLED` in `BudgetAnalysis.tsx`).
- **Watchlist alert delivery is in-app only.** TR §6.2 leaves push/email
  as an explicitly unresolved V1 product decision — not an engineering gap.
- **Deleting a trip line or a watchlist item is local-only.** The removal
  never reaches the server. Needs a tombstone/soft-delete convention
  applied consistently across every synced table — a deliberate, disclosed
  gap, not an oversight.
- **Commodity master-list ownership** (`data/README.md`'s named owner) and
  **the NDPA cross-border ToS/consent copy** (needed before public launch,
  not before this point) are product/legal decisions, not engineering ones.

## Money & data invariants (do not relax these)

- Money is integer kobo end to end. `bigint` in the engine and every synced
  table; strings in Dexie (IndexedDB can't index `bigint`); never a float.
- The decomposition engine (`src/engine/`) is pure, computes an exact tie
  (`PRICE + WHAT_YOU_BOUGHT + NEW - STOPPED + EXCLUDED = total change`,
  zero tolerance), and must stay that way — see TR §3 before touching it.
- Crowd data (`price_aggregates`) never surfaces below 5 distinct users
  (TR §7's privacy floor) — enforced server-side; every screen that reads
  it (`CommodityDetail`, `ConfirmTrip`, `MarketDetail`, comparisons) treats
  "no bucket" and "below floor" as the same disclosed empty state.
