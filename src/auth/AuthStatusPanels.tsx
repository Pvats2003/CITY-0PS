import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { UserCog, AlertTriangle, LogOut, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Shared shell for every non-form auth screen (needs setup / error / wrong
 * role) so Login.tsx and FOLogin.tsx render identically for the same
 * underlying state instead of drifting apart. */
function AuthScreenShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh w-full flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 justify-center mb-6">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold">C</div>
          <div className="text-xl font-semibold tracking-tight">City Ops OS</div>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Firebase Auth succeeded, but there's no users/{uid} profile document yet
 * — never silently sit on a sign-in form with no explanation. */
export function NeedsSetupPanel({ email, uid, onSignOut }: { email: string; uid: string; onSignOut: () => void }) {
  return (
    <AuthScreenShell>
      <div className="rounded-xl border border-warning/30 bg-surface p-6 space-y-4 text-center">
        <UserCog className="size-8 text-warning mx-auto" />
        <div>
          <h1 className="text-lg font-semibold">Account setup required</h1>
          <p className="text-sm text-muted mt-1">
            You're signed in as <span className="font-medium text-foreground">{email}</span>, but this account hasn't been
            provisioned for City Ops OS yet.
          </p>
        </div>
        <div className="rounded-md border border-border bg-surface-2 px-3 py-2.5 text-left text-xs text-muted">
          Ask your administrator to create a <code className="text-foreground">users/{uid}</code> document in Firestore with a{" "}
          <code className="text-foreground">role</code> field (<code className="text-foreground">MANAGER</code> or{" "}
          <code className="text-foreground">FIELD_OFFICER</code>) — see DEPLOYMENT.md.
        </div>
        <Button variant="secondary" className="w-full h-11" onClick={onSignOut}>
          <LogOut className="size-4" /> Sign out
        </Button>
      </div>
    </AuthScreenShell>
  );
}

/** The profile lookup itself failed (Firestore unreachable, rules not
 * deployed, etc.) — distinct from "needs setup," and never a blank page. */
export function AuthErrorPanel({ message, onSignOut }: { message: string | null; onSignOut: () => void }) {
  return (
    <AuthScreenShell>
      <div className="rounded-xl border border-critical/30 bg-surface p-6 space-y-4 text-center">
        <AlertTriangle className="size-8 text-critical mx-auto" />
        <div>
          <h1 className="text-lg font-semibold">Couldn't load your account</h1>
          <p className="text-sm text-muted mt-1">{message ?? "Something went wrong reaching the backend."}</p>
        </div>
        <Button variant="secondary" className="w-full h-11" onClick={onSignOut}>
          <LogOut className="size-4" /> Sign out and try again
        </Button>
      </div>
    </AuthScreenShell>
  );
}

/** A Manager account authenticated at the Field Officer entry point (or vice
 * versa is handled by a plain redirect, not a block — see FOLogin.tsx). */
export function WrongPortalPanel({
  message,
  otherPortalLabel,
  otherPortalHref,
  onSignOut,
}: {
  message: string;
  otherPortalLabel: string;
  otherPortalHref: string;
  onSignOut: () => void;
}) {
  return (
    <AuthScreenShell>
      <div className="rounded-xl border border-warning/30 bg-surface p-6 space-y-4 text-center">
        <ShieldAlert className="size-8 text-warning mx-auto" />
        <p className="text-sm text-muted">{message}</p>
        <div className="grid gap-2">
          <Button className="w-full h-11" asChild>
            <Link to={otherPortalHref}>{otherPortalLabel}</Link>
          </Button>
          <Button variant="secondary" className="w-full h-11" onClick={onSignOut}>
            <LogOut className="size-4" /> Sign out
          </Button>
        </div>
      </div>
    </AuthScreenShell>
  );
}

export { AuthScreenShell };
