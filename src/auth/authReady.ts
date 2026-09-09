import { isFirebaseConfigured } from "./config";

/** Resolves once a real identity is available — a signed-in Firebase user in
 * production, or the injected test provider's own "signed_in" event in
 * Playwright (see __CITY_OPS_TEST_AUTH_PROVIDER__ in AuthContext.tsx).
 * Resolves immediately in demo mode (nothing to wait for) and immediately
 * if already signed in.
 *
 * Used by the sync engine (src/data/syncEngine.ts) to avoid attaching
 * Firestore listeners before request.auth is populated. Every shared
 * collection's rules require isSignedIn() (see firestore.rules) — a
 * listener attached while signed out gets denied immediately, and unlike a
 * token refresh on an already-live listener, a listener the SDK has denied
 * once is torn down and never retried. On a first-ever sign-in (no cached
 * session yet) that denial can land before the sign-in form is even
 * submitted, permanently starving every collection the app depends on —
 * this is what made FOExecution's "FO record not found" reproducible even
 * with a correct foId and a correct fos/{doc}: the fos listener had already
 * died before the account existed to the client. */
export async function waitForAuthReady(): Promise<void> {
  const testProvider = window.__CITY_OPS_TEST_AUTH_PROVIDER__;
  if (testProvider) {
    await new Promise<void>((resolve) => {
      const unsub = testProvider.onChange((event) => {
        if (event.kind === "signed_in") {
          unsub();
          resolve();
        }
      });
    });
    return;
  }
  if (!isFirebaseConfigured()) return;
  const [{ getAuth, onAuthStateChanged }, { getFirebaseApp }] = await Promise.all([import("firebase/auth"), import("./firebaseApp")]);
  const auth = getAuth(getFirebaseApp());
  if (auth.currentUser) return;
  await new Promise<void>((resolve) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) {
        unsub();
        resolve();
      }
    });
  });
}
