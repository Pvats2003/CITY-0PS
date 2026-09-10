import { useEffect, useState } from "react";
import { isFirebaseConfigured } from "@/auth/config";
import { onOutboxChange, outboxDepth, getSyncError } from "./outbox";
import { onMediaOutboxChange, mediaOutboxDepth } from "./mediaOutbox";

export type SyncStatus = "disabled" | "online" | "offline" | "syncing" | "error";

/** Real status only — never a faked "live" indicator (spec section 39).
 * "disabled" means no shared backend is configured at all (demo mode),
 * so there is nothing to report; the FO shell hides the pill entirely then.
 * "error" means a write was genuinely rejected while online (permission
 * denied, backend unavailable) — never silently swallowed as success.
 * pendingCount combines the Firestore outbox (documents) with the media
 * outbox (photo binaries) — an evidence record can be waiting purely on
 * its own photo upload before it's even eligible to reach the Firestore
 * outbox at all (see syncEngine.ts), so counting only the document queue
 * would under-report "syncing" while a photo is still uploading. */
export function useSyncStatus(): { status: SyncStatus; pendingCount: number; errorMessage: string | null } {
  const [docPending, setPending] = useState(0);
  const [mediaPending, setMediaPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const backendActive = isFirebaseConfigured() || !!window.__CITY_OPS_TEST_BACKEND__;

  useEffect(() => {
    if (!backendActive) return;
    const refresh = () => {
      outboxDepth().then(setPending);
      mediaOutboxDepth().then(setMediaPending);
      setError(getSyncError());
    };
    refresh();
    const unsub = onOutboxChange(refresh);
    const unsubMedia = onMediaOutboxChange(refresh);
    const goOnline = () => {
      setIsOnline(true);
      refresh();
    };
    const goOffline = () => setIsOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      unsub();
      unsubMedia();
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [backendActive]);

  const pending = docPending + mediaPending;

  if (!backendActive) return { status: "disabled", pendingCount: 0, errorMessage: null };
  if (!isOnline) return { status: "offline", pendingCount: pending, errorMessage: null };
  if (error) return { status: "error", pendingCount: pending, errorMessage: error };
  if (pending > 0) return { status: "syncing", pendingCount: pending, errorMessage: null };
  return { status: "online", pendingCount: 0, errorMessage: null };
}
