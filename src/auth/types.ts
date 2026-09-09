export type UserRole = "MANAGER" | "FIELD_OFFICER";

export interface AppUser {
  id: string;
  email: string;
  role: UserRole;
  displayName?: string;
  /** Set only for FIELD_OFFICER — links this login to a FieldOfficer record. */
  foId?: string;
  createdAt: string;
}

/** "needs_setup": the identity provider (Firebase Auth) authenticated this
 * person, but City Ops OS has no application profile for them yet (no
 * users/{uid} doc — see firebaseAuth.ts). "error": the profile lookup
 * itself failed (e.g. Firestore unreachable) — distinct from both "anon"
 * and "needs_setup" so a real failure is never silently treated as "not
 * logged in" (see Login.tsx). */
export type AuthStatus = "loading" | "authed" | "anon" | "needs_setup" | "error";

export interface AuthResult {
  ok: boolean;
  error?: string;
}

/** What onChange() reports on every auth transition. A discriminated union
 * rather than a bare `AppUser | null` so "authenticated but unprovisioned"
 * and "profile lookup failed" are never conflated with "signed out". */
export type AuthEvent =
  | { kind: "signed_out" }
  | { kind: "signed_in"; user: AppUser }
  | { kind: "needs_setup"; email: string; uid: string }
  | { kind: "error"; message: string };

/** Backend-agnostic auth contract. demoAuth.ts and firebaseAuth.ts both
 * implement this so AuthContext never needs to know which is active. */
export interface AuthProvider {
  /** Called once on startup with the current auth state, and again
   * whenever it changes. Returns an unsubscribe function. */
  onChange(cb: (event: AuthEvent) => void): () => void;
  loginWithEmail(email: string, password: string): Promise<AuthResult>;
  logout(): Promise<void>;
}
