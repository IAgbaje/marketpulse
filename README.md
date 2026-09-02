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
| 5 | Decomposition engine -> budget vs actual | Done — 5a always on; 5b behind `flag("fullDecompositionSplit")` (`src/lib/flags.ts`) |
| 6 | OCR layer | Done — contract + parser + review screen (`src/lib/ocr/extractionContract.ts`, `ocrMapping.ts`); needs `VISION_API_*` secrets to be live end-to-end |
| 7 | Crowd annotations live | Done |
| 8 | Map + comparison modes | Comparison screens done; the choropleth is a documented, data-blocked V1 item — decisions locked in [ADR 0001](docs/adr/0001-price-map-geo-data-source.md) |
| 9 | Sharing + weekly reports, watchlist | Done (in-app alert delivery only — see below) |

## Setup

```bash
npm install
cp .env.example .env.local   # fill in VITE_SUPABASE_ANON_KEY from the dashboard
npm run dev
```

Node 22+. The Supabase project (`qkohesyqyknavriyhlsc`, org "Ibraheem
Agbaje") has migrations `20260831000001`–`20260901221012` applied and the
seed data loaded. Two new migrations
(`20260902000001_soft_delete`, `20260902000002_security_advisor_followup`)
ship in this repo and still need `supabase db push` — see **Deploy**.

## Deploy

Hosted on **Vercel** (`vercel.json` — SPA rewrite, security headers,
immutable asset caching, PWA no-cache for the SW/manifest). Two env vars,
both publishable client-side values (`VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY` — the anon key is meant to ship in the bundle; RLS
is the real control). Set them in Vercel Project Settings → Environment
Variables and mirror `VITE_SUPABASE_ANON_KEY` into the GitHub repo secret
of the same name for CI's build step.

```bash
git push origin main                                  # CI runs typecheck/test/build/bundle-size
supabase db push                                       # applies 20260902000001 + ...000002
vercel --prod                                          # or connect the repo in the Vercel dashboard
# then, before the photo path can extract for real:
supabase secrets set OCR_IP_SALT=... VISION_API_URL=... VISION_API_KEY=... \
  VISION_MODEL=... CAPTCHA_SECRET=... CAPTCHA_VERIFY_URL=...
```

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
  `anon-signin-gate` are deployed and reachable, and degrade gracefully
  (not crash) until `OCR_IP_SALT`, `VISION_API_URL`, `VISION_API_KEY`,
  `VISION_MODEL`, `CAPTCHA_SECRET`, `CAPTCHA_VERIFY_URL` are set via
  `supabase secrets set`. Real credentials — not something to invent. The
  extraction pipeline (contract → validate → map → review screen) is built
  and tested against fixtures; a live vision key is the only thing between
  it and end-to-end photo capture.
- **The Price Map choropleth isn't built — it's data-blocked, not
  engineering-blocked.** ADR 0001 now locks every open decision (no
  library, inline-SVG Lagos-LGA choropleth, `/map` lazy chunk). It has
  nothing to render until `locations.centroid_lat/lon` is populated and the
  full Lagos LGA + market hierarchy is seeded — a seed task. The three
  comparison screens that carry Stage 8's value are shipping.
- **Watchlist alert delivery is in-app only.** TR §6.2 leaves push/email
  as an explicitly unresolved V1 product decision — not an engineering gap.
- **Stage 5b is off by default.** `flag("fullDecompositionSplit")` —
  `VITE_FLAG_FULL_DECOMPOSITION_SPLIT=true` at build, or a per-device
  `localStorage` override. Engine + display model are done and tested;
  §7.7 keeps most users on the price-effect tier until it's deliberately on.
- **Commodity master-list ownership** (`data/README.md`'s named owner) and
  **the NDPA cross-border ToS/consent copy** (needed before public launch,
  not before this point) are product/legal decisions, not engineering ones.
- **Supabase Auth: leaked-password protection is off** — a dashboard
  toggle (Authentication → Providers → Password), turn on before public
  launch. Other security-advisor findings are addressed or documented as
  accepted in `supabase/migrations/20260902000002_security_advisor_followup.sql`.

## Deleting data

Removing a line, a trip (`TripSummary` → "Delete this shop") or a watch is a
**tombstone**, not a local-only delete: `deletedAt` is set, the row is hidden
from every read, and it syncs to the server where the tombstone is *sticky*
(a stale concurrent edit can't resurrect it). Crowd aggregates drop the
removed line. Migration `20260902000001_soft_delete`.

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
