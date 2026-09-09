/** Captures the raw `fos` Firestore snapshot's doc-ID/data-ID split, which
 * the RemoteBackend contract (see backend.ts's subscribeCollection<T
 * extends {id:string}>) has no room for and firebaseBackend.ts's own
 * mapping (`snap.docs.map((d) => d.data())`) discards before it ever
 * reaches the store — d.id (the Firestore document's own identity) never
 * survives into `data.fos`, only `data().id` (the app-level field) does.
 * This is a side-channel, read-only capture of what's about to be thrown
 * away, so the on-page diagnostic panel can show the Console-visible doc ID
 * separately from the app's own id field for each `fos` record — the two
 * are allowed to differ by design, but until now nothing made that visible
 * outside the console log firebaseBackend.ts already prints per-doc. */
export interface FosDiagRecord {
  docId: string;
  dataId: unknown;
  dataIdType: string;
  name: unknown;
}

export interface FosDiagSnapshot {
  records: FosDiagRecord[];
  capturedAt: number;
  /** 1-indexed count of how many `fos` snapshots have arrived this page
   * load (onSnapshot fires again on every remote change, not just once) —
   * lets the panel/report distinguish "only ever got one snapshot" from "a
   * later snapshot silently replaced an earlier, correct one" (hypothesis
   * E) without needing console access to see the history. The panel only
   * ever shows the latest snapshot's records; this number is what proves
   * whether "latest" and "only" are the same thing right now. */
  snapshotNumber: number;
}

const CHANGE_EVENT = "city-ops-fos-diag-change";
let lastSnapshot: FosDiagSnapshot | null = null;
let snapshotCounter = 0;

export function setFosDiagSnapshot(records: FosDiagRecord[]): void {
  snapshotCounter += 1;
  lastSnapshot = { records, capturedAt: Date.now(), snapshotNumber: snapshotCounter };
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function getFosDiagSnapshot(): FosDiagSnapshot | null {
  return lastSnapshot;
}

export function onFosDiagChange(cb: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, cb);
  return () => window.removeEventListener(CHANGE_EVENT, cb);
}

declare global {
  interface Window {
    /** Test-only seam (mirrors __CITY_OPS_TEST_SET_PROFILE_DIAG__) — the
     * mocked test backend (__CITY_OPS_TEST_BACKEND__) conforms to
     * RemoteBackend, which has no doc-ID field at all, so this is the only
     * way to exercise the docId-vs-data.id panel rendering in Playwright
     * without a live/emulated Firestore project. Inert for real users. */
    __CITY_OPS_TEST_SET_FOS_DIAG__?: (records: FosDiagRecord[]) => void;
  }
}

if (typeof window !== "undefined") {
  window.__CITY_OPS_TEST_SET_FOS_DIAG__ = setFosDiagSnapshot;
}
