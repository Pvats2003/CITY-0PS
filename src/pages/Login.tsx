import { useState } from "react";
import { Navigate } from "react-router-dom";
import { LogIn, Users, ShieldCheck, UserCog, AlertTriangle, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/auth/AuthContext";

export default function Login() {
  const { user, status, pendingSetup, authError, isDemoMode, loginWithEmail, loginDemo, logout } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === "authed" && user) {
    return <Navigate to={user.role === "MANAGER" ? "/" : "/fo"} replace />;
  }

  // Firebase Auth succeeded, but there's no users/{uid} profile document
  // yet — never silently sit on the sign-in form with no explanation.
  if (status === "needs_setup" && pendingSetup) {
    return (
      <div className="min-h-dvh w-full flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-sm">
          <div className="flex items-center gap-2 justify-center mb-6">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold">C</div>
            <div className="text-xl font-semibold tracking-tight">City Ops OS</div>
          </div>
          <div className="rounded-xl border border-warning/30 bg-surface p-6 space-y-4 text-center">
            <UserCog className="size-8 text-warning mx-auto" />
            <div>
              <h1 className="text-lg font-semibold">Account setup required</h1>
              <p className="text-sm text-muted mt-1">
                You're signed in as <span className="font-medium text-foreground">{pendingSetup.email}</span>, but this account
                hasn't been provisioned for City Ops OS yet.
              </p>
            </div>
            <div className="rounded-md border border-border bg-surface-2 px-3 py-2.5 text-left text-xs text-muted">
              Ask your administrator to create a <code className="text-foreground">users/{pendingSetup.uid}</code> document in
              Firestore with a <code className="text-foreground">role</code> field (<code className="text-foreground">MANAGER</code>{" "}
              or <code className="text-foreground">FIELD_OFFICER</code>) — see DEPLOYMENT.md.
            </div>
            <Button variant="secondary" className="w-full" onClick={() => logout()}>
              <LogOut className="size-4" /> Sign out
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="min-h-dvh w-full flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-sm">
          <div className="flex items-center gap-2 justify-center mb-6">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold">C</div>
            <div className="text-xl font-semibold tracking-tight">City Ops OS</div>
          </div>
          <div className="rounded-xl border border-critical/30 bg-surface p-6 space-y-4 text-center">
            <AlertTriangle className="size-8 text-critical mx-auto" />
            <div>
              <h1 className="text-lg font-semibold">Couldn't load your account</h1>
              <p className="text-sm text-muted mt-1">{authError ?? "Something went wrong reaching the backend."}</p>
            </div>
            <Button variant="secondary" className="w-full" onClick={() => logout()}>
              <LogOut className="size-4" /> Sign out and try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  async function submitLogin() {
    setError(null);
    if (!email.trim() || !password) {
      setError("Enter both email and password.");
      return;
    }
    setSubmitting(true);
    const result = await loginWithEmail(email.trim(), password);
    setSubmitting(false);
    if (!result.ok) setError(result.error ?? "Login failed.");
  }

  function handleDemo(role: "MANAGER" | "FIELD_OFFICER") {
    setError(null);
    const result = loginDemo(role);
    if (!result.ok) setError(result.error ?? "Could not start demo session.");
  }

  return (
    <div className="min-h-dvh w-full flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 justify-center mb-6">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold">C</div>
          <div className="text-xl font-semibold tracking-tight">City Ops OS</div>
        </div>

        <div className="rounded-xl border border-border bg-surface p-6 space-y-4">
          <div className="text-center">
            <h1 className="text-lg font-semibold">Sign in</h1>
            <p className="text-sm text-muted mt-1">
              {isDemoMode ? "Running in local demo mode — no account needed to explore." : "Sign in with your City Ops OS account."}
            </p>
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="login-email">Email</Label>
              <Input id="login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@yourcity.gov" autoComplete="username" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="login-password">Password</Label>
              <Input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                onKeyDown={(e) => e.key === "Enter" && submitLogin()}
              />
            </div>
            <Button className="w-full" onClick={submitLogin} disabled={submitting}>
              <LogIn className="size-4" /> Sign in
            </Button>
          </div>

          {error && <div className="text-sm text-critical bg-critical-bg border border-critical/20 rounded-md px-3 py-2">{error}</div>}

          {isDemoMode && (
            <>
              <div className="flex items-center gap-2 pt-1">
                <div className="h-px flex-1 bg-border" />
                <span className="text-[11px] text-muted-2 uppercase tracking-wide">Demo identities</span>
                <div className="h-px flex-1 bg-border" />
              </div>
              <div className="grid gap-2">
                <button
                  onClick={() => handleDemo("MANAGER")}
                  className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3.5 text-left hover:border-primary/50 transition-colors"
                >
                  <ShieldCheck className="size-5 text-primary shrink-0" />
                  <div>
                    <div className="text-sm font-medium">Continue as Manager</div>
                    <div className="text-xs text-muted">Full dashboard access — demo session, no password.</div>
                  </div>
                </button>
                <button
                  onClick={() => handleDemo("FIELD_OFFICER")}
                  className="flex items-center gap-3 rounded-lg border border-border p-3.5 text-left hover:border-border-strong transition-colors"
                >
                  <Users className="size-5 text-muted shrink-0" />
                  <div>
                    <div className="text-sm font-medium">Continue as Field Officer</div>
                    <div className="text-xs text-muted">Binds to the first active FO in your loaded city.</div>
                  </div>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
