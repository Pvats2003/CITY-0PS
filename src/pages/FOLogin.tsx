import { useState } from "react";
import { Navigate, Link } from "react-router-dom";
import { LogIn, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/auth/AuthContext";
import { AuthScreenShell, NeedsSetupPanel, AuthErrorPanel, WrongPortalPanel } from "@/auth/AuthStatusPanels";

/** Dedicated Field Officer entry point — a real, shareable URL an FO can
 * open directly (/fo/login) instead of first finding their way through the
 * Manager sign-in. Same Firebase Authentication as /login; the only
 * difference is what this page does with the result. */
export default function FOLogin() {
  const { user, status, pendingSetup, authError, isDemoMode, loginWithEmail, loginDemo, logout } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === "authed" && user?.role === "FIELD_OFFICER") {
    return <Navigate to="/fo" replace />;
  }

  // Any authenticated account whose role isn't FIELD_OFFICER is a mistake,
  // not a silent redirect — this portal is Field-Officer-only. Covers both
  // the expected case (a Manager account) and an unexpected one (a
  // users/{uid} doc whose role field is missing, blank, or doesn't match
  // either known value — e.g. mistyped in the Firebase console) — either
  // way, say so clearly instead of leaving the sign-in form to silently do
  // nothing when status flips to "authed" but no branch below matches.
  if (status === "authed" && user && user.role !== "FIELD_OFFICER") {
    const isManager = user.role === "MANAGER";
    return (
      <WrongPortalPanel
        message={
          isManager
            ? "This account is a Manager account. Please use Manager sign in."
            : "This account is not configured as a Field Officer. Contact your administrator to check its role in Firestore."
        }
        otherPortalLabel="Go to Manager sign in"
        otherPortalHref="/login"
        onSignOut={() => logout()}
      />
    );
  }

  if (status === "needs_setup" && pendingSetup) {
    return <NeedsSetupPanel email={pendingSetup.email} uid={pendingSetup.uid} onSignOut={() => logout()} />;
  }

  if (status === "error") {
    return <AuthErrorPanel message={authError} onSignOut={() => logout()} />;
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
    if (!result.ok) setError(result.error ?? "Sign in failed.");
  }

  function handleDemo() {
    setError(null);
    const result = loginDemo("FIELD_OFFICER");
    if (!result.ok) setError(result.error ?? "Could not start demo session.");
  }

  return (
    <AuthScreenShell>
      <div className="rounded-xl border border-border bg-surface p-6 space-y-5">
        <div className="text-center space-y-1">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 text-primary px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide">
            <Radio className="size-3" /> Field Operations
          </div>
          <h1 className="text-lg font-semibold pt-1">Sign in to your Field Officer workspace</h1>
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="fo-login-email" className="text-sm">
              Email
            </Label>
            <Input
              id="fo-login-email"
              type="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@yourcity.gov"
              autoComplete="username"
              className="h-12 text-base"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fo-login-password" className="text-sm">
              Password
            </Label>
            <Input
              id="fo-login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              onKeyDown={(e) => e.key === "Enter" && submitLogin()}
              className="h-12 text-base"
            />
          </div>
          <Button className="w-full h-12 text-base" onClick={submitLogin} disabled={submitting}>
            <LogIn className="size-5" /> {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </div>

        {error && <div className="text-sm text-critical bg-critical-bg border border-critical/20 rounded-md px-3 py-2.5">{error}</div>}

        {isDemoMode && (
          <>
            <div className="flex items-center gap-2 pt-1">
              <div className="h-px flex-1 bg-border" />
              <span className="text-[11px] text-muted-2 uppercase tracking-wide">Demo</span>
              <div className="h-px flex-1 bg-border" />
            </div>
            <button
              onClick={handleDemo}
              className="w-full flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4 text-left hover:border-primary/50 transition-colors"
            >
              <Radio className="size-5 text-primary shrink-0" />
              <div>
                <div className="text-sm font-medium">Continue as Field Officer</div>
                <div className="text-xs text-muted">Binds to the first active FO in your loaded city — no password.</div>
              </div>
            </button>
          </>
        )}

        <div className="text-center pt-1">
          <Link to="/login" className="text-xs text-muted hover:text-foreground hover:underline">
            Manager? Sign in here
          </Link>
        </div>
      </div>
    </AuthScreenShell>
  );
}
