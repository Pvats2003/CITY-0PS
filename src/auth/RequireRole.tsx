import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import type { UserRole } from "./types";

export function RequireRole({ role, children }: { role: UserRole; children: ReactNode }) {
  const { user, status } = useAuth();

  if (status === "loading") {
    return <div className="min-h-dvh w-full flex items-center justify-center bg-background text-sm text-muted">Loading…</div>;
  }
  if (status === "anon" || !user) {
    return <Navigate to="/login" replace />;
  }
  if (user.role !== role) {
    return <Navigate to={user.role === "MANAGER" ? "/" : "/fo"} replace />;
  }
  return <>{children}</>;
}
