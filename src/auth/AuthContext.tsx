import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isFirebaseConfigured } from "./config";
import { demoAuthProvider, loginDemo as demoLoginDemo } from "./demoAuth";
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
          setUser(null);
          setPendingSetup(null);
          setAuthError(null);
          setStatus("anon");
          break;
        case "signed_in":
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
