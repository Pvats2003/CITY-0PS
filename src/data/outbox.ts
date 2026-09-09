import { get, set, del, keys } from "idb-keyval";
import type { CollectionName, RemoteBackend } from "./backend";

declare global {
  interface Window {
    /** Test-only seam (mirrors __CITY_OPS_TEST_BACKEND__/
     * __CITY_OPS_TEST_AUTH_PROVIDER__) — lets Playwright simulate a real
     * Firestore permission-denied surfacing as a per-collection SYNC ERROR,
     * without a live project. Assigned unconditionally below (a plain
     * function reference, nothing sensitive); inert for real users since
     * nothing in the shipped app ever calls it. */
    __CITY_OPS_TEST_FORCE_SYNC_ERROR__?: (collection: CollectionName, message: string) => void;
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

export async function enqueue(entry: { collection: CollectionName; id: string; data: Record<string, unknown> | null }): Promise<void> {
  await set(keyFor(entry.collection, entry.id), { ...entry, queuedAt: new Date().toISOString() } satisfies OutboxEntry);
  notifyChange();
}

export async function outboxDepth(): Promise<number> {
  const allKeys = await keys();
  return allKeys.filter((k) => typeof k === "string" && k.startsWith("outbox:")).length;
}

// Per-collection, not a single global flag: a denied listener on one
// collection (e.g. a Manager-only collection an FO was never granted, or
// any other collection-specific hiccup) must never be indistinguishable
// from an error on a DIFFERENT collection a page actually depends on. A
// page that only cares about `fos` reads ONLY `fos`'s own entry via
// getCollectionSyncError(); the aggregate getSyncError() below (still used
// by the Manager-wide system status widgets) reports whether ANYTHING,
// anywhere, has an error, for that different, deliberately broader purpose.
const collectionSyncErrors = new Map<CollectionName, string>();

/** Real error only — never fabricated. Cleared the moment a write or
 * listener on THIS collection actually succeeds. Distinct from "offline":
 * this is set when a write/read was rejected while genuinely online (rules
 * denial, backend unavailable, etc.) — the one case where the UI must say
 * SYNC ERROR rather than pretend success or silently retry forever. */
export function getCollectionSyncError(collection: CollectionName): string | null {
  return collectionSyncErrors.get(collection) ?? null;
}

/** Aggregate view across every collection — "is anything wrong right now,
 * and what's one example message" — for the Manager-wide system status
 * pill/dialog and the FO shell's own-writes sync banner, both of which are
 * deliberately collection-agnostic ("is sync healthy overall"), unlike a
 * page gating its OWN render on one specific collection's data. */
export function getSyncError(): string | null {
  const first = collectionSyncErrors.values().next();
  return first.done ? null : first.value;
}

/** Shared by both write failures (drainOutbox, below) and realtime listener
 * failures (firebaseBackend's onSnapshot error callback) — either way, a
 * real rejection while online must surface as SYNC ERROR, never be
 * swallowed silently (the earlier failure mode: a denied listener just
 * left a collection permanently empty with no visible sign anything was
 * wrong), and never bleed into a DIFFERENT collection's status (the later
 * failure mode: an unrelated collection's expected-by-role denial made an
 * otherwise-working page show "permission denied" forever). */
export function reportSyncError(collection: CollectionName, message: string): void {
  collectionSyncErrors.set(collection, message);
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

/** Pushes every queued entry to the backend, in the order they were first
 * queued. Stops at the first failure rather than reordering or skipping —
 * the next `online` event or manual retry picks up where it left off.
 * Never drops a write. A failure while still online is a real SYNC ERROR;
 * a failure caused by losing connectivity mid-drain is not — that's just
 * "offline," and is cleared silently on the next successful drain. */
export async function drainOutbox(backend: RemoteBackend): Promise<void> {
  if (!navigator.onLine) return;
  const allKeys = (await keys()).filter((k): k is string => typeof k === "string" && k.startsWith("outbox:"));
  for (const key of allKeys) {
    const entry = (await get(key)) as OutboxEntry | undefined;
    if (!entry) continue;
    try {
      if (entry.data === null) await backend.deleteDoc(entry.collection, entry.id);
      else await backend.putDoc(entry.collection, entry.id, entry.data);
      await del(key);
      clearSyncError(entry.collection);
    } catch (err) {
      if (!navigator.onLine) break; // lost connectivity mid-drain — not an error
      reportSyncError(entry.collection, describeError(err));
      break;
    }
  }
}
