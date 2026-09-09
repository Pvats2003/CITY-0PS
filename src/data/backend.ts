import type { CityData } from "@/types";

/** Every array on CityData that is a genuine shared operational collection
 * (settings/version are single documents, handled separately). */
export type CollectionName = Exclude<keyof CityData, "version" | "settings">;

export const COLLECTION_NAMES: CollectionName[] = [
  "businesses",
  "fos",
  "collectors",
  "rigs",
  "assignments",
  "sessions",
  "evidence",
  "issues",
  "qualityReviews",
  "correctiveActions",
  "rigIncidents",
  "repairRecords",
  "activity",
  "plans",
  "reports",
];

/** Backend-agnostic shared-data contract. The sync engine (Phase 6) talks
 * only to this interface — it never knows whether it's Firestore or a
 * local no-op. Every record already carries its own client-generated `id`
 * (see src/lib/id.ts), so puts are naturally idempotent: replaying the same
 * write twice is harmless. */
/** Collections whose firestore.rules grant is ownership-scoped
 * (`resource.data.foId == myFoId()`), not a blanket `isFieldOfficer()`.
 * Firestore denies an unfiltered list/listen against a rule that depends on
 * `resource.data` — it can't prove the condition true for the whole
 * collection without a matching `where` clause in the query itself — so a
 * Field Officer subscribing to one of these MUST filter by their own foId
 * (see firebaseBackend.ts's subscribeCollection). Keep in sync with
 * firestore.rules if any of these grants change shape. */
export const OWNERSHIP_SCOPED_FO_COLLECTIONS: CollectionName[] = ["assignments", "sessions", "issues", "rigIncidents"];

export interface RemoteBackend {
  /** Subscribes to a collection. `cb` fires with the full current document
   * set whenever anything in it changes (Firestore onSnapshot semantics —
   * "near-real-time push", not polling). Returns an unsubscribe function.
   * The local no-op backend never calls `cb`.
   *
   * `scope`, when provided, carries the signed-in Field Officer's own foId
   * — firebaseBackend.ts uses it to add a `where("foId", "==", ...)` clause
   * for OWNERSHIP_SCOPED_FO_COLLECTIONS, which is what makes the listen
   * legal under their rule; every other collection (and every Manager
   * subscription) ignores it. Optional so localBackend and the Playwright
   * test-backend seam need not implement it. */
  subscribeCollection<T extends { id: string }>(
    collection: CollectionName,
    cb: (docs: T[]) => void,
    scope?: { foId: string },
  ): () => void;
  /** Upserts one record. */
  putDoc(collection: CollectionName, id: string, data: Record<string, unknown>): Promise<void>;
  /** Removes one record (used for hard deletes only — most of this app's
   * "removes" are soft, e.g. Issue.status, per spec section 33). */
  deleteDoc(collection: CollectionName, id: string): Promise<void>;
}
