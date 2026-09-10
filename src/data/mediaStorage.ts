import { getStorage, ref, uploadBytesResumable, getDownloadURL } from "firebase/storage";
import { getFirebaseApp } from "@/auth/firebaseApp";

// ---------------------------------------------------------------------------
// Firebase Storage adapter for evidence photo binaries. Reuses the SAME
// Firebase app singleton every other backend module shares (getFirebaseApp())
// — no second Firebase initialization anywhere. Only ever imported when a
// real backend is configured, same rule as firebaseBackend.ts.
// ---------------------------------------------------------------------------

/** Deterministic, ownership-scoped Storage path — the foId segment is what
 * storage.rules checks against the caller's own profile, and the whole path
 * is stable per file id, so re-uploading (a retry) overwrites the SAME
 * object instead of creating a duplicate. Never accepts an arbitrary
 * caller-supplied path; every segment here comes from data this client
 * already owns (its own foId, an assignment/evidence id it created). */
export function evidenceStoragePath(foId: string, assignmentId: string, evidenceId: string, fileId: string, fileName: string): string {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `evidence/${foId}/${assignmentId}/${evidenceId}/${fileId}-${safeName}`;
}

export interface UploadedMedia {
  storagePath: string;
  downloadUrl: string;
}

/** Uploads one evidence photo's binary and resolves once a permanent
 * download URL is available. Uses the resumable upload API (rather than a
 * one-shot uploadBytes) so a large photo on a flaky connection can make
 * partial progress instead of restarting from zero on every retry —
 * storage.rules grants the owning FO an `update` on this exact path for
 * precisely this case. */
export async function uploadEvidenceFile(params: {
  foId: string;
  assignmentId: string;
  evidenceId: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  blob: Blob;
}): Promise<UploadedMedia> {
  const storage = getStorage(getFirebaseApp());
  const path = evidenceStoragePath(params.foId, params.assignmentId, params.evidenceId, params.fileId, params.fileName);
  const objectRef = ref(storage, path);
  const task = uploadBytesResumable(objectRef, params.blob, { contentType: params.mimeType || "application/octet-stream" });

  await new Promise<void>((resolve, reject) => {
    task.on("state_changed", undefined, reject, () => resolve());
  });

  const downloadUrl = await getDownloadURL(task.snapshot.ref);
  return { storagePath: path, downloadUrl };
}
