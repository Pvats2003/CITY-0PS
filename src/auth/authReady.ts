import { isFirebaseConfigured } from "./config";
import type { UserRole } from "./types";

export interface AuthReady {
  /** The signed-in account's role, when it could be resolved. null in demo
   * mode (nothing to check), or if the real Firebase path couldn't read a
   * role (profile missing, read failed) — treated by the caller as
   * "subscribe to everything," the safe fallback that matches this
   * function's prior (role-blind) behavior, rather than silently
   * under-subscribing. */
  role: UserRole | null;
  /** The signed-in Field Officer's own foId, trimmed the same way
   * firebaseAuth.ts's loadAppUser trims it — used to scope
   * OWNERSHIP_SCOPED_FO_COLLECTIONS listens to `where("foId", "==", ...)`,
   * the only query shape their firestore.rules grant actually permits.
   * undefined for a Manager, in demo mode, or if it couldn't be read. */
  foId?: string;
}

/** Resolves once a real identity — and, on the real Firebase path, that
 * identity's role — is available. A signed-in Firebase user in production,
 * or the injected test provider's own "signed_in" event (which already
 * carries a role) in Playwright. Resolves immediately in demo mode.
 *
 * Used by the sync engine (src/data/syncEngine.ts) for two things:
 *
 * 1. Avoid attaching Firestore listeners before request.auth is populated.
 *    Every shared collection's rules require isSignedIn() (see
 *    firestore.rules) — a listener attached while signed out gets denied
 *    immediately, and unlike a token refresh on an already-live listener, a
 *    listener the SDK has denied once is torn down and never retried. On a
 *    first-ever sign-in (no cached session yet) that denial can land before
 *    the sign-in form is even submitted, permanently starving every
 *    collection the app depends on.
 *
 * 2. Scope WHICH collections get subscribed to what this role can actually
 *    read. firestore.rules grants a Field Officer explicit read access to
 *    only 9 of the app's 15 shared collections (fos, businesses, rigs,
 *    assignments, sessions, issues, rigIncidents, activity, evidence) —
 *    the rest (collectors, qualityReviews, correctiveActions,
 *    repairRecords, plans, reports) are Manager-only by design. Without
 *    this, the sync engine subscribes to all 15 for every signed-in user
 *    regardless of role, and for an FO those other 7 get denied — not a
 *    bug in the rules, but the app's own SYNC ERROR state doesn't
 *    distinguish "an expected, by-design denial on a collection this role
 *    was never granted" from a real failure, so it stays permanently
 *    poisoned even once fos itself is syncing correctly. */
export async function waitForAuthReady(): Promise<AuthReady> {
  const testProvider = window.__CITY_OPS_TEST_AUTH_PROVIDER__;
  if (testProvider) {
    return new Promise<AuthReady>((resolve) => {
      const unsub = testProvider.onChange((event) => {
        if (event.kind === "signed_in") {
          unsub();
          resolve({ role: event.user.role, foId: event.user.foId });
        }
      });
    });
  }
  if (!isFirebaseConfigured()) return { role: null };

  const authModule = await import("firebase/auth");
  const { getAuth, onAuthStateChanged } = authModule;
  const { getFirebaseApp } = await import("./firebaseApp");
  const auth = getAuth(getFirebaseApp());
  const fbUser: import("firebase/auth").User =
    auth.currentUser ??
    (await new Promise<import("firebase/auth").User>((resolve) => {
      const unsub = onAuthStateChanged(auth, (user) => {
        if (user) {
          unsub();
          resolve(user);
        }
      });
    }));

  // A second, cheap read of the same users/{uid} doc firebaseAuth.ts's
  // loadAppUser reads — this is what lets step 2 above scope subscriptions
  // by role. A read failure (profile missing, offline) falls back to null
  // rather than blocking sync engine startup; the caller then subscribes to
  // everything, same as before this role-awareness existed.
  try {
    const { getFirestore, doc, getDoc } = await import("firebase/firestore");
    const db = getFirestore(getFirebaseApp());
    const snap = await getDoc(doc(db, "users", fbUser.uid));
    if (!snap.exists()) return { role: null };
    const data = snap.data() as { role?: UserRole; foId?: string };
    const role = (data.role ?? null) as UserRole | null;
    // Same trim loadAppUser applies to the identical field on the identical
    // doc — an untrimmed value here would scope the ownership-filtered
    // query to the wrong string and reproduce the exact whitespace bug
    // already fixed for FO matching, one layer down.
    const foId = typeof data.foId === "string" ? data.foId.trim() || undefined : undefined;
    return { role, foId };
  } catch {
    return { role: null };
  }
}
