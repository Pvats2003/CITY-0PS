import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import type { UserRole } from "./types";

export function RequireRole({ role, children }: { role: UserRole; children: ReactNode }) {
  const { user, status } = useAuth();

  if (status === "loading") {
    return <div className="min-h-dvh w-full flex items-center justify-center bg-background text-sm text-muted">Loading…</div>;
  }
  // "anon" (never signed in), "needs_setup" (authenticated, no City Ops
  // profile yet), and "error" (profile lookup failed) all land back on
  // /login, which renders the right explanation for each — none of them
  // should silently show a blank protected page.
  if (status !== "authed" || !user) {
    return <Navigate to="/login" replace />;
  }
  if (user.role !== role) {
    return <Navigate to={user.role === "MANAGER" ? "/" : "/fo"} replace />;
  }
  return <>{children}</>;
}
