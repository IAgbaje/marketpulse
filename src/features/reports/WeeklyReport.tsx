import { useEffect, useState } from "react";
import { db } from "../../lib/db.js";
import { formatNaira } from "../../lib/money.js";
import { computeWeeklyReport, formatShareText, type WeeklyReport as WeeklyReportData } from "../../lib/weeklyReport.js";

/**
 * Weekly report (§4 stage 9, `/reports/weekly`). A personal recap — see
 * weeklyReport.ts for why this isn't a crowd price trend. The "Sharing"
 * half of this stage: Web Share API where available, clipboard fallback
 * everywhere else — no new dependency for either.
 */
export function WeeklyReport({ userId }: { userId: string }) {
  const [report, setReport] = useState<WeeklyReportData | null>(null);
  const [commodityNames, setCommodityNames] = useState<Map<string, string>>(new Map());
  const [shareStatus, setShareStatus] = useState<"idle" | "copied" | "shared">("idle");

  useEffect(() => {
    void (async () => {
      const r = await computeWeeklyReport(userId);
      setReport(r);
      const commodities = await db.commodities.bulkGet(r.topCommodities.map((c) => c.commodityId));
      setCommodityNames(
        new Map(commodities.filter((c) => c !== undefined).map((c) => [c!.id, c!.canonicalName])),
      );
    })();
  }, [userId]);

  async function handleShare() {
    if (!report) return;
    const text = formatShareText(report, formatNaira);
    if (navigator.share) {
      try {
        await navigator.share({ text });
        setShareStatus("shared");
        return;
      } catch {
        // user cancelled the share sheet — not an error, fall through silently
        return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      setShareStatus("copied");
    } catch {
      // clipboard denied — nothing we can do; the text is still on screen
    }
  }

  if (!report) return <main aria-busy="true">Working out your week…</main>;

  const diffKobo = report.thisWeekSpentKobo - report.lastWeekSpentKobo;

  return (
    <main>
      <h1>Your week</h1>

      <p>
        <strong>{formatNaira(report.thisWeekSpentKobo)}</strong> across {report.thisWeekTripCount} shop
        {report.thisWeekTripCount === 1 ? "" : "s"} this week.
      </p>

      {report.lastWeekSpentKobo > 0n && (
        <p>
          {diffKobo === 0n
            ? "Same as last week."
            : `${diffKobo > 0n ? "Up" : "Down"} ${formatNaira(diffKobo < 0n ? -diffKobo : diffKobo)} from last week.`}
        </p>
      )}

      {report.topCommodities.length > 0 && (
        <section aria-label="Where it went">
          <h2>Where it went</h2>
          <ul aria-label="Top items this week">
            {report.topCommodities.map((c) => (
              <li key={c.commodityId}>
                {commodityNames.get(c.commodityId) ?? c.commodityId} — {formatNaira(c.spentKobo)}
              </li>
            ))}
          </ul>
        </section>
      )}

      <p>
        <button type="button" onClick={() => void handleShare()}>
          Share
        </button>
        {shareStatus === "copied" && " Copied to clipboard."}
        {shareStatus === "shared" && " Shared."}
      </p>

      <p>
        Crowd price trends aren&rsquo;t part of this report yet — MarketPulse only tracks crowd
        prices by month right now, not by week.
      </p>
    </main>
  );
}
