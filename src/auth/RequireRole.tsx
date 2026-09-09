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
    // A known role that just isn't this one goes to its own portal. An
    // unrecognized role (missing/typo'd in the users/{uid} doc) must NOT
    // fall into the "/ : /fo" guess below — that guess is exactly what
    // sent it here in the first place, so repeating it would bounce this
    // user between the two guarded roots forever. Sending it back to the
    // matching login page instead breaks the loop: Login.tsx and
    // FOLogin.tsx both now recognize an invalid role and explain it
    // clearly rather than redirecting into a guarded route again.
    if (user.role === "MANAGER") return <Navigate to="/" replace />;
    if (user.role === "FIELD_OFFICER") return <Navigate to="/fo" replace />;
    return <Navigate to={loginPath} replace />;
  }
  return <>{children}</>;
}
