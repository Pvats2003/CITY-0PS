import { useEffect, useState } from "react";
import { isFirebaseConfigured } from "@/auth/config";
import { onOutboxChange, outboxDepth } from "./outbox";

export type SyncStatus = "disabled" | "online" | "offline" | "syncing";

/** Real status only — never a faked "live" indicator (spec section 39).
 * "disabled" means no shared backend is configured at all (demo mode),
 * so there is nothing to report; the FO shell hides the pill entirely then. */
export function useSyncStatus(): { status: SyncStatus; pendingCount: number } {
  const [pending, setPending] = useState(0);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const backendActive = isFirebaseConfigured() || !!window.__CITY_OPS_TEST_BACKEND__;

  useEffect(() => {
    if (!backendActive) return;
    const refresh = () => {
      outboxDepth().then(setPending);
    };
    refresh();
    const unsub = onOutboxChange(refresh);
    const goOnline = () => {
      setIsOnline(true);
      refresh();
    };
    const goOffline = () => setIsOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      unsub();
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [backendActive]);

  if (!backendActive) return { status: "disabled", pendingCount: 0 };
  if (!isOnline) return { status: "offline", pendingCount: pending };
  if (pending > 0) return { status: "syncing", pendingCount: pending };
  return { status: "online", pendingCount: 0 };
}
