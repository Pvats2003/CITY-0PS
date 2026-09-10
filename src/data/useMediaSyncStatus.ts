import { useEffect, useState } from "react";
import { isFirebaseConfigured } from "@/auth/config";
import { onMediaOutboxChange, mediaOutboxDepth, drainMediaOutbox } from "./mediaOutbox";
import { onMediaSyncErrorChange, getLatestMediaSyncError, getMediaSyncErrorCount, type MediaSyncErrorDetail } from "./mediaSyncStatus";

export interface MediaSyncStatus {
  /** Every photo still in the media outbox — queued-not-yet-attempted,
   * currently uploading, or currently failed. Always >= failedCount. */
  pendingCount: number;
  /** The subset of pendingCount currently sitting in a real, captured
   * failure state (see mediaSyncStatus.ts). */
  failedCount: number;
  /** The most recently failed photo's real error detail, or null if
   * nothing is currently failing. */
  latestError: MediaSyncErrorDetail | null;
  /** True when there's at least one failed entry worth retrying. Retrying
   * while offline is harmless (drainMediaOutbox() itself no-ops), so this
   * doesn't also gate on connectivity — the retry action always reflects
   * "is there something to retry", not "will it succeed right now". */
  canRetry: boolean;
  /** Re-attempts every currently-queued media entry, including failed
   * ones — the SAME queued entries (drainMediaOutbox() never mints a new
   * id or a new outbox key), so this can never create a duplicate
   * Evidence record or a duplicate media-outbox entry. Safe to call
   * repeatedly; overlapping calls are serialized by drainMediaOutbox()
   * itself. */
  retry: () => void;
}

/** Media (Firebase Storage photo upload) sync status — deliberately
 * separate from useSyncStatus.ts's Firestore-document-outbox status. A
 * Manager or FO reading "3 changes syncing" has no way to tell whether
 * that's photos or ordinary document writes; this hook is what lets a
 * caller show "3 photos waiting to upload" specifically, and — unlike the
 * general sync pill — a REAL captured error instead of nothing at all. */
export function useMediaSyncStatus(): MediaSyncStatus {
  const [pendingCount, setPendingCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [latestError, setLatestError] = useState<MediaSyncErrorDetail | null>(null);
  const backendActive = isFirebaseConfigured() || !!window.__CITY_OPS_TEST_BACKEND__;

  useEffect(() => {
    if (!backendActive) return;
    const refresh = () => {
      mediaOutboxDepth().then(setPendingCount);
      setFailedCount(getMediaSyncErrorCount());
      setLatestError(getLatestMediaSyncError());
    };
    refresh();
    const unsubOutbox = onMediaOutboxChange(refresh);
    const unsubErrors = onMediaSyncErrorChange(refresh);
    return () => {
      unsubOutbox();
      unsubErrors();
    };
  }, [backendActive]);

  if (!backendActive) return { pendingCount: 0, failedCount: 0, latestError: null, canRetry: false, retry: () => {} };
  return { pendingCount, failedCount, latestError, canRetry: failedCount > 0, retry: () => void drainMediaOutbox() };
}
