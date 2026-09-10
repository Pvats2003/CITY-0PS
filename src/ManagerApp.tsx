import { Suspense, lazy } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useCity } from "@/store/city";
import { useCollectionSyncStatus } from "@/data/useCollectionSyncStatus";
import { AppShell } from "@/components/layout/AppShell";
import Onboarding from "@/pages/Onboarding";
import CommandCenter from "@/pages/CommandCenter";
import Today from "@/pages/Today";
import Businesses from "@/pages/Businesses";
import BusinessDetail from "@/pages/BusinessDetail";
import FieldOfficers from "@/pages/FieldOfficers";
import FieldOfficerDetail from "@/pages/FieldOfficerDetail";
import FOExecution from "@/pages/FOExecution";
import Fleet from "@/pages/Fleet";
import RigDetail from "@/pages/RigDetail";
import Sessions from "@/pages/Sessions";
import SessionDetail from "@/pages/SessionDetail";
import Issues from "@/pages/Issues";
import IssueDetail from "@/pages/IssueDetail";
import Quality from "@/pages/Quality";
import Reports from "@/pages/Reports";
import SearchPage from "@/pages/SearchPage";
import Settings from "@/pages/Settings";

// Recharts is the single largest dependency and only used here, so it's
// worth splitting out of the main bundle.
const Analytics = lazy(() => import("@/pages/Analytics"));

/** The original single-user City Ops OS, unchanged, now mounted under
 * RequireRole("MANAGER") at "/*". Every path below is exactly what it was
 * before multi-user support — no link in the app needed to change. */
export default function ManagerApp() {
  const onboarded = useCity((s) => s.settings.onboarded);
  const hasBusinesses = useCity((s) => s.businesses.length > 0);
  const hasRigs = useCity((s) => s.rigs.length > 0);
  const hasFos = useCity((s) => s.fos.length > 0);
  // `settings` (including `onboarded`) is device-local only — it's
  // deliberately excluded from Firestore sync (see data/backend.ts's
  // CollectionName), since it's a single per-device preference object, not
  // a shared operational collection. That means a returning Manager on a
  // new device or browser (or after this one's local storage was cleared)
  // always starts with onboarded=false, even when their real city already
  // exists in Firestore. Falling through to Onboarding in that case would
  // hide fully-synced, real operational data behind a "Start My City"
  // prompt — exactly the "my data is gone" symptom, even though nothing
  // was ever lost. See below: we treat already-synced data as proof this
  // city was onboarded, wherever that first happened.
  const businessesSync = useCollectionSyncStatus("businesses");

  if (!onboarded) {
    // A real backend's first snapshot hasn't landed yet — wait rather than
    // flash "Start My City" at a Manager whose real data is still in
    // flight. A genuine sync error stops the wait immediately (the app's
    // existing sync-error surfaces — the Sidebar status pill — take over
    // instead of hanging here forever).
    if (businessesSync.status === "loading" && !businessesSync.error) {
      return null;
    }
    if (!hasBusinesses && !hasRigs && !hasFos) {
      return <Onboarding />;
    }
    // Real data already exists remotely (this device just never ran
    // onboarding) — fall through to the real app below instead of hiding
    // it.
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<CommandCenter />} />
        <Route path="/dashboard" element={<CommandCenter />} />
        <Route path="/today" element={<Today />} />
        <Route path="/businesses" element={<Businesses />} />
        <Route path="/businesses/:id" element={<BusinessDetail />} />
        <Route path="/field-officers" element={<FieldOfficers />} />
        <Route path="/field-officers/:id" element={<FieldOfficerDetail />} />
        <Route path="/fleet" element={<Fleet />} />
        <Route path="/fleet/:id" element={<RigDetail />} />
        <Route path="/sessions" element={<Sessions />} />
        <Route path="/sessions/:id" element={<SessionDetail />} />
        <Route path="/issues" element={<Issues />} />
        <Route path="/issues/:id" element={<IssueDetail />} />
        <Route path="/quality" element={<Quality />} />
        <Route path="/reports" element={<Reports />} />
        <Route
          path="/analytics"
          element={
            <Suspense fallback={null}>
              <Analytics />
            </Suspense>
          }
        />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      {/* Manager-only preview of any FO's mobile view — not the FO's real
          login-bound entry point, which is /fo. */}
      <Route path="/field-officers/:id/execute" element={<FOExecution />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
