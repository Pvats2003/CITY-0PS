/** Captures the RAW result of the users/{uid} Firestore read — before any
 * trimming/normalization — so a diagnostic UI can show exactly what came
 * back, not what the app later derived from it. Module-level state (not
 * React state) because it's written from firebaseAuth.ts's loadAppUser(),
 * outside any component, the moment the read happens; a pub/sub lets any
 * component (the FO diagnostic panel) pick it up reactively. */
export interface ProfileDiagSnapshot {
  /** The Firebase Auth UID this read was performed for — sourced directly
   * from the live onAuthStateChanged callback / auth.currentUser, never
   * cached or hardcoded (see firebaseAuth.ts). */
  authUid: string;
  /** The exact Firestore path read: `users/${authUid}`. */
  path: string;
  exists: boolean;
  /** The Firestore document's own id — doc(db, "users", authUid) forces
   * this to equal authUid by construction; still captured and compared
   * explicitly (never assumed) so the UI can prove the equality rather
   * than state it. Null when the document doesn't exist. */
  docId: string | null;
  keys: string[];
  /** Raw, unprocessed field values exactly as Firestore returned them —
   * before firebaseAuth.ts's whitespace-trim normalization. */
  rawRole: unknown;
  rawFoId: unknown;
  capturedAt: number;
}

const CHANGE_EVENT = "city-ops-profile-diag-change";
let lastSnapshot: ProfileDiagSnapshot | null = null;

export function setProfileDiagSnapshot(snapshot: ProfileDiagSnapshot): void {
  lastSnapshot = snapshot;
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function getProfileDiagSnapshot(): ProfileDiagSnapshot | null {
  return lastSnapshot;
}

export function onProfileDiagChange(cb: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, cb);
  return () => window.removeEventListener(CHANGE_EVENT, cb);
}

declare global {
  interface Window {
    /** Test-only seam (mirrors __CITY_OPS_TEST_BACKEND__/
     * __CITY_OPS_TEST_AUTH_PROVIDER__/__CITY_OPS_TEST_FORCE_SYNC_ERROR__) —
     * lets Playwright populate the same raw-snapshot state loadAppUser()
     * would, without a live Firestore project. Needed because the mocked
     * test auth provider bypasses loadAppUser() entirely (it injects an
     * AuthEvent directly), so this is the only way to exercise the
     * diagnostic panel's raw-snapshot fields (including deliberately
     * mismatched/whitespace-bearing values for regression tests) end to
     * end. Assigned unconditionally below; inert for real users. */
    __CITY_OPS_TEST_SET_PROFILE_DIAG__?: (snapshot: ProfileDiagSnapshot) => void;
  }
}

if (typeof window !== "undefined") {
  window.__CITY_OPS_TEST_SET_PROFILE_DIAG__ = setProfileDiagSnapshot;
}
