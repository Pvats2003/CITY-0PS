import { get, set, del, keys } from "idb-keyval";
import type { CollectionName, RemoteBackend } from "./backend";

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

let lastSyncError: string | null = null;

/** Real error only — never fabricated. Cleared the moment a write actually
 * succeeds. Distinct from "offline": this is set when a write was rejected
 * while genuinely online (rules denial, backend unavailable, etc.) — the
 * one case where the UI must say SYNC ERROR rather than pretend success or
 * silently retry forever (spec: never claim an operation succeeded when it
 * didn't). */
export function getSyncError(): string | null {
  return lastSyncError;
}

/** Shared by both write failures (drainOutbox, below) and realtime listener
 * failures (firebaseBackend's onSnapshot error callback) — either way, a
 * real rejection while online must surface as SYNC ERROR, never be
 * swallowed silently (the earlier failure mode: a denied listener just
 * left a collection permanently empty with no visible sign anything was
 * wrong). */
export function reportSyncError(message: string): void {
  lastSyncError = message;
  notifyChange();
}

export function clearSyncError(): void {
  if (lastSyncError) {
    lastSyncError = null;
    notifyChange();
  }
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
      clearSyncError();
    } catch (err) {
      if (!navigator.onLine) break; // lost connectivity mid-drain — not an error
      reportSyncError(describeError(err));
      break;
    }
  }
}
