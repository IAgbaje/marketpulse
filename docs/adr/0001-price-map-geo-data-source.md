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

## What this ADR does NOT decide: the map library, or when to build it

Enabling this data source is not the same as building the map. Rendering an
actual interactive map needs a client-side mapping library, and every
mainstream option (MapLibre GL JS, Leaflet + a tile provider, etc.) adds
meaningfully to the JS bundle — likely enough, on its own, to blow past this
app's stated <300KB gzipped budget (TR §12; currently ~160KB). That's a real
product trade-off (map interactivity vs. load time on the low-end-Android,
variable-network audience this product targets), not a default I'm
comfortable picking silently on an explicit, stated constraint.

**Not decided, deliberately:** library choice, and whether the map route
should be a lazy-loaded chunk (keeping it off the main bundle entirely) or a
separate lighter-weight approach (e.g. a static/server-rendered image map
for V1, deferring true interactivity). Market Detail, Price Comparison, and
Basket Comparison — the other three Stage 8 screens — don't depend on this
and are built.
