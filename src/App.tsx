import { useEffect, useState } from "react";
import { Route, Switch } from "wouter";
import { ensureSession, requestPersistentStorage } from "./lib/supabase.js";
import { hasReferenceData, refreshReferenceData } from "./lib/reference-data.js";
import { startSyncLoop } from "./lib/sync.js";
import { CaptureChoice } from "./features/capture/CaptureChoice.js";
import { ManualEntry } from "./features/capture/ManualEntry.js";
import { PhotoCapture } from "./features/capture/PhotoCapture.js";
import { ConfirmTrip } from "./features/capture/ConfirmTrip.js";
import { AccountUpgrade } from "./features/account/AccountUpgrade.js";
import { TripSummary } from "./features/trips/TripSummary.js";
import { Home } from "./features/home/Home.js";
import { CommodityDetail } from "./features/commodity/CommodityDetail.js";
import { BudgetSetup } from "./features/budget/BudgetSetup.js";
import { BudgetAnalysis } from "./features/budget/BudgetAnalysis.js";
import { MarketsList } from "./features/markets/MarketsList.js";
import { MarketDetail } from "./features/markets/MarketDetail.js";
import { PriceComparison } from "./features/compare/PriceComparison.js";
import { BasketComparison } from "./features/compare/BasketComparison.js";
import { MyWatchlist } from "./features/watchlist/MyWatchlist.js";
import { WeeklyReport } from "./features/reports/WeeklyReport.js";

type BootState =
  | { status: "loading" }
  | { status: "ready"; userId: string; persistent: boolean }
  | { status: "error"; message: string };

/**
 * Boot shell. The silent anonymous session is established before any capture
 * surface renders (§9.2), reference data is cached for offline use, and the
 * sync loop starts so committed trips drain to Supabase from trip 1.
 */
export function App() {
  const [state, setState] = useState<BootState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const session = await ensureSession();
        const persistent = await requestPersistentStorage();

        if (!(await hasReferenceData())) {
          await refreshReferenceData();
        } else {
          // Don't block boot on a refresh; stale cached reference data is
          // fine for a session, network is not guaranteed at launch.
          void refreshReferenceData();
        }

        const stopSync = startSyncLoop();
        window.addEventListener("beforeunload", stopSync, { once: true });

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
    <Switch>
      <Route path="/capture/manual">
        <ManualEntry userId={state.userId} />
      </Route>
      <Route path="/capture/photo">
        <PhotoCapture userId={state.userId} />
      </Route>
      <Route path="/capture/confirm">
        <ConfirmTrip userId={state.userId} />
      </Route>
      <Route path="/capture">
        <CaptureChoice />
      </Route>
      <Route path="/account/upgrade">
        <AccountUpgrade />
      </Route>
      <Route path="/trips/:id/summary">
        {(params) => <TripSummary tripId={params.id} userId={state.userId} />}
      </Route>
      <Route path="/home">
        <Home userId={state.userId} />
      </Route>
      <Route path="/commodity/:id">
        {(params) => <CommodityDetail commodityId={params.id} userId={state.userId} />}
      </Route>
      <Route path="/budget/setup">
        <BudgetSetup userId={state.userId} />
      </Route>
      <Route path="/budget">
        <BudgetAnalysis userId={state.userId} />
      </Route>
      <Route path="/map/market/:id">
        {(params) => <MarketDetail marketId={params.id} />}
      </Route>
      <Route path="/map">
        <MarketsList />
      </Route>
      <Route path="/compare/location/:commodityId">
        {(params) => <PriceComparison commodityId={params.commodityId} />}
      </Route>
      <Route path="/compare/basket">
        <BasketComparison userId={state.userId} />
      </Route>
      <Route path="/watchlist">
        <MyWatchlist userId={state.userId} />
      </Route>
      <Route path="/reports/weekly">
        <WeeklyReport userId={state.userId} />
      </Route>
      <Route path="/">
        <Home userId={state.userId} />
      </Route>
    </Switch>
  );
}
