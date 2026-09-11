// ---------------------------------------------------------------------------
// Media (Supabase Storage photo upload) sync-error state — deliberately
// separate from src/data/outbox.ts's collectionSyncErrors. That map tracks
// Firestore DOCUMENT sync failures (a different service, a different error
// surface, `.code` values from a different SDK entirely). Conflating the
// two would let a photo-upload failure show up as (or silently clear) a
// Firestore sync error and vice versa — mirrors the shape of outbox.ts's
// error state (per-key detail map + aggregate "latest" view + a change
// event) without touching or importing anything from it.
// ---------------------------------------------------------------------------

export interface MediaSyncErrorDetail {
  /** Raw Storage error code — "supabase/&lt;status&gt;" (e.g.
   * "supabase/403") for the live Supabase Storage path, "storage/*" for the
   * dormant Firebase Storage path, or "network-error"/"unknown" for a
   * failure that carried no status code at all. Manager/debug visibility
   * only — never render this directly in FO-facing UI; see
   * describeStorageErrorForFO(). */
  code: string;
  /** The raw Storage error message — Manager/debug visibility only. */
  technicalMessage: string;
  /** FO-safe, human-readable translation of `code` — safe to render
   * directly anywhere. */
  humanMessage: string;
  evidenceId: string;
  fileId: string;
  fileName: string;
  /** ISO timestamp of the failed attempt. */
  at: string;
}

const MEDIA_SYNC_CHANGE_EVENT = "city-ops-media-sync-error-change";

function keyFor(evidenceId: string, fileId: string): string {
  return `${evidenceId}:${fileId}`;
}

// Keyed per (evidenceId, fileId) — the same identity mediaOutbox.ts's own
// queue keys by — so one still-failing photo's error can never be
// mistaken for, or silently overwritten by, a different photo's.
const mediaSyncErrors = new Map<string, MediaSyncErrorDetail>();

function notifyChange() {
  window.dispatchEvent(new CustomEvent(MEDIA_SYNC_CHANGE_EVENT));
}

export function onMediaSyncErrorChange(cb: () => void): () => void {
  window.addEventListener(MEDIA_SYNC_CHANGE_EVENT, cb);
  return () => window.removeEventListener(MEDIA_SYNC_CHANGE_EVENT, cb);
}

/** Storage error codes translated into FO-safe language — never the raw
 * technical message or a Storage path. Covers both vocabularies
 * classifyStorageError() below can produce: Supabase Storage's HTTP-
 * status-derived "supabase/NNN" codes (the live production path) and
 * Firebase Storage's "storage/*" codes (kept for parity with the dormant
 * Firebase Storage code and its existing test file — see this round's
 * report). A network/CORS-level failure often carries no status code at
 * all (see classifyStorageError below); "network-error" covers that case
 * with its own message rather than falling into the generic unknown
 * bucket, since "check your connection" is more actionable than "contact
 * your Manager" when the real cause is connectivity. */
export function describeStorageErrorForFO(code: string): string {
  switch (code) {
    case "storage/unauthorized":
    case "storage/unauthenticated":
    case "supabase/401":
    case "supabase/403":
      return "Photo upload isn't authorized. Contact your Manager.";
    case "storage/object-not-found":
    case "supabase/404":
      return "Photo upload service couldn't find the storage location. Contact your Manager.";
    case "storage/bucket-not-found":
    case "storage/project-not-found":
    case "storage/no-default-bucket":
      return "Photo storage isn't available. Contact your Manager.";
    case "supabase/409":
      return "Photo upload conflicted with an existing file. Tap to retry.";
    case "storage/quota-exceeded":
      return "Photo storage is full. Contact your Manager.";
    case "supabase/413":
      return "This photo is too large to upload.";
    case "storage/canceled":
      return "Photo upload was interrupted. Tap to retry.";
    case "storage/retry-limit-exceeded":
    case "network-error":
      return "Photo upload couldn't connect. Check your internet connection and retry.";
    default:
      return "Photo upload failed. Retry or contact your Manager.";
  }
}

/** Extracts a Storage error's code + raw message from whatever
 * uploadEvidenceFile()/getEvidenceSignedUrl() rejected with.
 *
 * Supabase Storage errors (`@supabase/storage-js`'s `StorageApiError`) carry
 * a `.statusCode` (a string like "403") or `.status` (a number) rather than
 * Firebase's `.code` string — classified here as `"supabase/<status>"` so
 * describeStorageErrorForFO() can key on it directly. Firebase's `.code`
 * shape is still checked first and left intact for parity with the dormant
 * Firebase Storage code path and its existing test file. A bare network/
 * CORS failure the browser's fetch layer raised before ever reaching either
 * backend carries neither field, so that case is classified by message
 * content instead of left as a bare "unknown". */
export function classifyStorageError(err: unknown): { code: string; technicalMessage: string } {
  const e = err as { code?: string; statusCode?: string | number; status?: number } | undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (e?.code) return { code: e.code, technicalMessage: message };
  const statusCode = e?.statusCode != null ? String(e.statusCode) : e?.status != null ? String(e.status) : undefined;
  if (statusCode) return { code: `supabase/${statusCode}`, technicalMessage: message };
  if (/network|fetch|cors|failed to fetch/i.test(message)) return { code: "network-error", technicalMessage: message };
  return { code: "unknown", technicalMessage: message };
}

/** Records a real, non-fabricated upload failure for one specific file.
 * Called only from mediaOutbox.ts's drainMediaOutbox() catch block. */
export function reportMediaSyncError(detail: Omit<MediaSyncErrorDetail, "at">): void {
  mediaSyncErrors.set(keyFor(detail.evidenceId, detail.fileId), { ...detail, at: new Date().toISOString() });
  notifyChange();
}

/** Cleared the moment this specific file's upload actually succeeds —
 * never on a mere retry attempt starting (only on real success), so a
 * still-in-flight retry doesn't flash the error away before it's proven
 * fixed. */
export function clearMediaSyncError(evidenceId: string, fileId: string): void {
  if (mediaSyncErrors.delete(keyFor(evidenceId, fileId))) notifyChange();
}

/** Every file currently in a failed state, in one call — diagnostic/
 * Manager surfaces need the full list, not just one example. */
export function getAllMediaSyncErrors(): MediaSyncErrorDetail[] {
  return [...mediaSyncErrors.values()];
}

/** The most recently failed file's error detail, or null if nothing is
 * currently failing — for compact FO/Manager summary banners that only
 * need to show "something's wrong" plus one representative reason. */
export function getLatestMediaSyncError(): MediaSyncErrorDetail | null {
  let latest: MediaSyncErrorDetail | null = null;
  for (const detail of mediaSyncErrors.values()) {
    if (!latest || detail.at > latest.at) latest = detail;
  }
  return latest;
}

export function getMediaSyncErrorCount(): number {
  return mediaSyncErrors.size;
}
