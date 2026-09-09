import { useEffect, useState } from "react";
import { isFirebaseConfigured } from "@/auth/config";
import { hasSyncedOnce, onSyncedCollectionsChange } from "./syncEngine";
import type { CollectionName } from "./backend";

export type CollectionSyncStatus = "not-applicable" | "loading" | "ready";

/** "not-applicable": demo mode (or no test backend either) — data is
 * already local/synchronous, there is nothing remote to wait for.
 * "loading": a real (or test) backend is active and this collection hasn't
 * received its first snapshot yet. "ready": it has, at least once.
 *
 * Lets a page distinguish "genuinely not found" from "still loading" —
 * without this, a lookup against an as-yet-empty collection concludes "not
 * found" the instant a real backend simply hasn't delivered its first
 * snapshot yet, which is exactly what made FOExecution's "FO record not
 * found" reachable even for a correct foId (see syncEngine.ts). */
export function useCollectionSyncStatus(name: CollectionName): CollectionSyncStatus {
  const backendActive = isFirebaseConfigured() || !!window.__CITY_OPS_TEST_BACKEND__;
  const [synced, setSynced] = useState(() => hasSyncedOnce(name));

  useEffect(() => {
    if (!backendActive) return;
    setSynced(hasSyncedOnce(name));
    return onSyncedCollectionsChange(() => setSynced(hasSyncedOnce(name)));
  }, [backendActive, name]);

  if (!backendActive) return "not-applicable";
  return synced ? "ready" : "loading";
}
