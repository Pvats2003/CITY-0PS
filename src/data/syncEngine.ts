import { useCity } from "@/store/city";
import { isFirebaseConfigured } from "@/auth/config";
import { waitForAuthReady } from "@/auth/authReady";
import type { UserRole } from "@/auth/types";
import { COLLECTION_NAMES, type CollectionName, type RemoteBackend } from "./backend";
import { localBackend } from "./localBackend";
import { enqueue, drainOutbox, clearSyncError, getCollectionSyncError } from "./outbox";
import type { CityStore } from "@/store/city";

/** Mirrors firestore.rules exactly: a Field Officer has an explicit `match`
 * block granting read on only these 8 collections; the rest (collectors,
 * evidence, qualityReviews, correctiveActions, repairRecords, plans,
 * reports) fall through to the Manager-only wildcard rule. Subscribing an
 * FO to those anyway is a request Firestore will always deny by design —
 * not a rules bug, but doing it anyway poisons the shared sync-error state
 * with an expected denial, masking whether collections the FO IS granted
 * (like fos) are actually working. Keep in sync with firestore.rules if
 * that file's FO grants ever change. */
const FIELD_OFFICER_COLLECTIONS: CollectionName[] = ["fos", "businesses", "rigs", "assignments", "sessions", "issues", "rigIncidents", "activity"];

function collectionsForRole(role: UserRole | null): CollectionName[] {
  // null (role unresolved — demo mode, or the profile read failed) falls
  // back to every collection, the historical role-blind behavior, rather
  // than silently under-subscribing a Manager.
  return role === "FIELD_OFFICER" ? FIELD_OFFICER_COLLECTIONS : COLLECTION_NAMES;
}

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

  // Wait for a real signed-in identity (and, on the real Firebase path,
  // their role) before attaching any listener. Every shared collection's
  // rules require isSignedIn() — subscribing while signed out gets denied
  // immediately, and the Firestore SDK tears down (never retries) a
  // listener that's been denied once, even after the user then signs in.
  // Without this, a collection subscribed on an unauthenticated first page
  // load (e.g. /fo/login, before the sign-in form is even submitted) can
  // stay permanently empty for the rest of the session — the concrete
  // cause of "FO record not found" despite a correct foId and a matching
  // fos/{doc}.
  const { role } = await waitForAuthReady();
  const collectionsToSync = collectionsForRole(role);

  // Remote -> local: each collection's current document set replaces ours.
  for (const name of collectionsToSync) {
    backend.subscribeCollection(name, (docs) => {
      applyingRemoteUpdate = true;
      useCity.getState().mergeRemoteCollection(name, docs);
      applyingRemoteUpdate = false;
      markSynced(name);
      // A successful snapshot on THIS collection proves the connection and
      // this account's access to THIS collection specifically are fine
      // right now — clear only this collection's own error. Deliberately
      // NOT clearing every collection's error here: a genuine, still-live
      // denial on a different collection must keep showing wherever it's
      // relevant (the Manager-wide status pill), while a page that only
      // cares about this one collection (like FOExecution and `fos`) reads
      // getCollectionSyncError(name) directly and was never affected by an
      // unrelated collection's error to begin with.
      clearSyncError(name);
      // TEMPORARY production diagnostic — primitive values, the state a
      // moment after this exact update, so a stale-looking UI can be
      // checked against what the sync layer actually believes right now.
      // Safe to delete once resolved.
      console.log(
        "[CITY-OPS-DIAG] collection sync state collection=" +
          name +
          " hasSyncedOnce=" +
          hasSyncedOnce(name) +
          " error=" +
          JSON.stringify(getCollectionSyncError(name)) +
          " count=" +
          docs.length,
      );
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
      for (const name of collectionsToSync) {
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
