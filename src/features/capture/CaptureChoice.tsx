import { Link } from "wouter";

/**
 * Screen 3 — Capture choice (§15.3). Two tappable cards, feels like a
 * decision not a form. Photo capture is stage 6 (OCR) — shown but disabled,
 * so the route exists without implying it works yet.
 */
export function CaptureChoice() {
  return (
    <main>
      <h1>Log a shop</h1>
      <div role="group" aria-label="How do you want to log this shop?">
        <Link to="/capture/manual">
          <button type="button">⌨️ Type your items</button>
        </Link>
        <button type="button" disabled title="Coming soon">
          📷 Snap your receipt or list
        </button>
      </div>
      <p>Takes about a minute for a typical shop.</p>
    </main>
  );
}
