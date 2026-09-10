import { useEffect, useState } from "react";
import { isFirebaseConfigured } from "@/auth/config";
import { hasSyncedOnce, onSyncedCollectionsChange, FIELD_OFFICER_COLLECTIONS } from "./syncEngine";
import { getCollectionSyncError, getCollectionSyncErrorCode, onOutboxChange } from "./outbox";
import type { CollectionName } from "./backend";

export type FoCollectionSyncStatus = "success" | "error" | "pending";

export interface FoCollectionSyncEntry {
  collection: CollectionName;
  status: FoCollectionSyncStatus;
  errorCode: string | null;
  errorMessage: string | null;
}

/** Every collection a signed-in Field Officer subscribes to, each with its
 * own current status — built entirely from the SAME per-collection state
 * useCollectionSyncStatus already reads one collection at a time
 * (syncEngine's hasSyncedOnce/onSyncedCollectionsChange, outbox's
 * getCollectionSyncError(Code)/onOutboxChange). No second sync system, no
 * new state: this just enumerates FIELD_OFFICER_COLLECTIONS and reads the
 * existing per-collection state for each one, so a diagnostic surface can
 * show every collection at once — including the ones that ARE working,
 * never just the failing ones. */
export function useAllFoSyncStatus(): FoCollectionSyncEntry[] {
  const backendActive = isFirebaseConfigured() || !!window.__CITY_OPS_TEST_BACKEND__;
  const [, forceRefresh] = useState(0);

  useEffect(() => {
    if (!backendActive) return;
    const refresh = () => forceRefresh((n) => n + 1);
    const unsubSynced = onSyncedCollectionsChange(refresh);
    const unsubError = onOutboxChange(refresh);
    return () => {
      unsubSynced();
      unsubError();
    };
  }, [backendActive]);

  if (!backendActive) return [];

  return FIELD_OFFICER_COLLECTIONS.map((collection) => {
    const errorMessage = getCollectionSyncError(collection);
    const errorCode = getCollectionSyncErrorCode(collection);
    const status: FoCollectionSyncStatus = errorMessage ? "error" : hasSyncedOnce(collection) ? "success" : "pending";
    return { collection, status, errorCode, errorMessage };
  });
}
