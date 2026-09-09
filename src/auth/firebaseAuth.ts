import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from "firebase/auth";
import { getFirestore, doc, getDoc } from "firebase/firestore";
import { getFirebaseApp } from "./firebaseApp";
import type { AppUser, AuthProvider, UserRole } from "./types";

interface UserDoc {
  role: UserRole;
  foId?: string;
  displayName?: string;
  createdAt?: string;
}

/** Role/foId live in a `users/{uid}` Firestore doc, not in Firebase Auth
 * itself (custom claims need a privileged admin SDK we don't run here).
 * Provision that doc when you create the account — see DEPLOYMENT.md. */
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
        cb(null);
        return;
      }
      loadAppUser(fbUser)
        .then(cb)
        .catch(() => cb(null));
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
