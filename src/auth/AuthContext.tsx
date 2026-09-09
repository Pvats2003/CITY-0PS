import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isFirebaseConfigured } from "./config";
import { demoAuthProvider, loginDemo as demoLoginDemo } from "./demoAuth";
import { resetSyncEngine, startSyncEngine } from "@/data/syncEngine";
import type { AppUser, AuthProvider, AuthResult, AuthStatus, UserRole } from "./types";

declare global {
  interface Window {
    /** Test-only seam (mirrors __CITY_OPS_TEST_BACKEND__ in syncEngine.ts).
     * When set before AuthProviderRoot mounts, it's used in place of the
     * real demo/Firebase choice — lets Playwright exercise auth states
     * (invalid role, missing profile, error) that require a real or
     * mocked identity provider, since there's no way to exercise a live
     * Firebase project in this environment. Inert for real users. */
    __CITY_OPS_TEST_AUTH_PROVIDER__?: AuthProvider;
  }
}

interface PendingSetup {
  email: string;
  uid: string;
}

interface AuthContextValue {
  user: AppUser | null;
  status: AuthStatus;
  /** Set only when status === "needs_setup": the authenticated identity
   * that has no City Ops profile yet, so the UI can say who's signed in. */
  pendingSetup: PendingSetup | null;
  /** Set only when status === "error": why the profile lookup failed. */
  authError: string | null;
  /** True when running against local/demo data with zero external network
   * calls — i.e. no VITE_FIREBASE_* env vars are set. */
  isDemoMode: boolean;
  loginWithEmail: (email: string, password: string) => Promise<AuthResult>;
  /** Only meaningful (and only shown in the UI) in demo mode. */
  loginDemo: (role: UserRole) => AuthResult;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProviderRoot({ children }: { children: ReactNode }) {
  const isDemoMode = !isFirebaseConfigured();
  const [user, setUser] = useState<AppUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [pendingSetup, setPendingSetup] = useState<PendingSetup | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  // firebaseAuthProvider pulls in the Firebase SDK — only import it when a
  // real backend is actually configured, so demo mode stays network-free.
  const provider = useMemo(() => {
    if (window.__CITY_OPS_TEST_AUTH_PROVIDER__) return window.__CITY_OPS_TEST_AUTH_PROVIDER__;
    if (isDemoMode) return demoAuthProvider;
    return null; // resolved async below
  }, [isDemoMode]);

  const [remoteProvider, setRemoteProvider] = useState<typeof demoAuthProvider | null>(null);

  useEffect(() => {
    if (isDemoMode) return;
    let cancelled = false;
    import("./firebaseAuth").then(({ firebaseAuthProvider }) => {
      if (!cancelled) setRemoteProvider(firebaseAuthProvider);
    });
    return () => {
      cancelled = true;
    };
  }, [isDemoMode]);

  const activeProvider = provider ?? remoteProvider;

  useEffect(() => {
    if (!activeProvider) return;
    const unsub = activeProvider.onChange((event) => {
      switch (event.kind) {
        case "signed_out":
          // Tears down every listener/watcher the PREVIOUS signed-in
          // account's sync engine run attached and clears every collection's
          // sync error — without this, `started` inside syncEngine.ts
          // latches it to whichever account was signed in when it first
          // ran, for the rest of the tab's lifetime: a different account
          // signing in afterward (no full page reload happens on sign-out)
          // would get no new role-scoped subscriptions at all, and could
          // still see the PREVIOUS account's stale sync error. Harmless to
          // call even if the engine never started (demo mode, or this is
          // the very first "anon" state on a fresh unauthenticated visit).
          resetSyncEngine();
          setUser(null);
          setPendingSetup(null);
          setAuthError(null);
          setStatus("anon");
          break;
        case "signed_in":
          // (Re)starts the sync engine for THIS account — a no-op if it's
          // already running for this exact run (startSyncEngine's own
          // `started` guard), and the only place that restarts it after a
          // resetSyncEngine() following a sign-out earlier in this tab.
          void startSyncEngine();
          // TEMPORARY production diagnostic — PRIMITIVE values only,
          // logged at the exact moment this context is about to store this
          // object as `user`, at the moment it receives it from the active
          // AuthProvider (firebaseAuthProvider in production). If foId is
          // correct here but a consumer (e.g. FOExecution) later reports it
          // missing, the bug is downstream of this line, not upstream of
          // it. Safe to delete once resolved.
          console.log(
            "[CITY-OPS-DIAG] AuthContext user",
            "uid=", event.user.id,
            "role=", JSON.stringify(event.user.role),
            "foId=", JSON.stringify(event.user.foId),
            "foIdType=", typeof event.user.foId,
            "foIdLength=", typeof event.user.foId === "string" ? event.user.foId.length : -1,
            "hasFoId=", Boolean(event.user.foId),
          );
          setUser(event.user);
          setPendingSetup(null);
          setAuthError(null);
          setStatus("authed");
          break;
        case "needs_setup":
          setUser(null);
          setPendingSetup({ email: event.email, uid: event.uid });
          setAuthError(null);
          setStatus("needs_setup");
          break;
        case "error":
          setUser(null);
          setPendingSetup(null);
          setAuthError(event.message);
          setStatus("error");
          break;
      }
    });
    return unsub;
  }, [activeProvider]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status: activeProvider ? status : "loading",
      pendingSetup,
      authError,
      isDemoMode,
      loginWithEmail: (email, password) => (activeProvider ?? demoAuthProvider).loginWithEmail(email, password),
      loginDemo: (role) => demoLoginDemo(role),
      logout: () => (activeProvider ?? demoAuthProvider).logout(),
    }),
    [user, status, pendingSetup, authError, isDemoMode, activeProvider],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProviderRoot");
  return ctx;
}
