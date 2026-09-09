import { useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useApplyTheme } from "@/lib/theme";
import { AuthProviderRoot } from "@/auth/AuthContext";
import { RequireRole } from "@/auth/RequireRole";
import { startSyncEngine } from "@/data/syncEngine";
import Login from "@/pages/Login";
import FOExecution from "@/pages/FOExecution";
import ManagerApp from "@/ManagerApp";

function App() {
  useApplyTheme();
  useEffect(() => {
    void startSyncEngine();
  }, []);

  return (
    <TooltipProvider delayDuration={200}>
      <AuthProviderRoot>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
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
        </BrowserRouter>
      </AuthProviderRoot>
    </TooltipProvider>
  );
}

export default App;
