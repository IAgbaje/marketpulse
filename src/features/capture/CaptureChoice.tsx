import { Link } from "wouter";

/**
 * Screen 3 — Capture choice (§15.3). Two tappable cards, feels like a
 * decision not a form. As of stage 6, photo capture is live — it always
 * gets the user somewhere useful (auto-fill once that's built, manual entry
 * today via the honest degrade path — see PhotoCapture.tsx), so there's no
 * reason to gate it behind a disabled button any more.
 */
export function CaptureChoice() {
  return (
    <main>
      <h1>Log a shop</h1>
      <div role="group" aria-label="How do you want to log this shop?">
        <Link to="/capture/manual">
          <button type="button">⌨️ Type your items</button>
        </Link>
        <Link to="/capture/photo">
          <button type="button">📷 Snap your receipt or list</button>
        </Link>
      </div>
      <p>Takes about a minute for a typical shop.</p>
      <p>
        <Link to="/account/upgrade">Back up your data</Link>
      </p>
    </main>
  );
}
