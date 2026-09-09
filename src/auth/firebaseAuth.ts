import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from "firebase/auth";
import { getFirestore, doc, getDoc } from "firebase/firestore";
import { getFirebaseApp } from "./firebaseApp";
import type { AppUser, AuthEvent, AuthProvider, UserRole } from "./types";

interface UserDoc {
  role: UserRole;
  foId?: string;
  displayName?: string;
  createdAt?: string;
}

/** Diagnostics only — never logs email, password, or tokens. Gated on DEV so
 * production consoles stay quiet; safe to leave in since it never touches
 * credentials. */
function authLog(...args: unknown[]) {
  if (import.meta.env.DEV) console.debug("[auth]", ...args);
}

/** Common Firebase Auth error codes mapped to messages a field worker or
 * manager can actually act on, instead of the raw "Firebase: Error
 * (auth/wrong-password)." string. Falls back to the SDK's own message for
 * anything not covered here — never fabricates a reason. */
function describeAuthError(err: unknown): string {
  const code = (err as { code?: string } | undefined)?.code;
  switch (code) {
    case "auth/invalid-email":
      return "That doesn't look like a valid email address.";
    case "auth/user-disabled":
      return "This account has been disabled. Contact your administrator.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
    case "auth/invalid-login-credentials":
      return "Incorrect email or password.";
    case "auth/too-many-requests":
      return "Too many failed attempts. Wait a few minutes and try again.";
    case "auth/network-request-failed":
      return "Network error — check your connection and try again.";
    default:
      return err instanceof Error ? err.message : "Sign in failed.";
  }
}

/** Role/foId live in a `users/{uid}` Firestore doc, not in Firebase Auth
 * itself (custom claims need a privileged admin SDK we don't run here).
 * Provision that doc when you create the account — see DEPLOYMENT.md.
 *
 * Returns `null` only when the doc genuinely doesn't exist (the normal,
 * expected "not provisioned yet" case) — a real read failure (permission
 * denied, offline, rules not deployed) is left to throw so the caller can
 * tell the two apart instead of collapsing both into "signed out". The
 * `role`/`foId` fields are returned exactly as stored (not validated here)
 * — Console-provisioned data can be typo'd or wrong-cased, so the pages
 * that route on role (Login.tsx, FOLogin.tsx) are the ones that check it
 * against the known values and explain a mismatch, rather than this
 * function silently coercing or rejecting it. */
async function loadAppUser(fbUser: User): Promise<AppUser | null> {
  const db = getFirestore(getFirebaseApp());
  const snap = await getDoc(doc(db, "users", fbUser.uid));
  authLog("users/", fbUser.uid, "exists =", snap.exists());
  if (!snap.exists()) return null;
  const data = snap.data() as UserDoc;
  authLog("users/", fbUser.uid, "role =", data.role, "| foId", data.foId ? "present" : "missing");
  return {
    id: fbUser.uid,
    email: fbUser.email ?? "",
    role: data.role,
    foId: data.foId,
    displayName: data.displayName ?? fbUser.displayName ?? undefined,
    createdAt: data.createdAt ?? new Date().toISOString(),
  };
}

export const firebaseAuthProvider: AuthProvider = {
  onChange(cb) {
    const auth = getAuth(getFirebaseApp());
    return onAuthStateChanged(auth, (fbUser) => {
      if (!fbUser) {
        cb({ kind: "signed_out" });
        return;
      }
      loadAppUser(fbUser)
        .then((user) => {
          const event: AuthEvent = user
            ? { kind: "signed_in", user }
            : { kind: "needs_setup", email: fbUser.email ?? "", uid: fbUser.uid };
          authLog("onAuthStateChanged ->", event.kind);
          cb(event);
        })
        .catch((err) => {
          authLog("profile load failed:", (err as { code?: string } | undefined)?.code ?? err);
          cb({ kind: "error", message: err instanceof Error ? err.message : "Could not load your City Ops profile." });
        });
    });
  },
  async loginWithEmail(email, password) {
    try {
      const auth = getAuth(getFirebaseApp());
      await signInWithEmailAndPassword(auth, email, password);
      authLog("signInWithEmailAndPassword ok");
      return { ok: true };
    } catch (err) {
      authLog("signInWithEmailAndPassword failed:", (err as { code?: string } | undefined)?.code ?? err);
      return { ok: false, error: describeAuthError(err) };
    }
  },
  async logout() {
    const auth = getAuth(getFirebaseApp());
    await signOut(auth);
  },
};
