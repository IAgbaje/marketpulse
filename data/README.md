# Commodity master list — ownership & the request queue

**Closes blocking item 4 (Technical Requirements §8.1).**

§8.1 is *"a staffing decision, not an engineering task"*. The engineering half is
done — the three data files here plus `tests/data/masterList.test.ts` make the
list real, structurally validated, and safe to edit. What remains is an owner and
an SLA. This file specifies both so the decision is small.

---

## The artifacts (done)

| File | What it is | Size |
|---|---|---|
| `commodities.json` | MVP master list: id, canonical name, aliases, category, base unit, purchase forms, substitute group, perishable/grade flags, NBS HFCP mapping | 69 items |
| `substitute-groups.json` | 17 **disjoint** substitute groups — powers the narrative sentence only, never a ₦ component | 17 groups |
| `unit-conversions.json` | ~30 informal-measure → base-unit conversions as **exact rationals** with a `confidence` grade that must propagate downstream (§11.5) | 31 pairs |

`npm test` fails the build on: duplicate ids, a dangling substitute-group
reference, a commodity in two groups, a conversion whose base unit disagrees with
its commodity, a `gradeSensitive` conversion marked high-confidence, or any
high-salience perishable that has been given an NBS mapping it should not have.

### Deliberate coverage decisions

- **The six high-salience perishables** (`tomato_fresh`, `pepper_rodo`, `onion`,
  `palm_oil`, `chicken_frozen`, fresh fish) carry `nbsHfcpMapped: false`. There
  is **no seeded "Others paid" band** for them until stage 7 + real user density.
  The screen-16/annotation empty state (Handover §15.3) already handles this
  honestly — do not let the stage-4 build-order label imply otherwise (§4).
- **`gradeSensitive: true`** on yam, fresh tomato, fresh pepper, onion, live
  chicken, and the basket/tuber conversions: the point estimate is a placeholder.
  Aggregates for these must disclose the grade caveat (§11.2) rather than present
  a false precision.
- **Base units**: `g` for everything weighed, `ml` for oils and liquid dairy,
  `piece` for eggs and seasoning cubes. The decomposition engine aggregates in
  these units; changing a base unit after launch means re-running history.

---

## Ownership (the decision)

| Role | Scope | Who | Cost |
|---|---|---|---|
| **Master-list owner** | Owns `commodities.json`, `substitute-groups.json`, `unit-conversions.json`. Approves additions, keeps aliases current, sets confidence grades. | **Founder / PM initially** — this is ~1–2 h/week at MVP scale, not a hire. Hand to a data/ops contributor once request volume exceeds ~10/week. | Low |
| **Request-queue triage** | Works screen-16 submissions (`commodity_request_pending`). | **Same owner initially**, on the SLA below. Rotate to a contributor pool at scale. | Low |

There is no dedicated hire on the MVP critical path. The escalation trigger is
volume, and it is measurable (`commodity_requests` table, weekly count).

---

## Request queue — process & SLA

Screen 16 (`/capture/pending`) currently has *no reviewer, no SLA, no owner*
(§8.1). Fix:

1. **Capture.** A user requesting a commodity writes a `commodity_requests` row:
   `{ raw_text, normalized_guess, requester_user_id, market_id, created_at, status='pending' }`.
   The user's line is saved immediately against the `normalized_guess` (or a
   provisional commodity) so capture never dead-ends (§15.2).
2. **SLA: 48 hours** from submission to a decision (`approved` → new commodity /
   alias merged; `rejected` → reason; `merged` → alias added to an existing
   commodity). Breach of SLA raises the row into a weekly digest.
3. **Reviewer flow — one screen.** A Supabase dashboard view (`commodity_requests
   WHERE status='pending' ORDER BY created_at`) plus three actions:
   - *Merge as alias* → append `raw_text` to an existing commodity's `aliases`,
     re-point the user's line, close.
   - *Create commodity* → add to `commodities.json` via PR (the validator test
     gates it), assign category/base-unit/group, re-point the line, close.
   - *Reject* → enumerated reason (`not_a_commodity`, `duplicate`,
     `out_of_scope_non_food`, `insufficient_detail`), close.
4. **Backfill.** On *merge* or *create*, a nightly job re-points every pending
   line that matched the same `raw_text` and enqueues the affected aggregate
   buckets for recompute.
5. **Aging.** A request older than 7 days without resolution escalates in the
   digest — aging requests are simultaneously a degraded capture experience and a
   hole in the §13 sellable asset.

The `commodity_requests` table + the dashboard view are a small migration
(`0004_commodity_requests.sql`, not yet written — trivial, unblocked once the
owner is named).

---

## Editing rules

- Add a commodity → add its row, set `substituteGroup` only if it genuinely
  substitutes for the other members, run `npm test`.
- New substitute group → keep it **disjoint** from existing groups; the pairing
  logic assumes one group per commodity.
- New conversion → exact rational only; set `confidence` honestly; if the true
  factor depends on size/grade, set `gradeSensitive: true` and never `high`.
- Never delete a commodity that has purchase history — deprecate via a
  `retired: true` flag instead (design-for-deletion; retro-active deletes orphan
  aggregates).
