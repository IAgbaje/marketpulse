import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from 'pg';
import {
  HAVE_DB,
  RUN,
  connect,
  makeUser,
  makeTripWithLine,
  cleanup,
} from './helpers';

/**
 * The four named checks from Technical Requirements §10, at the database level.
 * Enabled only when SUPABASE_DB_URL points at a Postgres with 0001–0004 applied.
 *
 *   npm run test:integration
 */
describe.skipIf(!HAVE_DB)('MarketPulse schema — TR §10 blocking-item checks', () => {
  let c: Client;
  const users: string[] = [];
  let marketId: string;
  const commodityId = `itest_rice_${RUN}`;

  beforeAll(async () => {
    c = await connect();
    const m = await c.query(
      `INSERT INTO locations (level, name, market_type) VALUES ('market', $1, 'open_market') RETURNING id`,
      [`itest_market_${RUN}`],
    );
    marketId = m.rows[0].id;
    await c.query(
      `INSERT INTO commodities (id, canonical_name, category, base_unit) VALUES ($1, 'iTest Rice', 'grains_tubers', 'g')`,
      [commodityId],
    );
  });

  afterAll(async () => {
    await cleanup(c, users);
    await c.end();
  });

  // -- Blocker 2 -------------------------------------------------------------
  it('merge_anonymous_account re-parents everything, is idempotent, and refuses a non-anon source', async () => {
    const B = await makeUser(c, { anonymous: true });
    const A = await makeUser(c, { anonymous: false });
    users.push(B, A);

    await makeTripWithLine(c, { userId: B, marketId, commodityId, paidKobo: 300000, qtyBase: 10000 });

    const key = `itest-merge-${RUN}`;
    const first = await c.query(`SELECT * FROM merge_anonymous_account($1, $2, $3)`, [B, A, key]);
    expect(first.rows[0].trips_moved).toBe(1);
    expect(first.rows[0].purchase_lines_moved).toBe(1);

    const tripsUnderB = await c.query(`SELECT count(*)::int n FROM shopping_trips WHERE user_id = $1`, [B]);
    const tripsUnderA = await c.query(`SELECT count(*)::int n FROM shopping_trips WHERE user_id = $1`, [A]);
    expect(tripsUnderB.rows[0].n).toBe(0);
    expect(tripsUnderA.rows[0].n).toBe(1);

    // Same key ⇒ same audit row, no second move.
    const again = await c.query(`SELECT * FROM merge_anonymous_account($1, $2, $3)`, [B, A, key]);
    expect(again.rows[0].id).toBe(first.rows[0].id);
    const auditCount = await c.query(`SELECT count(*)::int n FROM account_merges WHERE idempotency_key = $1`, [key]);
    expect(auditCount.rows[0].n).toBe(1);

    // Anon-only guard: A (permanent) cannot be a merge source.
    await expect(
      c.query(`SELECT merge_anonymous_account($1, $2, $3)`, [A, B, `${key}-bad`]),
    ).rejects.toThrow(/not an anonymous user/);
  });

  // -- Blocker 3 ----------------------------------------------------------------
  it('reserve_ocr_budget bounds spend atomically and reconcile trues it up', async () => {
    const U = await makeUser(c, { anonymous: true });
    users.push(U);
    const ip = `itest_${RUN}`;

    await c.query(`UPDATE ocr_budget_config SET daily_cap_micro_usd = 100, monthly_cap_micro_usd = 1000000 WHERE id`);
    try {
      const first = await c.query(`SELECT reserve_ocr_budget(60, 'itest-model', $1, $2) AS ledger_id`, [U, ip]);
      expect(first.rows[0].ledger_id).toBeTruthy();

      // 60 + 60 > 100 ⇒ the second reservation must fail, and must not leave the
      // day window over-committed (the failed day reserve rolls back).
      await expect(
        c.query(`SELECT reserve_ocr_budget(60, 'itest-model', $1, $2)`, [U, ip]),
      ).rejects.toThrow(/ocr_budget_exhausted/);

      const day = await c.query(
        `SELECT spent_micro_usd::int s FROM ocr_budget_windows
          WHERE kind = 'day' AND window_key = 'day:' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
      );
      expect(day.rows[0].s).toBe(60);

      // Reconcile the first dispatch to a lower actual ⇒ window frees up.
      await c.query(`SELECT reconcile_ocr_spend($1, 40, true)`, [first.rows[0].ledger_id]);
      const day2 = await c.query(
        `SELECT spent_micro_usd::int s FROM ocr_budget_windows
          WHERE kind = 'day' AND window_key = 'day:' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
      );
      expect(day2.rows[0].s).toBe(40);
    } finally {
      await c.query(`UPDATE ocr_budget_config SET daily_cap_micro_usd = 5000000, monthly_cap_micro_usd = 80000000 WHERE id`);
    }
  });

  // -- Blocker 1 / §7 --------------------------------------------------------
  it('the crowd band stays NULL below 5 distinct users, then publishes at 5 — recall trips excluded', async () => {
    const month = `${new Date().toISOString().slice(0, 7)}-01`;

    // 4 distinct users → below the floor.
    for (let i = 0; i < 4; i++) {
      const u = await makeUser(c, { anonymous: true });
      users.push(u);
      await makeTripWithLine(c, {
        userId: u, marketId, commodityId, tripDate: month,
        paidKobo: 300000 + i * 1000, qtyBase: 10000,
      });
    }
    await c.query(`SELECT drain_aggregate_refresh_queue()`);
    let band = await c.query(
      `SELECT distinct_user_count, median_kobo FROM price_aggregates
        WHERE commodity_id = $1 AND market_id = $2 AND period_month = $3`,
      [commodityId, marketId, month],
    );
    expect(band.rows[0].distinct_user_count).toBe(4);
    expect(band.rows[0].median_kobo).toBeNull();

    // 5th distinct user → band publishes.
    const u5 = await makeUser(c, { anonymous: true });
    users.push(u5);
    await makeTripWithLine(c, {
      userId: u5, marketId, commodityId, tripDate: month, paidKobo: 320000, qtyBase: 10000,
    });
    await c.query(`SELECT drain_aggregate_refresh_queue()`);
    band = await c.query(
      `SELECT distinct_user_count, median_kobo, p25_kobo, p75_kobo FROM price_aggregates
        WHERE commodity_id = $1 AND market_id = $2 AND period_month = $3`,
      [commodityId, marketId, month],
    );
    expect(band.rows[0].distinct_user_count).toBe(5);
    expect(band.rows[0].median_kobo).not.toBeNull();
    expect(Number(band.rows[0].p25_kobo)).toBeLessThanOrEqual(Number(band.rows[0].median_kobo));
    expect(Number(band.rows[0].p75_kobo)).toBeGreaterThanOrEqual(Number(band.rows[0].median_kobo));

    // A recall trip (trip_date > 48h ago ⇒ trigger flags it) must NOT move the count.
    const u6 = await makeUser(c, { anonymous: true });
    users.push(u6);
    const old = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10);
    const t6 = await makeTripWithLine(c, {
      userId: u6, marketId, commodityId, tripDate: old, paidKobo: 999999, qtyBase: 10000,
    });
    const cm = await c.query(`SELECT capture_method FROM shopping_trips WHERE id = $1`, [t6.tripId]);
    expect(cm.rows[0].capture_method).toBe('recall');

    // that trip is in a different month bucket; assert the current-month band is unchanged
    await c.query(`SELECT drain_aggregate_refresh_queue()`);
    band = await c.query(
      `SELECT distinct_user_count FROM price_aggregates
        WHERE commodity_id = $1 AND market_id = $2 AND period_month = $3`,
      [commodityId, marketId, month],
    );
    expect(band.rows[0].distinct_user_count).toBe(5);
  });

  // -- 0004 ---------------------------------------------------------------------
  // The reviewer path (resolve_commodity_request) tested directly. request_commodity's
  // auth.uid() guard needs an RPC/Edge-level test — see tests/integration/README.md.
  it('resolve_commodity_request(merge_alias) re-points parked lines and retires the provisional', async () => {
    const u = await makeUser(c, { anonymous: true });
    users.push(u);
    const provId = `itest_prov_${RUN}`;
    const targetId = `itest_target_${RUN}`;

    await c.query(
      `INSERT INTO commodities (id, canonical_name, category, base_unit, provisional) VALUES
         ($1, 'iTest Provisional', 'unknown', 'g', true),
         ($2, 'iTest Target', 'vegetables', 'g', false)`,
      [provId, targetId],
    );
    const reqRow = await c.query(
      `INSERT INTO commodity_requests (raw_text, normalized_guess, requester_user_id, market_id, provisional_commodity_id)
       VALUES ('itest ugwu bundle', 'itest_ugu', $1, $2, $3) RETURNING id`,
      [u, marketId, provId],
    );
    await makeTripWithLine(c, { userId: u, marketId, commodityId: provId, paidKobo: 50000, qtyBase: 500 });

    await c.query(
      `SELECT resolve_commodity_request($1, 'merge_alias', 'itest-reviewer', $2)`,
      [reqRow.rows[0].id, targetId],
    );

    const moved = await c.query(
      `SELECT count(*)::int n FROM purchase_lines WHERE commodity_id = $1 AND user_id = $2`,
      [targetId, u],
    );
    expect(moved.rows[0].n).toBe(1);
    const prov = await c.query(`SELECT retired, provisional FROM commodities WHERE id = $1`, [provId]);
    expect(prov.rows[0].retired).toBe(true);
    expect(prov.rows[0].provisional).toBe(false);
    const status = await c.query(`SELECT status, resolved_commodity_id FROM commodity_requests WHERE id = $1`, [reqRow.rows[0].id]);
    expect(status.rows[0].status).toBe('merged');
    expect(status.rows[0].resolved_commodity_id).toBe(targetId);
    const alias = await c.query(`SELECT count(*)::int n FROM commodity_aliases WHERE commodity_id = $1 AND alias = 'itest ugwu bundle'`, [targetId]);
    expect(alias.rows[0].n).toBe(1);

    // idempotent — a resolved request ignores a second action
    const again = await c.query(`SELECT status FROM resolve_commodity_request($1, 'reject', 'x', NULL, 'duplicate')`, [reqRow.rows[0].id]);
    expect(again.rows[0].status).toBe('merged');
    // (itest_% commodities + cascaded requests are removed by afterAll cleanup)
  });
});
