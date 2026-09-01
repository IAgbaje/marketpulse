# Integration tests

DB-level checks for the four Technical Requirements §10 blocking items. They run
against a **real Postgres with all four migrations + `seed.sql` applied** —
the MarketPulse project (`qkohesyqyknavriyhlsc`), never Pulse.

## Run

```powershell
# 1. apply the schema to MarketPulse
supabase link --project-ref qkohesyqyknavriyhlsc
supabase db push                    # applies the four migrations
#   then run supabase/seed.sql in the dashboard SQL Editor
#   (local alternative: `supabase start` + `supabase db reset` — needs Docker)

# 2. give the tests a connection string and run them
$env:SUPABASE_DB_URL = "<Project Settings → Database → Connection string (URI)>"
npm run test:integration
```

Without `SUPABASE_DB_URL` the suite `describe.skipIf`s out, so `npm test` stays
green with no database.

## What each test covers

| Test | Blocker | Asserts |
|---|---|---|
| `merge_anonymous_account …` | 2 | re-parents trips + lines to A; `account_merges` audit row; same idempotency key ⇒ no second move; a permanent (non-anon) source is rejected |
| `reserve_ocr_budget …` | 3 | atomic day-window reservation; a reservation that would breach the cap raises `ocr_budget_exhausted` and does **not** leave the window over-committed; `reconcile_ocr_spend` trues the window down to actual |
| `crowd band … 5 distinct users` | 1 / §7 | band columns stay `NULL` at 4 distinct users; publish p25 ≤ median ≤ p75 at 5; a `recall` trip does not raise the count |
| `resolve_commodity_request(merge_alias) …` | 0004 | parked lines re-point to the target commodity; provisional row retired; alias recorded; request → `merged`; second action is a no-op |

## Not covered here (need a running Edge runtime, not just Postgres)

- `merge-anonymous-data` / `ocr-proxy` / `anon-signin-gate` end to end — deploy
  them (`supabase functions serve` locally) and hit the HTTP endpoints.
- `request_commodity()`'s `auth.uid()` guard — exercised only through a real
  authenticated RPC call (`supabase-js` `.rpc('request_commodity', …)` with an
  anon session), not a raw psql connection.
- `pg_cron` actually firing the drain on schedule (the tests call
  `drain_aggregate_refresh_queue()` directly).
