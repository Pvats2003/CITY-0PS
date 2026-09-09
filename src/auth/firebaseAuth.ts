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

/** Role/foId live in a `users/{uid}` Firestore doc, not in Firebase Auth
 * itself (custom claims need a privileged admin SDK we don't run here).
 * Provision that doc when you create the account — see DEPLOYMENT.md.
 *
 * Returns `null` only when the doc genuinely doesn't exist (the normal,
 * expected "not provisioned yet" case) — a real read failure (permission
 * denied, offline, rules not deployed) is left to throw so the caller can
 * tell the two apart instead of collapsing both into "signed out". */
async function loadAppUser(fbUser: User): Promise<AppUser | null> {
  const db = getFirestore(getFirebaseApp());
  const snap = await getDoc(doc(db, "users", fbUser.uid));
  if (!snap.exists()) return null;
  const data = snap.data() as UserDoc;
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
          cb(event);
        })
        .catch((err) => {
          cb({ kind: "error", message: err instanceof Error ? err.message : "Could not load your City Ops profile." });
        });
    });
  },
  async loginWithEmail(email, password) {
    try {
      const auth = getAuth(getFirebaseApp());
      await signInWithEmailAndPassword(auth, email, password);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Login failed." };
    }
  },
  async logout() {
    const auth = getAuth(getFirebaseApp());
    await signOut(auth);
  },
};
