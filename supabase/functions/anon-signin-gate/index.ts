/**
 * Edge Function: anon-signin-gate
 * Blocking item 3, control (c) (Technical Requirements §6.1).
 *
 * The silent first-launch anonymous sign-in (§9.2) is preserved for normal
 * users. This function fronts it so that when an ip_hash shows a burst of
 * anonymous sign-ins (the session-minting-abuse signal), the NEXT sign-in from
 * that ip_hash must carry a CAPTCHA token. Normal users never see a challenge.
 *
 * Client flow:
 *   1. POST here with no body.
 *   2a. 200 { status: 'ok', session } → use the session, done (silent path).
 *   2b. 200 { status: 'captcha_required' } → render Turnstile/hCaptcha, then
 *       POST again with { captchaToken } → 200 { status: 'ok', session }.
 *
 * Deploy:  supabase functions deploy anon-signin-gate
 * Secrets: OCR_IP_SALT, CAPTCHA_SECRET, CAPTCHA_VERIFY_URL
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const IP_SALT = Deno.env.get('OCR_IP_SALT')!;
const CAPTCHA_SECRET = Deno.env.get('CAPTCHA_SECRET')!;
const CAPTCHA_VERIFY_URL =
  Deno.env.get('CAPTCHA_VERIFY_URL') ?? 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function ipHash(req: Request): Promise<string> {
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() || 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${IP_SALT}:${ip}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function captchaOk(token: string, ip: string): Promise<boolean> {
  try {
    const form = new URLSearchParams({ secret: CAPTCHA_SECRET, response: token, remoteip: ip });
    const res = await fetch(CAPTCHA_VERIFY_URL, { method: 'POST', body: form });
    const body = await res.json();
    return body?.success === true;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const ih = await ipHash(req);
  const rawIp = (req.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() || 'unknown';

  let body: { captchaToken?: string } = {};
  try {
    body = (await req.json()) as { captchaToken?: string };
  } catch {
    body = {};
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: mustChallenge } = await admin.rpc('anon_signin_should_challenge', {
    p_ip_hash: ih,
  });

  if (mustChallenge === true) {
    if (!body.captchaToken) return json(200, { status: 'captcha_required' });
    if (!(await captchaOk(body.captchaToken, rawIp))) {
      return json(200, { status: 'captcha_required', reason: 'verification_failed' });
    }
  }

  // Mint the anonymous session server-side (records nothing extra; the ip_hash
  // burst is already tracked via ocr_ip_rate_limits by the proxy path — here we
  // add one row so repeated gate calls also count toward the suspicion signal).
  await admin.from('ocr_ip_rate_limits').insert({ ip_hash: ih });

  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await anon.auth.signInAnonymously();
  if (error || !data.session) return json(500, { error: 'anon_signin_failed', detail: error?.message });

  return json(200, { status: 'ok', session: data.session });
});
