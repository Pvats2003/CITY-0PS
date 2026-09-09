import { BrowserRouter, Routes, Route } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useApplyTheme } from "@/lib/theme";
import { AuthProviderRoot } from "@/auth/AuthContext";
import { RequireRole } from "@/auth/RequireRole";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import Login from "@/pages/Login";
import FOLogin from "@/pages/FOLogin";
import FOExecution from "@/pages/FOExecution";
import ManagerApp from "@/ManagerApp";

function App() {
  useApplyTheme();

  return (
    <TooltipProvider delayDuration={200}>
      <AuthProviderRoot>
        <BrowserRouter>
          <ErrorBoundary>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/fo/login" element={<FOLogin />} />
              <Route
                path="/fo/*"
                element={
                  <RequireRole role="FIELD_OFFICER">
                    <FOExecution />
                  </RequireRole>
                }
              />
              <Route
                path="/*"
                element={
                  <RequireRole role="MANAGER">
                    <ManagerApp />
                  </RequireRole>
                }
              />
            </Routes>
          </ErrorBoundary>
        </BrowserRouter>
      </AuthProviderRoot>
    </TooltipProvider>
  );
}

export default App;
