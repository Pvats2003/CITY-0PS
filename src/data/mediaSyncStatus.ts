// ---------------------------------------------------------------------------
// Media (Firebase Storage photo upload) sync-error state — deliberately
// separate from src/data/outbox.ts's collectionSyncErrors. That map tracks
// Firestore DOCUMENT sync failures (a different service, a different error
// surface, `.code` values from a different SDK entirely). Conflating the
// two would let a photo-upload failure show up as (or silently clear) a
// Firestore sync error and vice versa — mirrors the shape of outbox.ts's
// error state (per-key detail map + aggregate "latest" view + a change
// event) without touching or importing anything from it.
// ---------------------------------------------------------------------------

export interface MediaSyncErrorDetail {
  /** Raw Firebase Storage error code (e.g. "storage/unauthorized") — or
   * "network-error"/"unknown" for a failure the SDK didn't attribute a
   * Storage-specific code to. Manager/debug visibility only — never render
   * this directly in FO-facing UI; see describeStorageErrorForFO(). */
  code: string;
  /** The raw Firebase error message — Manager/debug visibility only. */
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

/** Firebase Storage's own documented error codes
 * (https://firebase.google.com/docs/storage/web/handle-errors), translated
 * into FO-safe language — never the raw Firebase message or a Storage
 * path. A network/CORS-level failure often carries no Storage-specific
 * `.code` at all (see classifyStorageError below); "network-error" covers
 * that case with its own message rather than falling into the generic
 * unknown bucket, since "check your connection" is more actionable than
 * "contact your Manager" when the real cause is connectivity. */
export function describeStorageErrorForFO(code: string): string {
  switch (code) {
    case "storage/unauthorized":
    case "storage/unauthenticated":
      return "Photo upload isn't authorized. Contact your Manager.";
    case "storage/object-not-found":
      return "Photo upload service couldn't find the storage location. Contact your Manager.";
    case "storage/bucket-not-found":
    case "storage/project-not-found":
    case "storage/no-default-bucket":
      return "Photo storage isn't available. Contact your Manager.";
    case "storage/quota-exceeded":
      return "Photo storage is full. Contact your Manager.";
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
 * uploadBytesResumable()/getDownloadURL() rejected with. Firebase Storage
 * errors are FirebaseError instances with a `.code` for anything the
 * server itself rejected (auth, rules, missing bucket, ...); a bare
 * network/CORS failure the browser's fetch layer raised before ever
 * reaching Firebase often has no such code, so that case is classified by
 * message content instead of left as a bare "unknown". */
export function classifyStorageError(err: unknown): { code: string; technicalMessage: string } {
  const code = (err as { code?: string } | undefined)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code) return { code, technicalMessage: message };
  if (/network|fetch|cors/i.test(message)) return { code: "network-error", technicalMessage: message };
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
