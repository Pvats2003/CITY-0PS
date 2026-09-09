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
export interface RemoteBackend {
  /** Subscribes to a collection. `cb` fires with the full current document
   * set whenever anything in it changes (Firestore onSnapshot semantics —
   * "near-real-time push", not polling). Returns an unsubscribe function.
   * The local no-op backend never calls `cb`. */
  subscribeCollection<T extends { id: string }>(collection: CollectionName, cb: (docs: T[]) => void): () => void;
  /** Upserts one record. */
  putDoc(collection: CollectionName, id: string, data: Record<string, unknown>): Promise<void>;
  /** Removes one record (used for hard deletes only — most of this app's
   * "removes" are soft, e.g. Issue.status, per spec section 33). */
  deleteDoc(collection: CollectionName, id: string): Promise<void>;
}
