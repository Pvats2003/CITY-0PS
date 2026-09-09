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

export type AuthStatus = "loading" | "authed" | "anon";

export interface AuthResult {
  ok: boolean;
  error?: string;
}

/** Backend-agnostic auth contract. demoAuth.ts and firebaseAuth.ts both
 * implement this so AuthContext never needs to know which is active. */
export interface AuthProvider {
  /** Called once on startup; invokes the callback immediately with the
   * current user (or null) and again whenever it changes. Returns an
   * unsubscribe function. */
  onChange(cb: (user: AppUser | null) => void): () => void;
  loginWithEmail(email: string, password: string): Promise<AuthResult>;
  logout(): Promise<void>;
}
