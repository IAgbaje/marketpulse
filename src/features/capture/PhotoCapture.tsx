import { useState } from "react";
import { useLocation as useRouterLocation } from "wouter";
import { captureReceipts, MAX_IMAGES_PER_OCR_CALL, type OcrResult } from "../../lib/ocr.js";

/**
 * Screen 5 — Photo capture (§4 stage 6, "processing state"). Fronts the
 * `ocr-proxy` Edge Function, which owns every cost/rate-limit decision
 * server-side (TR §6.1, blocking item 3) — this screen only shapes the
 * request and reacts honestly to what comes back:
 *
 *  - `degrade` (budget exhausted / rate-limited / the vision call itself
 *    failed) — this is the DESIGNED fallback (US-1.2), not an error state.
 *    Routes straight to manual entry with a plain explanation.
 *  - `extraction` — the vision model returned something, but no source doc
 *    anywhere defines that response's shape (checked before writing this),
 *    so there is no honest way to auto-fill line items from it yet. Rather
 *    than invent a schema and silently misparse real receipts, this states
 *    the gap plainly and still offers manual entry — "no dead ends" (§15.2)
 *    without fabricating functionality that was never specified.
 *  - `error` — the call itself failed (network, auth). Retryable.
 */
export function PhotoCapture({ userId }: { userId: string }) {
  const [, navigate] = useRouterLocation();
  const [files, setFiles] = useState<File[]>([]);
  const [status, setStatus] = useState<"idle" | "processing">("idle");
  const [result, setResult] = useState<OcrResult | null>(null);

  function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(e.target.files ?? []).slice(0, MAX_IMAGES_PER_OCR_CALL);
    setFiles(chosen);
    setResult(null);
  }

  async function handleSubmit() {
    setStatus("processing");
    setResult(null);
    const outcome = await captureReceipts(files);
    setResult(outcome);
    setStatus("idle");
  }

  if (status === "processing") {
    return <main aria-busy="true">Reading your photo{files.length > 1 ? "s" : ""}…</main>;
  }

  if (result?.kind === "degrade") {
    return (
      <main>
        <h1>Let&rsquo;s do this one by hand</h1>
        <p>
          {result.reason === "budget_exhausted" || result.reason === "session_rate_limited" || result.reason === "ip_rate_limited"
            ? "Photo scanning is busy right now — typing it in only takes a bit longer."
            : "Couldn't read that photo clearly enough — typing it in will be quicker than retaking it."}
        </p>
        <button type="button" onClick={() => navigate("/capture/manual")}>
          Type it in
        </button>
      </main>
    );
  }

  if (result?.kind === "extraction") {
    return (
      <main>
        <h1>Got your photo</h1>
        <p>
          We read something back, but MarketPulse doesn&rsquo;t yet know how to turn it into a
          list of items automatically — that part&rsquo;s still being built. Nothing&rsquo;s lost
          though; just add the items yourself and it&rsquo;ll take about the same time.
        </p>
        <button type="button" onClick={() => navigate("/capture/manual")}>
          Add items
        </button>
      </main>
    );
  }

  return (
    <main>
      <h1>Snap your receipt or list</h1>
      <p>Up to {MAX_IMAGES_PER_OCR_CALL} photos.</p>

      <label htmlFor="receipt-photos">Photos</label>
      <input
        id="receipt-photos"
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        onChange={handleFiles}
      />

      {files.length > 0 && <p>{files.length} photo{files.length === 1 ? "" : "s"} chosen.</p>}

      {result?.kind === "error" && <p role="alert">{result.message}</p>}

      <button type="button" onClick={() => void handleSubmit()} disabled={files.length === 0}>
        Scan
      </button>

      <p>
        <button type="button" onClick={() => navigate("/capture/manual")}>
          Type it in instead
        </button>
      </p>
    </main>
  );
}
