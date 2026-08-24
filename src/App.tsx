import { useEffect, useState } from "react";
import { ensureSession, requestPersistentStorage } from "./lib/supabase.js";

type BootState =
  | { status: "loading" }
  | { status: "ready"; userId: string; persistent: boolean }
  | { status: "error"; message: string };

/**
 * Boot shell. The silent anonymous session is established before any capture
 * surface renders, so the first write already has a durable owner (§9.2).
 *
 * This is scaffolding: the capture flow (stage 2) replaces the ready state.
 */
export function App() {
  const [state, setState] = useState<BootState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const session = await ensureSession();
        const persistent = await requestPersistentStorage();
        if (cancelled) return;
        setState({ status: "ready", userId: session.user.id, persistent });
      } catch (err) {
        if (cancelled) return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return <main aria-busy="true">Setting things up…</main>;
  }

  if (state.status === "error") {
    // Errors state what happened and what to do next (§15.2).
    return (
      <main role="alert">
        <h1>Couldn&rsquo;t start</h1>
        <p>{state.message}</p>
        <button type="button" onClick={() => location.reload()}>
          Try again
        </button>
      </main>
    );
  }

  return (
    <main>
      <h1>MarketPulse</h1>
      <p>Session ready.</p>
      <dl>
        <dt>User</dt>
        <dd>
          <code>{state.userId}</code>
        </dd>
        <dt>Persistent storage</dt>
        <dd>{state.persistent ? "granted" : "denied — sync is the durability guarantee"}</dd>
      </dl>
    </main>
  );
}
