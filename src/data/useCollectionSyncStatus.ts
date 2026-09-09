import { useEffect, useState } from "react";
import { isFirebaseConfigured } from "@/auth/config";
import { hasSyncedOnce, onSyncedCollectionsChange } from "./syncEngine";
import { getCollectionSyncError, onOutboxChange } from "./outbox";
import type { CollectionName } from "./backend";

export type CollectionSyncPhase = "not-applicable" | "loading" | "ready";

export interface CollectionSyncState {
  /** "not-applicable": demo mode (or no test backend either) — data is
   * already local/synchronous, there is nothing remote to wait for.
   * "loading": a real (or test) backend is active and this collection
   * hasn't received its first snapshot yet. "ready": it has, at least once
   * (independent of whether it currently has an error — see `error`
   * below; a collection that errored after previously syncing is still
   * "ready", just with `error` set). */
  status: CollectionSyncPhase;
  hasSyncedOnce: boolean;
  /** THIS collection's own sync error, or null. Deliberately not the
   * app-wide aggregate (see outbox.ts's getSyncError vs
   * getCollectionSyncError) — a denial on a collection this page doesn't
   * even read must never show up here. */
  error: string | null;
}

/** Lets a page distinguish "genuinely not found" from "still loading" from
 * "this collection specifically has an error" — without this, a lookup
 * against an as-yet-empty collection concludes "not found" the instant a
 * real backend simply hasn't delivered its first snapshot yet, and an
 * error on some OTHER collection could otherwise look identical to an
 * error on this one. See FOExecution.tsx, the first consumer that needed
 * this collection-scoped distinction. */
export function useCollectionSyncStatus(name: CollectionName): CollectionSyncState {
  const backendActive = isFirebaseConfigured() || !!window.__CITY_OPS_TEST_BACKEND__;
  const [synced, setSynced] = useState(() => hasSyncedOnce(name));
  const [error, setError] = useState<string | null>(() => getCollectionSyncError(name));

  useEffect(() => {
    if (!backendActive) return;
    const refresh = () => {
      setSynced(hasSyncedOnce(name));
      setError(getCollectionSyncError(name));
    };
    refresh();
    const unsubSynced = onSyncedCollectionsChange(refresh);
    const unsubError = onOutboxChange(refresh);
    return () => {
      unsubSynced();
      unsubError();
    };
  }, [backendActive, name]);

  if (!backendActive) return { status: "not-applicable", hasSyncedOnce: false, error: null };
  return { status: synced ? "ready" : "loading", hasSyncedOnce: synced, error };
}
