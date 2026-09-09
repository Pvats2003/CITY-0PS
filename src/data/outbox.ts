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

/** Pushes every queued entry to the backend, in the order they were first
 * queued. Stops at the first failure (network drop mid-drain, a rule
 * rejection, etc.) rather than reordering or skipping — the next `online`
 * event or manual retry picks up where it left off. Never drops a write. */
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
      notifyChange();
    } catch {
      break;
    }
  }
}
