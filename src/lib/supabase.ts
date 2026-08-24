/**
 * Supabase client and silent anonymous-session bootstrap.
 *
 * Spec: Technical Requirements §2.3, §7.1; Handover §9.2, §17.2.
 *
 * A silent anonymous session is created at first launch, before any capture.
 * This is a durability measure, not a registration flow: IndexedDB alone is
 * evictable by the browser under storage pressure on exactly the low-end
 * Android devices this product targets, and eviction is silent with no
 * recovery path. The user never sees a sign-in screen for this.
 */

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env["VITE_SUPABASE_URL"];
const anonKey = import.meta.env["VITE_SUPABASE_ANON_KEY"];

if (!url || !anonKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local and fill it in.",
  );
}

export const supabase: SupabaseClient = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

/** Serialises bootstrap across tabs where the Web Locks API is available. */
const BOOTSTRAP_LOCK = "marketpulse.auth.bootstrap";

async function withBootstrapLock<T>(fn: () => Promise<T>): Promise<T> {
  // Two tabs opened on a cold first launch would otherwise each mint their own
  // anonymous session, splitting one real person across two auth.uid()s from
  // minute one — the orphaning failure in §2.3, self-inflicted on day one.
  if (typeof navigator !== "undefined" && "locks" in navigator) {
    return navigator.locks.request(BOOTSTRAP_LOCK, fn);
  }
  // Older browsers: no cross-tab guarantee available. Proceed rather than
  // block capture — a duplicated session is recoverable, a dead app is not.
  return fn();
}

/**
 * Returns the current session, creating a silent anonymous one if none exists.
 * Safe to call concurrently and on every launch.
 */
export async function ensureSession(): Promise<Session> {
  return withBootstrapLock(async () => {
    const { data: existing, error: readError } = await supabase.auth.getSession();
    if (readError) throw readError;
    if (existing.session) return existing.session;

    const { data, error } = await supabase.auth.signInAnonymously();
    if (error) throw error;
    if (!data.session) {
      throw new Error("Anonymous sign-in returned no session");
    }
    return data.session;
  });
}

/**
 * Ask the browser to make local storage persistent, and report whether it
 * agreed. Chrome frequently DENIES this for a non-installed origin, which is
 * precisely why the anonymous-session sync above is the real durability
 * guarantee rather than a belt-and-braces extra. The denial rate is a metric
 * worth watching (§9, storage eviction rate).
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
