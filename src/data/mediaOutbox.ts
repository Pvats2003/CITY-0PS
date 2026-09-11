import { get, set, del, keys } from "idb-keyval";
import { useCity } from "@/store/city";
import { isSupabaseConfigured } from "./supabaseClient";
import { uploadEvidenceFile } from "./mediaStorage";
import { classifyStorageError, clearMediaSyncError, describeStorageErrorForFO, reportMediaSyncError } from "./mediaSyncStatus";

// ---------------------------------------------------------------------------
// Evidence PHOTO BINARY outbox — extends the exact same idb-keyval-backed,
// retry-on-reconnect outbox pattern as data/outbox.ts (same primitives, same
// philosophy: never drop a queued item, never silently fabricate success),
// applied to a different payload: a raw Blob destined for Supabase Storage
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
 * A no-op in demo mode (no Supabase configured): there is no bucket to
 * upload to, so the file stays "local_only" exactly as it always has —
 * no wasted IndexedDB writes, no doomed-to-fail retry loop. */
export async function enqueueMediaUpload(entry: Omit<MediaOutboxEntry, "queuedAt">): Promise<void> {
  if (!isSupabaseConfigured()) return;
  await set(keyFor(entry.evidenceId, entry.fileId), { ...entry, queuedAt: new Date().toISOString() } satisfies MediaOutboxEntry);
  setFileUploadStatus(entry.evidenceId, entry.fileId, { uploadStatus: "uploading" });
  notifyChange();
}

/** Mutates one file within one evidence record in place — the local,
 * synchronous source of truth the FO Cockpit and Manager review UI both
 * read from, independent of whether the Storage upload or the Firestore
 * sync has completed yet. Error fields are only ever set alongside
 * "upload_failed" and are explicitly cleared for every other status, so a
 * retry attempt (or a success) never leaves a stale failure reason
 * visible — omitUndefined()'s central backstop in outbox.ts's enqueue()
 * strips them before this record could ever reach Firestore anyway (it
 * can't while any file is unresolved — see syncEngine.ts's
 * evidenceReadyToSync), but clearing them here keeps local FO/Manager UI
 * honest in the meantime. */
function setFileUploadStatus(
  evidenceId: string,
  fileId: string,
  patch: { uploadStatus: "uploading" | "uploaded" | "upload_failed"; storagePath?: string; downloadUrl?: string; uploadErrorReason?: string; uploadErrorCode?: string },
): void {
  const { evidence, updateEvidence } = useCity.getState();
  const record = evidence.find((e) => e.id === evidenceId);
  if (!record) return; // record was never actually created (defensive; shouldn't happen)
  const files = record.files.map((f) =>
    f.id === fileId
      ? {
          ...f,
          ...patch,
          uploadErrorReason: patch.uploadStatus === "upload_failed" ? patch.uploadErrorReason : undefined,
          uploadErrorCode: patch.uploadStatus === "upload_failed" ? patch.uploadErrorCode : undefined,
        }
      : f,
  );
  updateEvidence(evidenceId, { files });
}

// Same overlapping-drain-calls guard as data/outbox.ts's drainOutbox(), for
// the same reason: Task E's manual "retry" action and the automatic
// `online`/post-enqueue triggers can now realistically overlap (a Manager
// or FO tapping retry right as a background drain from a fresh capture is
// already running). uploadEvidenceFile()'s target path is deterministic
// per file id, so a genuine double-upload was never a correctness bug —
// but avoiding it avoids doubled Storage bandwidth/cost and racy status
// flicker for no benefit.
let draining = false;
let drainQueued = false;

/** Uploads every queued photo to Firebase Storage, in the order first
 * queued. Unlike the Firestore outbox this does not stop at the first
 * failure — one flaky/oversized upload must never block every other
 * queued photo from a different evidence record; every entry is always
 * attempted (see the loop below — nothing in it ever breaks/returns
 * except the genuine-offline case, which stops the whole pass since nothing
 * would succeed anyway). Each entry retries independently; a genuinely
 * offline client just leaves everything queued for the next `online`
 * event, same as data/outbox.ts.
 *
 * On failure, the real Storage error (code + message) is captured via
 * mediaSyncStatus.ts's reportMediaSyncError() — never swallowed — and the
 * queued entry is left exactly where it was (never deleted), so a later
 * call to this same function (the `online` event, a new capture
 * triggering a fresh drain, or Task E's explicit retry action) re-attempts
 * the identical entry: same evidenceId, same fileId, same IndexedDB key,
 * same blob. No new Evidence record and no new media-outbox entry is ever
 * created by a retry — there is nothing in this function that mints an id;
 * it only ever reads keys that already exist. */
export async function drainMediaOutbox(): Promise<void> {
  if (draining) {
    drainQueued = true;
    return;
  }
  draining = true;
  try {
    if (!isSupabaseConfigured() || !navigator.onLine) return;
    const allKeys = (await keys()).filter((k): k is string => typeof k === "string" && k.startsWith(KEY_PREFIX));
    for (const key of allKeys) {
      const entry = (await get(key)) as MediaOutboxEntry | undefined;
      if (!entry) continue;
      setFileUploadStatus(entry.evidenceId, entry.fileId, { uploadStatus: "uploading" });
      try {
        const uploaded = await uploadEvidenceFile({
          // entry.foId is intentionally NOT passed — uploadEvidenceFile()
          // derives the Storage path's ownership segment solely from the
          // currently authenticated Firebase user (see mediaStorage.ts's
          // currentUploaderUid()), never from a caller-supplied value.
          assignmentId: entry.assignmentId,
          evidenceId: entry.evidenceId,
          fileId: entry.fileId,
          fileName: entry.fileName,
          mimeType: entry.mimeType,
          blob: entry.blob,
        });
        await del(key);
        setFileUploadStatus(entry.evidenceId, entry.fileId, { uploadStatus: "uploaded", storagePath: uploaded.storagePath, downloadUrl: uploaded.downloadUrl });
        clearMediaSyncError(entry.evidenceId, entry.fileId);
        notifyChange();
      } catch (err) {
        // Left queued for the next drain (online event, next app start, or
        // the next enqueue elsewhere) — never dropped, never a fabricated
        // success. If connectivity itself dropped mid-loop, stop rather than
        // report every remaining entry with the same transient, non-real
        // error — this is "offline", not a genuine upload failure.
        if (!navigator.onLine) return;
        const { code, technicalMessage } = classifyStorageError(err);
        const humanMessage = describeStorageErrorForFO(code);
        reportMediaSyncError({
          code,
          technicalMessage,
          humanMessage,
          evidenceId: entry.evidenceId,
          fileId: entry.fileId,
          fileName: entry.fileName,
        });
        setFileUploadStatus(entry.evidenceId, entry.fileId, { uploadStatus: "upload_failed", uploadErrorReason: humanMessage, uploadErrorCode: code });
        // Continue to the next queued entry — one bad/flaky upload must
        // never hide every other independent photo behind it.
      }
    }
  } finally {
    draining = false;
    if (drainQueued) {
      drainQueued = false;
      void drainMediaOutbox();
    }
  }
}
