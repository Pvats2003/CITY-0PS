import { useCity } from "@/store/city";
import { isFirebaseConfigured } from "@/auth/config";
import { waitForAuthReady } from "@/auth/authReady";
import { COLLECTION_NAMES, type CollectionName, type RemoteBackend } from "./backend";
import { localBackend } from "./localBackend";
import { enqueue, drainOutbox } from "./outbox";
import type { CityStore } from "@/store/city";

const SYNCED_CHANGE_EVENT = "city-ops-synced-collections-change";
const syncedCollections = new Set<CollectionName>();

function markSynced(name: CollectionName) {
  if (syncedCollections.has(name)) return;
  syncedCollections.add(name);
  window.dispatchEvent(new CustomEvent(SYNCED_CHANGE_EVENT));
}

/** Has this collection received at least one snapshot from the remote
 * backend since page load? Demo mode never marks anything synced (there's
 * nothing remote to wait for — see useCollectionSyncStatus.ts, which treats
 * demo mode as its own case rather than a permanent "loading"). */
export function hasSyncedOnce(name: CollectionName): boolean {
  return syncedCollections.has(name);
}

export function onSyncedCollectionsChange(cb: () => void): () => void {
  window.addEventListener(SYNCED_CHANGE_EVENT, cb);
  return () => window.removeEventListener(SYNCED_CHANGE_EVENT, cb);
}

declare global {
  interface Window {
    /** Test-only seam (see DEPLOYMENT.md "Testing the sync engine without
     * Firebase"). When set before startSyncEngine() runs, it's used in
     * place of the real Firebase/local choice — lets Playwright verify the
     * outbox/online-offline contract with an in-memory mock, since there is
     * no way to exercise a live Firestore project in this environment.
     * Inert for real users: nothing in the shipped app ever sets this. */
    __CITY_OPS_TEST_BACKEND__?: RemoteBackend;
  }
}

let started = false;
let applyingRemoteUpdate = false;

/** Wires the Zustand store to a shared backend: local mutations flow out
 * through the outbox, remote changes flow in via subscribeCollection. A
 * no-op in demo mode (no Firebase configured, no test backend injected) —
 * the store behaves exactly as it did before multi-user support. */
export async function startSyncEngine(): Promise<void> {
  if (started) return;
  started = true;

  let backend: RemoteBackend;
  if (window.__CITY_OPS_TEST_BACKEND__) {
    backend = window.__CITY_OPS_TEST_BACKEND__;
  } else if (isFirebaseConfigured()) {
    const { firebaseBackend } = await import("./firebaseBackend");
    backend = firebaseBackend;
  } else {
    backend = localBackend;
    return; // demo mode: no subscriptions, no outbox draining, zero network
  }

  // Wait for a real signed-in identity before attaching any listener. Every
  // shared collection's rules require isSignedIn() — subscribing while
  // signed out gets denied immediately, and the Firestore SDK tears down
  // (never retries) a listener that's been denied once, even after the
  // user then signs in. Without this, a collection subscribed on an
  // unauthenticated first page load (e.g. /fo/login, before the sign-in
  // form is even submitted) can stay permanently empty for the rest of the
  // session — the concrete cause of "FO record not found" despite a
  // correct foId and a matching fos/{doc}.
  await waitForAuthReady();

  // Remote -> local: each collection's current document set replaces ours.
  for (const name of COLLECTION_NAMES) {
    backend.subscribeCollection(name, (docs) => {
      applyingRemoteUpdate = true;
      useCity.getState().mergeRemoteCollection(name, docs);
      applyingRemoteUpdate = false;
      markSynced(name);
    });
  }

  // Local -> outbox: Immer preserves referential identity for untouched
  // records, so a shallow reference diff of each collection tells us
  // exactly which records changed or were removed, without deep-equality.
  //
  // Must wait for the persist middleware's rehydration to finish before
  // capturing the diff baseline — otherwise the pre-hydration empty state
  // looks like every already-stored record was "just created," flooding
  // the outbox with the entire local dataset on every app boot.
  function attachLocalWatcher() {
    let prev = useCity.getState();
    useCity.subscribe((state: CityStore) => {
      if (applyingRemoteUpdate) {
        prev = state;
        return;
      }
      const queued: Promise<void>[] = [];
      for (const name of COLLECTION_NAMES) {
        const prevArr = prev[name] as { id: string }[];
        const nextArr = state[name] as { id: string }[];
        if (prevArr === nextArr) continue;
        const prevById = new Map(prevArr.map((r) => [r.id, r]));
        for (const record of nextArr) {
          if (prevById.get(record.id) !== record) {
            queued.push(enqueue({ collection: name, id: record.id, data: record as unknown as Record<string, unknown> }));
          }
        }
        const nextIds = new Set(nextArr.map((r) => r.id));
        for (const record of prevArr) {
          if (!nextIds.has(record.id)) queued.push(enqueue({ collection: name, id: record.id, data: null }));
        }
      }
      prev = state;
      // Attempt to push immediately once every queued write has actually
      // landed in IndexedDB — this is what makes sync "near-real-time"
      // instead of "eventually, next time the app happens to start."
      if (queued.length > 0) void Promise.all(queued).then(() => drainOutbox(backend));
    });
  }

  if (useCity.persist.hasHydrated()) {
    attachLocalWatcher();
  } else {
    useCity.persist.onFinishHydration(attachLocalWatcher);
  }

  window.addEventListener("online", () => drainOutbox(backend));
  void drainOutbox(backend);
}
