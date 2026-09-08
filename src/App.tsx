import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useCity } from "@/store/city";
import { useApplyTheme } from "@/lib/theme";
import { AppShell } from "@/components/layout/AppShell";
import Onboarding from "@/pages/Onboarding";
import CommandCenter from "@/pages/CommandCenter";
import Today from "@/pages/Today";
import Businesses from "@/pages/Businesses";
import BusinessDetail from "@/pages/BusinessDetail";
import FieldOfficers from "@/pages/FieldOfficers";
import FieldOfficerDetail from "@/pages/FieldOfficerDetail";
import FOExecution from "@/pages/FOExecution";
import Sessions from "@/pages/Sessions";
import SessionDetail from "@/pages/SessionDetail";
import Issues from "@/pages/Issues";
import IssueDetail from "@/pages/IssueDetail";
import Quality from "@/pages/Quality";
import Reports from "@/pages/Reports";
import Analytics from "@/pages/Analytics";
import SearchPage from "@/pages/SearchPage";
import Settings from "@/pages/Settings";

function App() {
  const onboarded = useCity((s) => s.settings.onboarded);
  useApplyTheme();

  if (!onboarded) {
    return (
      <TooltipProvider delayDuration={200}>
        <Onboarding />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<CommandCenter />} />
            <Route path="/today" element={<Today />} />
            <Route path="/businesses" element={<Businesses />} />
            <Route path="/businesses/:id" element={<BusinessDetail />} />
            <Route path="/field-officers" element={<FieldOfficers />} />
            <Route path="/field-officers/:id" element={<FieldOfficerDetail />} />
            <Route path="/sessions" element={<Sessions />} />
            <Route path="/sessions/:id" element={<SessionDetail />} />
            <Route path="/issues" element={<Issues />} />
            <Route path="/issues/:id" element={<IssueDetail />} />
            <Route path="/quality" element={<Quality />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
          <Route path="/field-officers/:id/execute" element={<FOExecution />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  );
}

export default App;
