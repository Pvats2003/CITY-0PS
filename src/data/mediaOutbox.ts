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

/** Bound on a single upload ATTEMPT (see withUploadTimeout() below) — not on
 * the whole drain pass, and not a retry-count limit. Chosen as a generous
 * allowance for a genuinely slow mobile upload while still being short
 * enough that a request that will truly never resolve (round 4c's confirmed
 * production root cause — no timeout anywhere in this path previously)
 * doesn't block this device's entire media queue, including completely
 * unrelated evidence, indefinitely. Overridable only by the test-only
 * __CITY_OPS_TEST_UPLOAD_TIMEOUT_MS__ seam below — production always uses
 * this exact value. */
const UPLOAD_TIMEOUT_MS = 30_000;

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

/** Read-only diagnostic seam — every currently-queued media outbox entry,
 * for outboxDiag.ts's production-safe queue snapshot. Never returns the raw
 * `blob` field itself (see MediaOutboxEntry) to the caller's rendered
 * output — callers must destructure only the metadata fields they need.
 * Makes no writes, mutates nothing. */
export async function peekMediaOutboxEntries(): Promise<MediaOutboxEntry[]> {
  const allKeys = (await keys()).filter((k): k is string => typeof k === "string" && k.startsWith(KEY_PREFIX));
  const entries: MediaOutboxEntry[] = [];
  for (const key of allKeys) {
    const entry = (await get(key)) as MediaOutboxEntry | undefined;
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Persists the raw file into IndexedDB immediately — durable the instant
 * this resolves, surviving a refresh or full browser restart even if the
 * upload itself hasn't started yet. Marks the file "uploading" locally so
 * the FO sees a pending-upload state right away.
 *
 * A no-op in demo mode (no Supabase configured): there is no bucket to
 * upload to, so the file stays "local_only" exactly as it always has —
 * no wasted IndexedDB writes, no doomed-to-fail retry loop. Also proceeds
 * when the test-only __CITY_OPS_TEST_UPLOAD_EVIDENCE_FILE__ seam is present
 * (see below), so Playwright can exercise this real queue/concurrency logic
 * without a live Supabase project. */
export async function enqueueMediaUpload(entry: Omit<MediaOutboxEntry, "queuedAt">): Promise<void> {
  if (!isSupabaseConfigured() && !window.__CITY_OPS_TEST_UPLOAD_EVIDENCE_FILE__) return;
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

declare global {
  interface Window {
    /** Test-only seam (mirrors __CITY_OPS_TEST_SET_FOS_DIAG__/
     * __CITY_OPS_TEST_BACKEND__) — lets Playwright simulate a queued photo's
     * Supabase upload finishing without a real Supabase project (never
     * configured in the test environment — see isSupabaseConfigured()), by
     * driving the exact same store mutation this file performs internally
     * once uploadEvidenceFile() actually resolves. Inert for real users. */
    __CITY_OPS_TEST_SET_FILE_UPLOAD_STATUS__?: typeof setFileUploadStatus;
    /** Test-only seam (mirrors __CITY_OPS_TEST_BACKEND__) — when present,
     * drainMediaOutbox() calls THIS instead of the real uploadEvidenceFile()
     * (mediaStorage.ts), and enqueueMediaUpload() treats it the same as
     * Supabase being configured. Lets Playwright exercise the REAL
     * concurrency/queue/retry logic in this file (multiple simultaneous
     * uploads, a delayed one, a failed one) deterministically, without a
     * live Supabase project or real Firebase Auth session — neither of
     * which exist in this test environment. Inert for real users: nothing
     * in the shipped app ever sets this. */
    __CITY_OPS_TEST_UPLOAD_EVIDENCE_FILE__?: typeof uploadEvidenceFile;
    /** Test-only seam — overrides UPLOAD_TIMEOUT_MS for withUploadTimeout()
     * below, so Playwright can prove the timeout behavior without a real
     * 30-second wait. Never set by the shipped app; production always uses
     * the real UPLOAD_TIMEOUT_MS regardless of whether this key exists on
     * `window` (a real user's browser never sets it). */
    __CITY_OPS_TEST_UPLOAD_TIMEOUT_MS__?: number;
  }
}

if (typeof window !== "undefined") {
  window.__CITY_OPS_TEST_SET_FILE_UPLOAD_STATUS__ = setFileUploadStatus;
}

/** Bounds one upload attempt so a request that never settles (no timeout
 * exists anywhere in the underlying fetch()/Supabase storage-js call chain)
 * can't stall this function's caller — and therefore this device's entire
 * sequential media-outbox drain, including completely unrelated evidence —
 * forever. Confirmed production root cause, round 4c.
 *
 * On timeout, rejects with a distinct, machine-readable `.code ===
 * "upload-timeout"` (see mediaSyncStatus.ts's classifyStorageError(), which
 * already forwards any `err.code` verbatim) so it flows through the EXACT
 * SAME error path as a genuine Storage rejection below — recorded via
 * reportMediaSyncError(), marked upload_failed (never silently "uploaded",
 * never deleted from the outbox), and retryable exactly like any other
 * failure. No new error/status architecture is introduced.
 *
 * The original `promise` is never abandoned: if it wins the race normally
 * this is a no-op wrapper; if the timeout wins first, a trailing `.catch()`
 * is still attached so a LATE rejection from the original upload can never
 * surface as an unhandled promise rejection, and the pending timer is
 * always cleared via `finally` regardless of which side wins. */
function withUploadTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  promise.catch(() => {
    // Intentionally swallowed — see doc comment above. The real outcome
    // (success or failure) was already decided by whichever side of the
    // race below settled first; this only exists to prevent an unhandled
    // rejection if `promise` loses the race and then rejects later.
  });
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error("Photo upload timed out.");
      (err as Error & { code: string }).code = "upload-timeout";
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
    if ((!isSupabaseConfigured() && !window.__CITY_OPS_TEST_UPLOAD_EVIDENCE_FILE__) || !navigator.onLine) return;
    const allKeys = (await keys()).filter((k): k is string => typeof k === "string" && k.startsWith(KEY_PREFIX));
    for (const key of allKeys) {
      const entry = (await get(key)) as MediaOutboxEntry | undefined;
      if (!entry) continue;
      setFileUploadStatus(entry.evidenceId, entry.fileId, { uploadStatus: "uploading" });
      try {
        const upload = window.__CITY_OPS_TEST_UPLOAD_EVIDENCE_FILE__ ?? uploadEvidenceFile;
        const timeoutMs = window.__CITY_OPS_TEST_UPLOAD_TIMEOUT_MS__ ?? UPLOAD_TIMEOUT_MS;
        const uploaded = await withUploadTimeout(
          upload({
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
          }),
          timeoutMs,
        );
        // Local "uploaded" status (with its real storagePath) is written
        // FIRST, and only then is the outbox entry removed. If the process
        // is interrupted between these two statements (reload, background,
        // crash), the outbox entry is still present on the next drain: the
        // upload is safely re-attempted (uploadEvidenceFile()'s target path
        // is deterministic per evidenceId/fileId and Supabase upload uses
        // upsert:true — see mediaStorage.ts — so a redundant re-upload just
        // overwrites the same object, it never creates a duplicate). The
        // reverse ordering (del() first) is exactly the bug that produced a
        // real-world orphan: an uploaded Supabase object with no local
        // record left to ever notify the Firestore sync watcher about it,
        // because the one durable trace of that upload (the outbox entry)
        // was already gone before the "uploaded" status was ever written.
        setFileUploadStatus(entry.evidenceId, entry.fileId, { uploadStatus: "uploaded", storagePath: uploaded.storagePath, downloadUrl: uploaded.downloadUrl });
        await del(key);
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
