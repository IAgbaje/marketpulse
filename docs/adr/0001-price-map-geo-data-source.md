# ADR 0001 — Price Map geo-data source, and why the map itself isn't built yet

**Decision:** Use **geoBoundaries** (CC BY 4.0) as the Nigeria LGA-level
(ADM2) boundary source when the Price Map screen is built, not OCHA-HDX.

**Alternatives considered:**
- **OCHA-HDX (COD-AB)** — also complete (774 LGAs), also commercially usable
  (CC BY-IGO, attribution required), reviewed more recently (30 Oct 2025 vs.
  geoBoundaries' Feb 2023 source data). Rejected only on convenience: its
  GeoJSON ships zipped behind a dataset-resource URL; geoBoundaries serves a
  raw GeoJSON file directly from GitHub, one less unpack step in the seed
  pipeline. Either is licensing-safe — this is a tie-break, not a rejection.
- **Do nothing / hand-draw boundaries** — rejected, not a real option at
  Nigeria's 774-LGA granularity.

**Why:** TR §8 open item 3 flagged this as unresolved before Stage 8. Checked
against primary sources (both sites' own license pages, independently
corroborated via a second search) on 2026-09-01: geoBoundaries states CC BY
4.0, permits commercial use, requires attribution to geoBoundaries (Runfola
et al., 2020). Nigeria ADM2 is complete (774 units), boundary year 2022,
source data updated Feb 2023.

**Revisit trigger:** if geoBoundaries' Nigeria data goes stale relative to
OCHA-HDX's more recent review pass, or if a licence term changes on either
source.

---

## Map library and render approach — decided 2026-09-02

- **Library: none.** No MapLibre GL, no Leaflet. The Price Map is a
  **hand-rolled inline-SVG choropleth** of Lagos-State LGAs (≈20 polygons
  from the geoBoundaries ADM2 file above, pre-simplified and committed as a
  small static asset), filled by median price with market pins on top, on
  the `/map` route as a lazy-loaded chunk. Rationale: the bundle-size gate
  (`scripts/check-bundle-size.mjs`) sums **all** emitted JS, not just the
  initial route, so code-splitting does not buy back a library's weight —
  and a ~20-polygon choropleth with pan/zoom via `viewBox` needs no
  library. Zero new runtime dependency, trivially inside the 300KB budget.
- **Interactivity:** pan/zoom + tap-a-LGA/pin → drill to Market Detail.
  No basemap tiles (no tile-provider key, no external tile dependency) —
  the choropleth polygons are the map.

## What is actually blocking the build now: **data readiness, not engineering**

The map has nothing to render yet. `locations` has `centroid_lat` /
`centroid_lon` columns (migration 20260831000001) but they are **unpopulated**,
and only a **minimal 5-row Lagos bootstrap** is seeded — one state, a couple
of LGAs, a market or two, no coordinates. A choropleth needs the LGA polygon
set loaded and market rows with real coordinates.

**Unblock sequence (all data/seed work, no app-code decisions left):**
1. Add the pre-simplified Lagos-LGA GeoJSON as a committed static asset.
2. Seed the full Lagos LGA + market hierarchy with `centroid_lat/lon`
   populated (extends `marketpulse/data/*.json` + the seed generator).
3. Then the `/map` screen is a mechanical build against the decisions above.

Until then the route serves the list-based **MarketsList / MarketDetail**,
and **Price Comparison** and **Basket Comparison** — the three Stage 8
screens that carry the decision-support value — are built and shipping.
The map is a V1 visual enhancement on top of that, gated on the seed, not
on any open engineering question.
