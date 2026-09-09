import { Suspense, lazy } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useCity } from "@/store/city";
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

  if (!onboarded) {
    return <Onboarding />;
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
