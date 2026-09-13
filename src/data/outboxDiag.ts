import { useCity } from "@/store/city";
import { peekOutboxEntriesForCollection, getCollectionSyncErrorCode } from "./outbox";
import { peekMediaOutboxEntries } from "./mediaOutbox";
import { isEvidenceSyncedOnce } from "./syncEngine";
import { COLLECTION_NAMES, type CollectionName } from "./backend";
import type { Evidence } from "@/types";

/** Production-safe outbox/queue snapshot — investigation tooling only, not a
 * behavior change. Reports exactly what a support engineer needs to
 * diagnose a stuck "N changes waiting to upload" device (collection,
 * document id, WHICH fields are queued, quarantine state, queued-at time,
 * and — for evidence specifically — per-file upload status) without ever
 * exposing the actual field VALUES, auth tokens, or photo/image bytes.
 * Read-only: makes no writes, mutates nothing. */

export interface FirestoreOutboxDiagEntry {
  collection: CollectionName;
  id: string;
  /** Field NAMES only — never the values themselves. `null` means this
   * entry is a delete (tombstone), matching OutboxEntry.data === null. */
  fieldNames: string[] | null;
  isDelete: boolean;
  needsManualReview: boolean;
  queuedAt: string;
  /** The raw Firestore error code last reported for this entry's own
   * collection, if any (see outbox.ts's per-collection error map) — null
   * when this collection has never failed. Not necessarily THIS entry's
   * own failure if multiple entries share a collection, but is the closest
   * signal available without re-attempting the write. */
  collectionErrorCode: string | null;
}

export interface MediaOutboxDiagEntry {
  evidenceId: string;
  fileId: string;
  fileName: string;
  queuedAt: string;
}

export interface EvidenceReadinessDiagEntry {
  id: string;
  type: string;
  assignmentId: string | undefined;
  /** Already durably enqueued to Firestore at least once (see
   * syncEngine.ts's syncedEvidenceOnceIds) — once true, this record will
   * never be re-attempted (evidence is append-only; see firestore.rules). */
  syncedOnce: boolean;
  /** Every file's upload status, without ever including the file's blob,
   * localUrl, or downloadUrl — exactly the fields needed to tell "waiting
   * on its own photo upload" apart from "ready but not yet enqueued" apart
   * from "already synced". */
  files: Array<{ fileId: string; uploadStatus: string | null; uploadErrorCode: string | null }>;
}

export interface OutboxDiagSnapshot {
  firestoreEntries: FirestoreOutboxDiagEntry[];
  mediaEntries: MediaOutboxDiagEntry[];
  /** Only evidence NOT yet synced once — a record already durably enqueued
   * is no longer interesting to this specific "why is this stuck" view. */
  pendingEvidence: EvidenceReadinessDiagEntry[];
}

export async function getOutboxDiagSnapshot(): Promise<OutboxDiagSnapshot> {
  const firestoreEntries: FirestoreOutboxDiagEntry[] = [];
  for (const collection of COLLECTION_NAMES) {
    const entries = await peekOutboxEntriesForCollection(collection);
    for (const entry of entries) {
      firestoreEntries.push({
        collection,
        id: entry.id,
        fieldNames: entry.data === null ? null : Object.keys(entry.data),
        isDelete: entry.data === null,
        needsManualReview: !!entry.needsManualReview,
        queuedAt: entry.queuedAt,
        collectionErrorCode: getCollectionSyncErrorCode(collection),
      });
    }
  }

  const mediaRaw = await peekMediaOutboxEntries();
  const mediaEntries: MediaOutboxDiagEntry[] = mediaRaw.map((e) => ({
    evidenceId: e.evidenceId,
    fileId: e.fileId,
    fileName: e.fileName,
    queuedAt: e.queuedAt,
  }));

  const evidence = useCity.getState().evidence as unknown as Evidence[];
  const pendingEvidence: EvidenceReadinessDiagEntry[] = evidence
    .filter((e) => !isEvidenceSyncedOnce(e.id))
    .map((e) => ({
      id: e.id,
      type: e.type,
      assignmentId: e.assignmentId,
      syncedOnce: false,
      files: e.files.map((f) => ({ fileId: f.id, uploadStatus: f.uploadStatus ?? null, uploadErrorCode: f.uploadErrorCode ?? null })),
    }));

  return { firestoreEntries, mediaEntries, pendingEvidence };
}
