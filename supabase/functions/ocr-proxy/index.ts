/**
 * Edge Function: ocr-proxy
 * Blocking item 3 (Technical Requirements §6.1).
 *
 * The ONLY path to the vision model. Protects the API key (a client-side vision
 * call would expose it) and enforces the three cost controls before every
 * dispatch:
 *
 *   1. ip_hash rate limit        — salted hash, never raw IP (NDPA).
 *   2. per-session rate limit    — kept, but explicitly not load-bearing.
 *   3. GLOBAL spend circuit-breaker (reserve_ocr_budget) — atomic, pre-dispatch.
 *      On breach: respond 200 { degrade: 'manual_entry' } — ALL callers fall
 *      back to manual entry (US-1.2). This is what actually bounds cost when
 *      identities are free to mint.
 *
 * After the model returns, reconcile_ocr_spend() trues up the reservation to the
 * real token usage.
 *
 * Deploy:  supabase functions deploy ocr-proxy
 * Secrets: OCR_IP_SALT, VISION_API_URL, VISION_API_KEY, VISION_MODEL
 *          (+ platform-provided SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY)
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  DEFAULT_VISION_PRICING,
  MAX_IMAGES_PER_OCR_CALL,
  decideOcrGate,
  estimateOcrCostMicroUsd,
} from '../../../lib/ocr/costModel.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const IP_SALT = Deno.env.get('OCR_IP_SALT')!;
const VISION_API_URL = Deno.env.get('VISION_API_URL')!;
const VISION_API_KEY = Deno.env.get('VISION_API_KEY')!;
const VISION_MODEL = Deno.env.get('VISION_MODEL') ?? 'vision-default';

// Windows: ip — 20 requests / hour; session — 15 requests / day.
const IP_WINDOW = '1 hour';
const IP_MAX = 20;
const SESSION_WINDOW = '1 day';
const SESSION_MAX = 15;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function ipHash(req: Request): Promise<string> {
  const fwd = req.headers.get('x-forwarded-for') ?? '';
  const ip = fwd.split(',')[0]?.trim() || 'unknown';
  const bytes = new TextEncoder().encode(`${IP_SALT}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json(401, { error: 'missing_bearer_token' });

  // Authenticated anonymous session is required.
  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await asCaller.auth.getUser();
  if (userErr || !userData.user) return json(401, { error: 'invalid_token' });
  const sessionUserId = userData.user.id;

  let payload: {
    images: string[]; // base64 data URIs
    estimatedImageTokens?: number;
    promptTokens?: number;
    maxOutputTokens?: number;
  };
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  if (!Array.isArray(payload.images) || payload.images.length < 1) {
    return json(400, { error: 'no_images' });
  }
  if (payload.images.length > MAX_IMAGES_PER_OCR_CALL) {
    return json(400, { error: 'too_many_images', max: MAX_IMAGES_PER_OCR_CALL });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const ih = await ipHash(req);

  const [{ data: ipAllowed }, { data: sessionAllowed }] = await Promise.all([
    admin.rpc('record_and_check_ocr_ip', { p_ip_hash: ih, p_window: IP_WINDOW, p_max: IP_MAX }),
    admin.rpc('record_and_check_ocr_session', {
      p_user: sessionUserId,
      p_window: SESSION_WINDOW,
      p_max: SESSION_MAX,
    }),
  ]);

  const estimate = estimateOcrCostMicroUsd(
    {
      imageCount: payload.images.length,
      estimatedImageTokens: payload.estimatedImageTokens ?? 1600 * payload.images.length,
      promptTokens: payload.promptTokens ?? 400,
      maxOutputTokens: payload.maxOutputTokens ?? 1200,
    },
    DEFAULT_VISION_PRICING,
  );

  let ledgerId: string | null = null;
  let budgetReserved = false;
  {
    const { data, error } = await admin.rpc('reserve_ocr_budget', {
      p_estimate_micro_usd: estimate,
      p_model: VISION_MODEL,
      p_session_user_id: sessionUserId,
      p_ip_hash: ih,
    });
    if (!error && data) {
      ledgerId = data as string;
      budgetReserved = true;
    } else if (error && !/ocr_budget_exhausted/.test(error.message)) {
      return json(500, { error: 'budget_check_failed', detail: error.message });
    }
  }

  const gate = decideOcrGate({
    ipAllowed: ipAllowed !== false,
    sessionAllowed: sessionAllowed !== false,
    budgetReserved,
  });

  if (gate.action === 'reject') {
    return json(429, { error: gate.reason, degrade: 'manual_entry' });
  }
  if (gate.action === 'degrade_to_manual') {
    await admin.from('ocr_spend_ledger').insert({
      session_user_id: sessionUserId,
      ip_hash: ih,
      estimated_micro_usd: 0,
      model: VISION_MODEL,
      outcome: 'degraded_before_dispatch',
    });
    return json(200, { degrade: 'manual_entry', reason: gate.reason });
  }

  // --- dispatch to the vision model -----------------------------------------
  let succeeded = false;
  let actualMicroUsd = estimate;
  let extraction: unknown = null;
  try {
    const res = await fetch(VISION_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${VISION_API_KEY}` },
      body: JSON.stringify({ model: VISION_MODEL, images: payload.images }),
    });
    const body = await res.json();
    succeeded = res.ok;
    extraction = body?.extraction ?? body;
    if (typeof body?.usage?.total_cost_micro_usd === 'number') {
      actualMicroUsd = Math.max(0, Math.ceil(body.usage.total_cost_micro_usd));
    }
  } catch (e) {
    succeeded = false;
    extraction = { error: 'vision_upstream_unreachable', detail: String(e) };
  }

  if (ledgerId) {
    await admin.rpc('reconcile_ocr_spend', {
      p_ledger_id: ledgerId,
      p_actual_micro_usd: actualMicroUsd,
      p_succeeded: succeeded,
    });
  }

  if (!succeeded) {
    return json(200, { degrade: 'manual_entry', reason: 'vision_failed' });
  }
  return json(200, { extraction });
});
