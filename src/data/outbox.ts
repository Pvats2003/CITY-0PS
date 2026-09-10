import { get, set, del, keys } from "idb-keyval";
import { omitUndefined } from "@/lib/omitUndefined";
import type { CollectionName, RemoteBackend } from "./backend";

declare global {
  interface Window {
    /** Test-only seam (mirrors __CITY_OPS_TEST_BACKEND__/
     * __CITY_OPS_TEST_AUTH_PROVIDER__) — lets Playwright simulate a real
     * Firestore permission-denied surfacing as a per-collection SYNC ERROR,
     * without a live project. Assigned unconditionally below (a plain
     * function reference, nothing sensitive); inert for real users since
     * nothing in the shipped app ever calls it. */
    __CITY_OPS_TEST_FORCE_SYNC_ERROR__?: (collection: CollectionName, message: string, code?: string) => void;
  }
}

export interface OutboxEntry {
  collection: CollectionName;
  id: string;
  /** null means "delete this record" — a tombstone. */
  data: Record<string, unknown> | null;
  queuedAt: string;
}

const OUTBOX_CHANGE_EVENT = "city-ops-outbox-change";

function keyFor(collection: CollectionName, id: string): string {
  // Keying by collection+id (not a timestamp) means rapid repeated edits to
  // the same record collapse into one queued write — last value wins,
  // rather than piling up stale intermediate entries.
  return `outbox:${collection}:${id}`;
}

function notifyChange() {
  window.dispatchEvent(new CustomEvent(OUTBOX_CHANGE_EVENT));
}

export function onOutboxChange(cb: () => void): () => void {
  window.addEventListener(OUTBOX_CHANGE_EVENT, cb);
  return () => window.removeEventListener(OUTBOX_CHANGE_EVENT, cb);
}

/** Every collection's every write funnels through here on its way to
 * IndexedDB and then Firestore — the single chokepoint, regardless of
 * which store action or future code path produced the record. Stripping
 * explicit `undefined` values HERE, not just at each form dialog's own
 * payload construction, means a missed call site (e.g. the AI Planner's
 * proposeDailyPlan(), which built `rigId: rig?.id` — an explicit
 * `undefined` property Firestore's setDoc() rejects client-side — and
 * shipped for a full round of "fix the dialogs" before this was found)
 * can never again reach Firestore un-sanitized. Per-call-site
 * omitUndefined() calls stay in place as the immediate, readable fix at
 * the point of construction; this is the backstop that makes the bug
 * class structurally impossible to reintroduce anywhere in the app. */
export async function enqueue(entry: { collection: CollectionName; id: string; data: Record<string, unknown> | null }): Promise<void> {
  const data = entry.data === null ? null : omitUndefined(entry.data);
  await set(keyFor(entry.collection, entry.id), { ...entry, data, queuedAt: new Date().toISOString() } satisfies OutboxEntry);
  notifyChange();
}

export async function outboxDepth(): Promise<number> {
  const allKeys = await keys();
  return allKeys.filter((k) => typeof k === "string" && k.startsWith("outbox:")).length;
}

interface SyncErrorDetail {
  code: string;
  message: string;
}

// Per-collection, not a single global flag: a denied listener on one
// collection (e.g. a Manager-only collection an FO was never granted, or
// any other collection-specific hiccup) must never be indistinguishable
// from an error on a DIFFERENT collection a page actually depends on. A
// page that only cares about `fos` reads ONLY `fos`'s own entry via
// getCollectionSyncError(); the aggregate getSyncError() below (still used
// by the Manager-wide system status widgets) reports whether ANYTHING,
// anywhere, has an error, for that different, deliberately broader purpose.
const collectionSyncErrors = new Map<CollectionName, SyncErrorDetail>();

/** Real error only — never fabricated. Cleared the moment a write or
 * listener on THIS collection actually succeeds. Distinct from "offline":
 * this is set when a write/read was rejected while genuinely online (rules
 * denial, backend unavailable, etc.) — the one case where the UI must say
 * SYNC ERROR rather than pretend success or silently retry forever. */
export function getCollectionSyncError(collection: CollectionName): string | null {
  return collectionSyncErrors.get(collection)?.message ?? null;
}

/** The raw Firestore error code (e.g. "permission-denied") behind THIS
 * collection's current error, or null if it has none. Kept separate from
 * the human-readable message above so a diagnostic surface can show both —
 * see FoDiagnosticPanel.tsx's SYNC FAILURES section. */
export function getCollectionSyncErrorCode(collection: CollectionName): string | null {
  return collectionSyncErrors.get(collection)?.code ?? null;
}

/** Every collection that currently has an error, in one call — diagnostic
 * surfaces need to show ALL failing collections at once (never just "an
 * example"), unlike getSyncError() below. */
export function getAllCollectionSyncErrors(): Array<{ collection: CollectionName } & SyncErrorDetail> {
  return [...collectionSyncErrors.entries()].map(([collection, detail]) => ({ collection, ...detail }));
}

/** Aggregate view across every collection — "is anything wrong right now,
 * and what's one example message" — for the Manager-wide system status
 * pill/dialog and the FO shell's own-writes sync banner, both of which are
 * deliberately collection-agnostic ("is sync healthy overall"), unlike a
 * page gating its OWN render on one specific collection's data. */
export function getSyncError(): string | null {
  const first = collectionSyncErrors.values().next();
  return first.done ? null : first.value.message;
}

/** Shared by both write failures (drainOutbox, below) and realtime listener
 * failures (firebaseBackend's onSnapshot error callback) — either way, a
 * real rejection while online must surface as SYNC ERROR, never be
 * swallowed silently (the earlier failure mode: a denied listener just
 * left a collection permanently empty with no visible sign anything was
 * wrong), and never bleed into a DIFFERENT collection's status (the later
 * failure mode: an unrelated collection's expected-by-role denial made an
 * otherwise-working page show "permission denied" forever). `code`
 * defaults to "unknown" only for callers that genuinely have no raw
 * Firestore error code to hand over (there are none left in this codebase,
 * but the test seam and any future caller stay callable without it). */
export function reportSyncError(collection: CollectionName, message: string, code = "unknown"): void {
  collectionSyncErrors.set(collection, { code, message });
  notifyChange();
}

/** Omit `collection` to clear every collection's error at once (used when
 * going back online, where any previously-queued failures are about to be
 * retried from scratch). */
export function clearSyncError(collection?: CollectionName): void {
  if (collection) {
    if (collectionSyncErrors.delete(collection)) notifyChange();
  } else if (collectionSyncErrors.size > 0) {
    collectionSyncErrors.clear();
    notifyChange();
  }
}

if (typeof window !== "undefined") {
  window.__CITY_OPS_TEST_FORCE_SYNC_ERROR__ = reportSyncError;
}

export function describeError(err: unknown): string {
  const code = (err as { code?: string } | undefined)?.code;
  if (code === "permission-denied") return "Permission denied — you may not have access to this data.";
  if (code === "unavailable") return "The server is temporarily unavailable.";
  return err instanceof Error ? err.message : "Sync failed.";
}

// A single store mutation can trigger more than one `drainOutbox()` call
// (e.g. addBusiness() both pushes a business AND logs an activity event as
// two separate, synchronous Zustand updates — see syncEngine.ts's local
// watcher — each schedules its own post-enqueue drain). Without a guard,
// two overlapping drains can both read the same not-yet-deleted outbox
// entry before either finishes its own `del()`, and both call
// `backend.putDoc()` for it — a real duplicate Firestore write, proven via
// a production-build reproduction. `putDoc` is idempotent
// (`setDoc(..., {merge:true})`) so this was never a correctness/data-loss
// bug, but it doubles (or, with more overlapping triggers, multiplies)
// Firestore write cost for no reason. Serializing drains — any call that
// arrives while one is already in flight just requests one more full pass
// once the current one finishes, rather than racing it — removes the
// window entirely without changing retry/ordering semantics.
let draining = false;
let drainQueued = false;

/** Pushes every queued entry to the backend, in the order they were first
 * queued. Stops at the first RETRIABLE failure rather than reordering or
 * skipping — the next `online` event or manual retry picks up where it
 * left off. Never drops a write. A failure while still online is a real
 * SYNC ERROR; a failure caused by losing connectivity mid-drain is not —
 * that's just "offline," and is cleared silently on the next successful
 * drain.
 *
 * "invalid-argument" is the one exception to "stop at the first failure":
 * it's the Firestore SDK's own client-side data-validation rejection
 * (e.g. a document with an explicit `undefined` field — see
 * omitUndefined.ts), thrown before any network call ever happens. Unlike
 * a connectivity or permission problem, retrying it changes nothing, and
 * because `keys()` is iterated in a fixed lexicographic order every entry
 * queued for a collection whose name sorts after the broken one (which,
 * for "assignments", is almost everything) would otherwise be
 * PERMANENTLY blocked behind it forever — every subsequent drain
 * restarts from the same first key and hits the same entry again. Proven
 * in production: a single malformed assignment left Firestore with
 * businesses/fos/rigs/users/activity but zero assignments, and unrelated
 * later writes (e.g. a newly added Business) silently never synced
 * either, because they were queued alphabetically behind the stuck
 * assignment entry. The broken entry itself is never deleted — it keeps
 * reporting a real SYNC ERROR for its own collection until the
 * application code that produced it is fixed — but it no longer holds
 * every other collection's valid writes hostage.
 *
 * Also re-sanitizes `entry.data` with omitUndefined() here, in addition to
 * enqueue()'s own sanitization above — NOT redundant. enqueue() only
 * protects writes made by the CURRENT build; it cannot retroactively clean
 * bytes a previous, buggy build already wrote into this browser's
 * IndexedDB before a fix shipped. That's exactly what happened in
 * production: an assignment queued by the pre-fix proposeDailyPlan() (see
 * engine/planner.ts) sat in the outbox with an explicit `collectorId:
 * undefined`, survived the deploy untouched (a deploy changes the app's
 * code, not a viewer's already-written IndexedDB), and kept failing with
 * "invalid-argument" on every drain thereafter — proving the construction
 * fix and the enqueue()-time backstop alone were insufficient. Sanitizing
 * again right here, immediately before the write, means it doesn't matter
 * how old an entry is or which build wrote it: nothing manual (no
 * clearing the outbox, no touching IndexedDB by hand) is ever required to
 * recover once the underlying bug is fixed. */
export async function drainOutbox(backend: RemoteBackend): Promise<void> {
  if (draining) {
    drainQueued = true;
    return;
  }
  draining = true;
  try {
    if (!navigator.onLine) return;
    const allKeys = (await keys()).filter((k): k is string => typeof k === "string" && k.startsWith("outbox:"));
    for (const key of allKeys) {
      const entry = (await get(key)) as OutboxEntry | undefined;
      if (!entry) continue;
      try {
        if (entry.data === null) await backend.deleteDoc(entry.collection, entry.id);
        else await backend.putDoc(entry.collection, entry.id, omitUndefined(entry.data));
        await del(key);
        clearSyncError(entry.collection);
      } catch (err) {
        if (!navigator.onLine) break; // lost connectivity mid-drain — not an error
        const code = (err as { code?: string } | undefined)?.code ?? "unknown";
        reportSyncError(entry.collection, describeError(err), code);
        if (code === "invalid-argument") continue; // permanently broken data — don't block the rest of the queue
        break;
      }
    }
  } finally {
    draining = false;
    if (drainQueued) {
      drainQueued = false;
      void drainOutbox(backend);
    }
  }
}
