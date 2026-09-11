import { useCity } from "@/store/city";
import { isFirebaseConfigured } from "@/auth/config";
import { waitForAuthReady } from "@/auth/authReady";
import type { UserRole } from "@/auth/types";
import { COLLECTION_NAMES, type CollectionName, type RemoteBackend } from "./backend";
import { localBackend } from "./localBackend";
import { enqueue, drainOutbox, clearSyncError, getCollectionSyncError } from "./outbox";
import { drainMediaOutbox, onMediaOutboxChange } from "./mediaOutbox";
import type { CityStore } from "@/store/city";
import type { Evidence } from "@/types";

/** Mirrors firestore.rules exactly: a Field Officer has an explicit `match`
 * block granting read on only these 9 collections; the rest (collectors,
 * qualityReviews, correctiveActions, repairRecords, plans, reports) fall
 * through to the Manager-only wildcard rule. Subscribing an FO to those
 * anyway is a request Firestore will always deny by design — not a rules
 * bug, but doing it anyway poisons the shared sync-error state with an
 * expected denial, masking whether collections the FO IS granted (like
 * fos) are actually working. Keep in sync with firestore.rules if that
 * file's FO grants ever change. */
export const FIELD_OFFICER_COLLECTIONS: CollectionName[] = ["fos", "businesses", "rigs", "assignments", "sessions", "issues", "rigIncidents", "activity", "evidence"];

function collectionsForRole(role: UserRole | null): CollectionName[] {
  // null (role unresolved — demo mode, or the profile read failed) falls
  // back to every collection, the historical role-blind behavior, rather
  // than silently under-subscribing a Manager.
  return role === "FIELD_OFFICER" ? FIELD_OFFICER_COLLECTIONS : COLLECTION_NAMES;
}

/** True once every photo on this evidence record has finished uploading (or
 * never had one to begin with — undefined uploadStatus covers both
 * pre-media-durability records and non-photo evidence like a LOCATION or
 * text-only OTHER submission). Used to decide whether an FO-authored
 * evidence record is safe to sync to Firestore yet — see the comment on
 * `syncedEvidenceOnceIds` below for why the FO side can only ever do this
 * once, in the record's final state. */
export function evidenceReadyToSync(record: Evidence): boolean {
  return record.files.every((f) => f.uploadStatus == null || f.uploadStatus === "uploaded");
}

// Durable (localStorage-backed, separate key — same "own key, never touches
// the main store's DATA_VERSION/migrate logic" pattern as city-ops-auth)
// record of every evidence id that has already been enqueued to Firestore
// at least once. `evidence/{docId}` in firestore.rules grants the Field
// Officer CREATE only, never UPDATE — so a second enqueue for an id already
// durably written would be a permission-denied write, not a harmless retry.
// This MUST survive reloads: reconciliation (below) re-scans the FULL local
// evidence array on every startup, so an in-memory-only Set would forget
// every historical record on each reload and re-enqueue (and get denied on)
// all of them, every single time the app loads.
const SYNCED_EVIDENCE_STORAGE_KEY = "city-ops-synced-evidence-ids";

function loadPersistedSyncedEvidenceIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(SYNCED_EVIDENCE_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function persistSyncedEvidenceIds(ids: Set<string>): void {
  try {
    window.localStorage.setItem(SYNCED_EVIDENCE_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage unavailable/full — the in-memory Set below still prevents a
    // duplicate enqueue for the rest of this session; worst case is a
    // future reload re-scans this id, exactly as if it were new.
  }
}

function markEvidenceSyncedOnce(id: string): void {
  if (syncedEvidenceOnceIds.has(id)) return;
  syncedEvidenceOnceIds.add(id);
  persistSyncedEvidenceIds(syncedEvidenceOnceIds);
}

// In-memory-only guard against firing a SECOND enqueue() call for the same
// evidence id while an earlier one is still in flight — the local watcher
// and reconcileEvidenceSync() can both observe the same newly-ready record
// in quick succession (e.g. two onMediaOutboxChange events back to back),
// and without this, both could race to call enqueue() concurrently before
// either had a chance to mark the id synced. idb-keyval's keyFor()-keyed
// set() would make that harmless in practice (same key, last-value-wins),
// but this avoids the wasted duplicate write outright. Never persisted —
// "in flight right now" has no meaning across a reload.
const pendingEvidenceEnqueues = new Set<string>();

/** Enqueues ONE FO-authored evidence record's Firestore write, marking it
 * durably synced ONLY once enqueue() has actually resolved — i.e. only
 * once the outbox entry genuinely, durably exists in IndexedDB. This is
 * deliberately NOT the same thing as "this evidence has reached
 * Firestore": that retry loop (network failure, offline, a real
 * permission-denied) lives entirely in drainOutbox()/outbox.ts and stays
 * untouched by syncedEvidenceOnceIds once an entry is queued —
 * drainOutbox() keeps retrying an already-queued entry regardless of this
 * Set, on every subsequent drain, until it actually succeeds or hits a
 * non-retriable client-side error. What this function (and the durable
 * Set it maintains) exists to prevent is a SECOND, independent enqueue()
 * call for an id whose outbox entry was already durably created — THAT's
 * what would eventually produce an illegal second Firestore write attempt
 * against evidence/{docId}'s create-only rule, once the first entry
 * drains successfully.
 *
 * If enqueue() itself throws (a real, if rare, failure mode — e.g.
 * IndexedDB unavailable or over quota), the id is deliberately left
 * UNMARKED: marking it here before the outbox entry actually exists would
 * permanently and silently drop this evidence from ever syncing — no
 * outbox entry left to retry, and no future reconciliation pass would
 * ever attempt it again, since it would already look "done." Leaving it
 * unmarked means the next watcher transition or reconciliation pass
 * retries the enqueue instead of losing the record. */
async function enqueueEvidenceOnce(record: Evidence): Promise<void> {
  if (syncedEvidenceOnceIds.has(record.id) || pendingEvidenceEnqueues.has(record.id)) return;
  pendingEvidenceEnqueues.add(record.id);
  try {
    await enqueue({ collection: "evidence", id: record.id, data: record as unknown as Record<string, unknown> });
    markEvidenceSyncedOnce(record.id);
  } catch (err) {
    console.error("[CITY-OPS] failed to durably enqueue evidence " + record.id + " to the outbox — will retry on the next sync pass", err);
  } finally {
    pendingEvidenceEnqueues.delete(record.id);
  }
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
// Evidence ids this FO's client has already enqueued to Firestore, ever
// (this run of the engine). A Field Officer has no `update` grant on
// evidence at all (see firestore.rules — append-only by design), so their
// FIRST write of a given evidence record must already be its final,
// fully-uploaded state: syncing it a second time, even to add a
// downloadUrl a photo finished uploading a moment later, would be rejected.
// Only relevant when `scope` (an FO's own foId) is set; a Manager's writes
// are unrestricted and never consult this set. Reset on resetSyncEngine()
// the same as every other per-run tracking state below.
const syncedEvidenceOnceIds = new Set<string>();
// Every teardown function this run of the engine created — listener
// unsubscribes, the local Zustand watcher, the `online` handler — so
// resetSyncEngine() can cleanly stop ALL of them, not just flip the
// `started` flag back to false and leave the previous user's listeners
// (and their in-flight errors) still attached underneath.
let teardowns: Array<() => void> = [];
// The backend/scope this run of the engine is currently wired to — set once
// at the top of startSyncEngine() (right after `scope` is computed) and
// cleared in resetSyncEngine(). reconcileEvidenceSync() (below) needs both
// to enqueue+drain outside of the attachLocalWatcher() closure (it's called
// from the media-outbox-change listener and from goOnline(), neither of
// which has `backend`/`scope` in scope otherwise).
let currentBackend: RemoteBackend | null = null;
let currentScope: { foId: string } | undefined;

/** Reconciliation pass — the fix for the architectural gap where Firestore
 * evidence sync was purely edge-triggered: attachLocalWatcher() (below)
 * only reacts to a LIVE Zustand transition it happens to observe. A media
 * upload can flip a file's uploadStatus from "uploading"/undefined to
 * "uploaded" (see mediaOutbox.ts's drainMediaOutbox()) at a moment when
 * nothing is watching — most concretely, the watcher isn't even attached
 * yet until persist hydration finishes, but the same gap exists across a
 * reload, background/foreground cycle, or any missed subscribe() callback.
 * When that happens, the evidence record silently never reaches Firestore,
 * even though the underlying Storage upload succeeded — this is exactly
 * the shape of the production ev_5l13axhb37 orphan (a real uploaded
 * Supabase object with no matching Firestore document anywhere).
 *
 * This function does NOT depend on having observed any particular
 * transition: it re-scans the FULL current local evidence array every time
 * it's called, and finds anything that is ready to sync (evidenceReadyToSync)
 * but not yet durably enqueued (syncedEvidenceOnceIds — persisted, see
 * markEvidenceSyncedOnce() above). Called from three places below: once
 * after the local watcher is attached (covers startup, in both the
 * already-hydrated and hydrate-later cases), once on every media outbox
 * drain via onMediaOutboxChange() (covers an upload finishing between
 * watcher observations), and once on `online` (covers a reconnect after
 * either kind of miss happened while offline).
 *
 * Idempotent: syncedEvidenceOnceIds is checked-then-marked before any
 * enqueue, and is durable across reloads, so a record already enqueued by
 * the local watcher OR by a previous reconciliation pass is never
 * enqueued again — this is what prevents ever attempting a second
 * (permission-denied) write against evidence/{docId}'s create-only rule. */
function reconcileEvidenceSync(): void {
  if (!currentBackend || !currentScope) return; // Manager sessions never call this at all — see call sites below
  const backend = currentBackend;
  const toEnqueue = (useCity.getState().evidence as unknown as Evidence[]).filter(
    (record) => !syncedEvidenceOnceIds.has(record.id) && evidenceReadyToSync(record),
  );
  if (toEnqueue.length === 0) return;
  // enqueueEvidenceOnce() marks each record synced ONLY after its own
  // enqueue() has actually resolved (see its doc comment) — never marks
  // eagerly here, so a record whose enqueue() genuinely fails stays
  // eligible for the NEXT reconciliation pass instead of being silently
  // and permanently dropped.
  void Promise.all(toEnqueue.map((record) => enqueueEvidenceOnce(record))).then(() => drainOutbox(backend));
}

/** Wires the Zustand store to a shared backend: local mutations flow out
 * through the outbox, remote changes flow in via subscribeCollection. A
 * no-op in demo mode (no Firebase configured, no test backend injected) —
 * the store behaves exactly as it did before multi-user support.
 *
 * Safe to call again after resetSyncEngine() — e.g. on a fresh sign-in
 * following a sign-out in the same tab, where nothing else re-triggers
 * this (no full page reload) and `started` would otherwise permanently
 * latch this to the FIRST signed-in user/role for the rest of the tab's
 * lifetime. */
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
  const { role, foId } = await waitForAuthReady();
  const collectionsToSync = collectionsForRole(role);
  // Passed to every subscription (subscribeCollection ignores it for
  // collections that don't need it) — only firebaseBackend.ts's ownership-
  // scoped collections (assignments/sessions/issues/rigIncidents) actually
  // use it, to build the `where("foId", "==", ...)` their firestore.rules
  // grant requires for any list/listen to succeed at all.
  const scope = role === "FIELD_OFFICER" && foId ? { foId } : undefined;
  currentBackend = backend;
  currentScope = scope;
  // Seed the in-memory tracking Set from the durable, persisted record of
  // every evidence id this FO has ever enqueued — done on every
  // startSyncEngine() call (not just once at module load) so it's correct
  // both on a fresh page load AND after a resetSyncEngine()+re-sign-in
  // cycle in the same tab, either of which would otherwise start this
  // Set empty while Firestore already durably has these records.
  if (scope) {
    for (const id of loadPersistedSyncedEvidenceIds()) syncedEvidenceOnceIds.add(id);
  }

  // Remote -> local: each collection's current document set replaces ours.
  for (const name of collectionsToSync) {
    const unsub = backend.subscribeCollection(name, (docs) => {
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
    }, scope);
    teardowns.push(unsub);
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
    const unsub = useCity.subscribe((state: CityStore) => {
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
          if (prevById.get(record.id) === record) continue;
          // FO-authored evidence: hold off until every photo has finished
          // uploading, and never enqueue the same record twice (see
          // syncedEvidenceOnceIds above). Every other collection, and every
          // Manager write (scope undefined), syncs on every change exactly
          // as before — this only narrows the one case that would
          // otherwise produce an `update` Firestore rejects.
          if (name === "evidence" && scope) {
            if (syncedEvidenceOnceIds.has(record.id)) continue;
            if (!evidenceReadyToSync(record as unknown as Evidence)) continue;
            // enqueueEvidenceOnce() owns both the enqueue() call and the
            // (post-success-only) durable mark — see its doc comment for
            // why marking must never happen before enqueue() resolves.
            queued.push(enqueueEvidenceOnce(record as unknown as Evidence));
            continue;
          }
          queued.push(enqueue({ collection: name, id: record.id, data: record as unknown as Record<string, unknown> }));
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
    teardowns.push(unsub);
  }

  // Reconciliation runs once right after the local watcher is attached, in
  // BOTH branches below — this is what covers "sync engine starts after
  // persisted state has already hydrated" and "app boots with evidence
  // already sitting in a ready-to-sync state from a previous session"
  // (e.g. an upload that finished while the tab was closed). It is not a
  // substitute for attachLocalWatcher(): the watcher still handles the
  // common case (a live transition it actually observes) without waiting
  // for the next reconciliation trigger.
  if (useCity.persist.hasHydrated()) {
    attachLocalWatcher();
    reconcileEvidenceSync();
  } else {
    useCity.persist.onFinishHydration(() => {
      attachLocalWatcher();
      reconcileEvidenceSync();
    });
  }

  // A media upload finishing is exactly the kind of transition the local
  // watcher (a Zustand subscribe()) can miss the FIRST write of — e.g. the
  // watcher observes evidence's array reference change when the record is
  // first added (uploadStatus "uploading", not yet ready), then the file's
  // uploadStatus flips to "uploaded" via mediaOutbox.ts's
  // setFileUploadStatus() sometime later; if the watcher's subscribe
  // callback isn't invoked again in between (or the tab was backgrounded),
  // reconciliation is the only thing that ever notices the record became
  // ready. Subscribing to the outbox's own change event (already exported,
  // fired on both success and failure of each queued file) avoids a
  // circular import with mediaOutbox.ts, which already imports nothing back
  // from this module.
  const unsubMediaOutbox = onMediaOutboxChange(() => reconcileEvidenceSync());
  teardowns.push(unsubMediaOutbox);

  const goOnline = () => {
    void drainOutbox(backend);
    void drainMediaOutbox();
    // Reconnecting is another point where a missed transition (one that
    // happened while offline, when neither the outbox drain nor a Firestore
    // write could have gone anywhere) needs a fresh look.
    reconcileEvidenceSync();
  };
  window.addEventListener("online", goOnline);
  teardowns.push(() => window.removeEventListener("online", goOnline));
  void drainOutbox(backend);
  // Photos queued from a previous session (offline capture, then the tab
  // closed before they finished uploading) resume here — the media outbox
  // lives in IndexedDB, independent of this run of the sync engine.
  void drainMediaOutbox();
}

/** Tears down every listener/watcher this run of the engine attached and
 * resets its state so a subsequent startSyncEngine() call (after a fresh
 * sign-in) starts completely clean — new role-appropriate subscriptions,
 * new scope, no leftover errors from the PREVIOUS signed-in account.
 * Without this, `started` latches the engine to whichever user was signed
 * in when it first ran, for the rest of the tab's lifetime: a sign-out
 * followed by a different sign-in (no full page reload) would leave the
 * old user's listeners attached and any of their sync errors still
 * visible, with no new subscriptions ever created for the new user's role.
 * Called from AuthContext on every transition into "anon" (a real
 * sign-out), never on transient states (loading, needs_setup, error) that
 * aren't actually a completed sign-out. */
export function resetSyncEngine(): void {
  for (const teardown of teardowns) teardown();
  teardowns = [];
  started = false;
  applyingRemoteUpdate = false;
  currentBackend = null;
  currentScope = undefined;
  syncedCollections.clear();
  // In-memory only — the durable localStorage record (SYNCED_EVIDENCE_STORAGE_KEY)
  // is deliberately NOT cleared here: it belongs to the signed-out account's
  // already-synced Firestore history, which is still true regardless of who
  // signs in next in this tab. It's re-seeded fresh from storage at the top
  // of the next startSyncEngine() call for whichever scope is active then.
  syncedEvidenceOnceIds.clear();
  // Every collection's error, not just one — this is a full identity
  // change, not "this one collection recovered," so the aggregate
  // Manager-wide status pill and any per-collection reader alike must both
  // start clean rather than carry forward a denial that belonged to
  // whoever was signed in a moment ago.
  clearSyncError();
  window.dispatchEvent(new CustomEvent(SYNCED_CHANGE_EVENT));
}
