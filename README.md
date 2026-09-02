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
Agbaje") has every migration in `supabase/migrations/` applied through
`20260902000003`, and the seed data loaded.

> **Migration-history note (2026-09-02).** The live DB was originally built
> from an earlier migration lineage that a later "consolidate backend" pass
> renamed, so `supabase_migrations.schema_migrations` recorded nine versions
> that no longer exist as files here (`20260824123000`, `20260824130000`,
> `20260901201541`–`20260901202134`, `20260901220933`) while four files that
> *were* in effect (`20260831000001`–`20260831000004`) were recorded as
> unapplied. That was reconciled with `supabase migration repair`
> (`--status applied` for the four, `--status reverted` for the nine) after
> verifying each one's objects actually exist on the live DB. This repo is
> now the single source of truth for migration history — don't re-run those
> repairs.

## Deploy

Hosted on **Vercel** (`vercel.json` — SPA rewrite, security headers,
immutable asset caching, PWA no-cache for the SW/manifest). Two env vars,
both publishable client-side values (`VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY` — the anon key is meant to ship in the bundle; RLS
is the real control). Set them in Vercel Project Settings → Environment
Variables and mirror `VITE_SUPABASE_ANON_KEY` into the GitHub repo secret
of the same name for CI's build step.

**Live:** https://marketpulse-pi-eight.vercel.app (production, deployed
2026-09-02). Migrations through `20260902000002` are applied; all four edge
functions are deployed.

Ordering that matters: `src/lib/sync.ts` puts `deleted_at` in every trip,
line and watchlist upsert payload, so **`20260902000001` must be applied
before the frontend ships** — otherwise PostgREST rejects the unknown column
and *all* trip sync fails, not just deletes.

```bash
git push origin main                                  # CI runs typecheck/test/build/bundle-size
supabase db push                                      # DB first — see ordering note above
supabase functions deploy anon-signin-gate ocr-proxy merge-anonymous-data keepalive
vercel --prod                                         # frontend last
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
  launch. **This is the last remaining pre-launch security item.** As of
  2026-09-02 the advisor reports **zero ERROR-level findings**; what remains
  is this toggle, `extension_in_public` on `pg_trgm` (relocatable, but
  `idx_locations_name_trgm` depends on `gin_trgm_ops` — deferred as the move
  is riskier than the finding), `request_commodity` being callable by
  signed-in users (intentional — it is the screen-16 RPC), the
  `auth_allow_anonymous_sign_ins` warnings (by design, TR §2.3), and INFO-level
  `rls_enabled_no_policy` on the service-role-only tables (correct posture:
  RLS on, no policy, so nothing is reachable through the API). Rationale for
  each is in `20260902000002_security_advisor_followup.sql`.

- **`public.spatial_ref_sys` was writable by `anon` — RESOLVED 2026-09-02** by
  dropping PostGIS (`20260902000003_drop_unused_postgis.sql`). Recorded here
  because the failure mode is worth not repeating: the ACL was
  `anon=arwdDxtm/supabase_admin` — every privilege including DELETE/TRUNCATE,
  reachable over the Data API with the publishable key. Verified live before
  the fix (`GET` 200, filtered `DELETE` 204) and after (both 404). The two
  earlier migrations aimed at it (`20260901221012`, and the fix half of
  `20260902000002`) could never have worked: migrations run as `postgres`, the
  grants were issued by `supabase_admin`, and Postgres lets you revoke only
  grants you issued yourself — a revoke that revokes nothing raises a WARNING,
  not an ERROR, so both migrations "succeeded" while changing nothing. **A
  migration applying cleanly is not evidence its grants took effect; check
  `relacl`/`proacl` afterwards.** Relocating the extension was not an option
  either (postgis 3.3.7 is `relocatable = false`). Dropping it was safe because
  nothing used it — see the migration header for the five checks. If the map
  ever needs real spatial types, install PostGIS into `extensions`, never
  `public`.

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
