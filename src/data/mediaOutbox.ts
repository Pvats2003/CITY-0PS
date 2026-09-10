import { get, set, del, keys } from "idb-keyval";
import { useCity } from "@/store/city";
import { isFirebaseConfigured } from "@/auth/config";
import { uploadEvidenceFile } from "./mediaStorage";

// ---------------------------------------------------------------------------
// Evidence PHOTO BINARY outbox — extends the exact same idb-keyval-backed,
// retry-on-reconnect outbox pattern as data/outbox.ts (same primitives, same
// philosophy: never drop a queued item, never silently fabricate success),
// applied to a different payload: a raw Blob destined for Firebase Storage
// rather than a JSON document destined for Firestore. Not a second,
// unrelated queue architecture — this is that one, extended for binaries
// (which idb-keyval already supports storing natively via IndexedDB's
// structured clone, unlike the Firestore outbox's plain-JSON entries).
// ---------------------------------------------------------------------------

export interface MediaOutboxEntry {
  foId: string;
  assignmentId: string;
  evidenceId: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  blob: Blob;
  queuedAt: string;
}

const MEDIA_OUTBOX_CHANGE_EVENT = "city-ops-media-outbox-change";
const KEY_PREFIX = "mediaOutbox:";

function keyFor(evidenceId: string, fileId: string): string {
  return `${KEY_PREFIX}${evidenceId}:${fileId}`;
}

function notifyChange() {
  window.dispatchEvent(new CustomEvent(MEDIA_OUTBOX_CHANGE_EVENT));
}

export function onMediaOutboxChange(cb: () => void): () => void {
  window.addEventListener(MEDIA_OUTBOX_CHANGE_EVENT, cb);
  return () => window.removeEventListener(MEDIA_OUTBOX_CHANGE_EVENT, cb);
}

export async function mediaOutboxDepth(): Promise<number> {
  const allKeys = await keys();
  return allKeys.filter((k) => typeof k === "string" && k.startsWith(KEY_PREFIX)).length;
}

/** Persists the raw file into IndexedDB immediately — durable the instant
 * this resolves, surviving a refresh or full browser restart even if the
 * upload itself hasn't started yet. Marks the file "uploading" locally so
 * the FO sees a pending-upload state right away.
 *
 * A no-op in demo mode (no Firebase configured): there is no bucket to
 * upload to, so the file stays "local_only" exactly as it always has —
 * no wasted IndexedDB writes, no doomed-to-fail retry loop. */
export async function enqueueMediaUpload(entry: Omit<MediaOutboxEntry, "queuedAt">): Promise<void> {
  if (!isFirebaseConfigured()) return;
  await set(keyFor(entry.evidenceId, entry.fileId), { ...entry, queuedAt: new Date().toISOString() } satisfies MediaOutboxEntry);
  setFileUploadStatus(entry.evidenceId, entry.fileId, { uploadStatus: "uploading" });
  notifyChange();
}

/** Mutates one file within one evidence record in place — the local,
 * synchronous source of truth the FO Cockpit and Manager review UI both
 * read from, independent of whether the Storage upload or the Firestore
 * sync has completed yet. */
function setFileUploadStatus(evidenceId: string, fileId: string, patch: { uploadStatus: "uploading" | "uploaded" | "upload_failed"; storagePath?: string; downloadUrl?: string }): void {
  const { evidence, updateEvidence } = useCity.getState();
  const record = evidence.find((e) => e.id === evidenceId);
  if (!record) return; // record was never actually created (defensive; shouldn't happen)
  const files = record.files.map((f) => (f.id === fileId ? { ...f, ...patch } : f));
  updateEvidence(evidenceId, { files });
}

/** Uploads every queued photo to Firebase Storage, in the order first
 * queued. Unlike the Firestore outbox this does not stop at the first
 * failure — one flaky/oversized upload must never block every other
 * queued photo from a different evidence record. Each entry retries
 * independently; a genuinely offline client just leaves everything queued
 * for the next `online` event, same as data/outbox.ts. */
export async function drainMediaOutbox(): Promise<void> {
  if (!isFirebaseConfigured() || !navigator.onLine) return;
  const allKeys = (await keys()).filter((k): k is string => typeof k === "string" && k.startsWith(KEY_PREFIX));
  for (const key of allKeys) {
    const entry = (await get(key)) as MediaOutboxEntry | undefined;
    if (!entry) continue;
    setFileUploadStatus(entry.evidenceId, entry.fileId, { uploadStatus: "uploading" });
    try {
      const uploaded = await uploadEvidenceFile({
        foId: entry.foId,
        assignmentId: entry.assignmentId,
        evidenceId: entry.evidenceId,
        fileId: entry.fileId,
        fileName: entry.fileName,
        mimeType: entry.mimeType,
        blob: entry.blob,
      });
      await del(key);
      setFileUploadStatus(entry.evidenceId, entry.fileId, { uploadStatus: "uploaded", storagePath: uploaded.storagePath, downloadUrl: uploaded.downloadUrl });
      notifyChange();
    } catch {
      // Left queued for the next drain (online event, next app start, or
      // the next enqueue elsewhere) — never dropped, never a fabricated
      // success. If connectivity itself dropped mid-loop, stop rather than
      // fail every remaining entry with the same transient error.
      if (!navigator.onLine) return;
      setFileUploadStatus(entry.evidenceId, entry.fileId, { uploadStatus: "upload_failed" });
    }
  }
}
