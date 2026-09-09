import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isFirebaseConfigured } from "./config";
import { demoAuthProvider, loginDemo as demoLoginDemo } from "./demoAuth";
import type { AppUser, AuthResult, AuthStatus, UserRole } from "./types";

interface AuthContextValue {
  user: AppUser | null;
  status: AuthStatus;
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

  // firebaseAuthProvider pulls in the Firebase SDK — only import it when a
  // real backend is actually configured, so demo mode stays network-free.
  const provider = useMemo(() => {
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
    const unsub = activeProvider.onChange((u) => {
      setUser(u);
      setStatus(u ? "authed" : "anon");
    });
    return unsub;
  }, [activeProvider]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status: activeProvider ? status : "loading",
      isDemoMode,
      loginWithEmail: (email, password) => (activeProvider ?? demoAuthProvider).loginWithEmail(email, password),
      loginDemo: (role) => demoLoginDemo(role),
      logout: () => (activeProvider ?? demoAuthProvider).logout(),
    }),
    [user, status, isDemoMode, activeProvider],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProviderRoot");
  return ctx;
}
