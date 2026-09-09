import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import type { UserRole } from "./types";

export function RequireRole({ role, children }: { role: UserRole; children: ReactNode }) {
  const { user, status } = useAuth();
  // Each portal has its own entry point — an unauthenticated visitor to an
  // FO route lands on the FO-branded login, not the generic one, and vice
  // versa, so a shared FO link never routes someone through the Manager
  // sign-in first.
  const loginPath = role === "FIELD_OFFICER" ? "/fo/login" : "/login";

  if (status === "loading") {
    return <div className="min-h-dvh w-full flex items-center justify-center bg-background text-sm text-muted">Loading…</div>;
  }
  // "anon" (never signed in), "needs_setup" (authenticated, no City Ops
  // profile yet), and "error" (profile lookup failed) all land back on the
  // matching login page, which renders the right explanation for each —
  // none of them should silently show a blank protected page.
  if (status !== "authed" || !user) {
    return <Navigate to={loginPath} replace />;
  }
  if (user.role !== role) {
    return <Navigate to={user.role === "MANAGER" ? "/" : "/fo"} replace />;
  }
  return <>{children}</>;
}
