import { Client } from 'pg';

/**
 * Integration tests run against a REAL Postgres with migrations 0001–0004 applied
 * (local `supabase start`, or a dedicated MarketPulse cloud project — never Pulse).
 *
 * Set SUPABASE_DB_URL to enable them, e.g.:
 *   local:  postgresql://postgres:postgres@127.0.0.1:54322/postgres
 *   cloud:  the "Connection string / URI" from Project Settings → Database
 *
 * Without it the suites `describe.skipIf` out cleanly.
 */
export const DB_URL = process.env.SUPABASE_DB_URL ?? '';
export const HAVE_DB = DB_URL.length > 0;

export async function connect(): Promise<Client> {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  return client;
}

/** A short random suffix so parallel runs / reruns don't collide. */
export const RUN = Math.random().toString(36).slice(2, 8);

/** Insert a bare auth.users row and let 0001's trigger mirror it into public.users. */
export async function makeUser(c: Client, opts: { anonymous: boolean }): Promise<string> {
  const { rows } = await c.query(
    `INSERT INTO auth.users (instance_id, id, aud, role, is_anonymous, created_at, updated_at,
                             raw_app_meta_data, raw_user_meta_data)
     VALUES ('00000000-0000-0000-0000-000000000000', gen_random_uuid(),
             'authenticated', 'authenticated', $1, now(), now(),
             jsonb_build_object('is_anonymous', $1), '{}'::jsonb)
     RETURNING id`,
    [opts.anonymous],
  );
  return rows[0].id as string;
}

/** A confirmed trip + one line. trip_date defaults to today (⇒ same_day). */
export async function makeTripWithLine(
  c: Client,
  args: {
    userId: string;
    marketId: string;
    commodityId: string;
    tripDate?: string; // 'YYYY-MM-DD'
    paidKobo: number;
    qtyBase: number;
  },
): Promise<{ tripId: string; lineId: string }> {
  const trip = await c.query(
    `INSERT INTO shopping_trips (user_id, client_trip_id, market_id, trip_date, status, currency)
     VALUES ($1, gen_random_uuid(), $2, COALESCE($3::date, now()::date), 'confirmed', 'NGN')
     RETURNING id`,
    [args.userId, args.marketId, args.tripDate ?? null],
  );
  const tripId = trip.rows[0].id as string;
  const line = await c.query(
    `INSERT INTO purchase_lines
       (trip_id, client_line_id, commodity_id, unit_code, qty_entered, qty_in_base_unit,
        paid_price_kobo, currency, purchase_form)
     VALUES ($1, gen_random_uuid(), $2, 'g', $3, $3, $4, 'NGN', 'loose')
     RETURNING id`,
    [tripId, args.commodityId, args.qtyBase, args.paidKobo],
  );
  return { tripId, lineId: line.rows[0].id as string };
}

/** Remove everything this run created. Order respects FKs. */
export async function cleanup(c: Client, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await c.query(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [userIds]);
  await c.query(
    `DELETE FROM price_aggregates WHERE commodity_id LIKE 'itest_%' OR market_id IN
       (SELECT id FROM locations WHERE name LIKE 'itest_%')`,
  );
  await c.query(`DELETE FROM aggregate_refresh_queue WHERE commodity_id LIKE 'itest_%'`);
  await c.query(`DELETE FROM commodities WHERE id LIKE 'itest_%'`);
  await c.query(`DELETE FROM locations WHERE name LIKE 'itest_%'`);
  await c.query(`DELETE FROM ocr_spend_ledger WHERE ip_hash LIKE 'itest_%'`);
}
