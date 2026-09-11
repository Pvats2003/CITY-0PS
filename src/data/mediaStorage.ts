import { getAuth } from "firebase/auth";
import { getFirebaseApp } from "@/auth/firebaseApp";
import { getSupabaseClient } from "./supabaseClient";

// ---------------------------------------------------------------------------
// Supabase Storage adapter for evidence photo binaries. Firebase Auth
// remains the only authentication system and Firestore remains the only
// operational metadata store — this module is the sole place that talks to
// Supabase, and only ever for the raw photo binary itself. Only ever
// imported when a real backend is configured, same rule as
// firebaseBackend.ts.
//
// Firebase Storage is not used in this path. storage.rules/firebase.json's
// storage block are left in the repo, dormant, until this path is proven —
// see this round's implementation report.
// ---------------------------------------------------------------------------

const EVIDENCE_BUCKET = "evidence";

/** How long a signed URL stays valid. Short enough that a leaked URL isn't a
 * standing liability, long enough that a single page view/session never
 * has to worry about it expiring mid-render. Viewers must not persist this
 * indefinitely — see getEvidenceSignedUrl() below, which every display site
 * calls fresh rather than trusting a cached value. */
const SIGNED_URL_TTL_SECONDS = 60 * 60;

/** Deterministic, ownership-scoped Storage path. The FIRST segment is the
 * uploader's Firebase UID — the same identity Supabase Storage RLS checks
 * via auth.jwt()->>'sub' (see the RLS policies in this round's setup
 * checklist) — never the FO's business-domain `foId`, which does not appear
 * in the Firebase ID token and so cannot be verified by Supabase at all.
 * The whole path is stable per file id, so a retried upload overwrites the
 * SAME object instead of creating a duplicate. Exported for tests only —
 * application code should go through uploadEvidenceFile()/
 * getEvidenceSignedUrl(), which are the only callers that need a path. */
export function evidenceStoragePath(uploaderUid: string, assignmentId: string, evidenceId: string, fileId: string, fileName: string): string {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${uploaderUid}/${assignmentId}/${evidenceId}/${fileId}-${safeName}`;
}

/** Resolves the CURRENTLY authenticated Firebase user's uid — this is the
 * only source evidenceStoragePath()'s ownership segment is ever built from.
 * There is deliberately no parameter anywhere in this module that lets a
 * caller supply an arbitrary uid: doing so would let an untrusted caller
 * choose which FO's Storage folder an upload targets, which is exactly what
 * Supabase's RLS policies (path[1] == auth.jwt()->>'sub') exist to prevent.
 * Reading it from the live Firebase Auth session, not from any parameter,
 * means the enforced identity and the requested identity are structurally
 * the same value. */
function currentUploaderUid(): string {
  const uid = getAuth(getFirebaseApp()).currentUser?.uid;
  if (!uid) throw new Error("Not signed in — cannot upload or access evidence photos.");
  return uid;
}

export interface UploadedMedia {
  storagePath: string;
  /** A signed URL valid for SIGNED_URL_TTL_SECONDS from upload time — a
   * convenience for immediate display right after upload, NOT a durable
   * reference. The bucket is private; anything that displays this file
   * later (a reopened app, a different session) must call
   * getEvidenceSignedUrl(storagePath) again rather than trust this value
   * indefinitely — see EvidenceReviewDialog.tsx's EvidenceThumb. */
  downloadUrl: string;
}

/** Uploads one evidence photo's binary to the private `evidence` bucket and
 * resolves once a signed URL is available. `upsert: true` is required for
 * Task E's retry guarantee: a retry after a partial/failed attempt targets
 * the SAME deterministic path, and Supabase treats writing to an existing
 * key as an UPDATE, which needs the same RLS grant as INSERT (see the
 * fo_update_own_evidence policy). foId/assignmentId ownership is otherwise
 * irrelevant here — the object path's ownership segment always comes from
 * currentUploaderUid(), never from a parameter. */
export async function uploadEvidenceFile(params: {
  assignmentId: string;
  evidenceId: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  blob: Blob;
}): Promise<UploadedMedia> {
  const uid = currentUploaderUid();
  const path = evidenceStoragePath(uid, params.assignmentId, params.evidenceId, params.fileId, params.fileName);
  const supabase = getSupabaseClient();

  const { error: uploadError } = await supabase.storage.from(EVIDENCE_BUCKET).upload(path, params.blob, {
    contentType: params.mimeType || "application/octet-stream",
    upsert: true,
  });
  if (uploadError) throw uploadError;

  const downloadUrl = await getEvidenceSignedUrl(path);
  return { storagePath: path, downloadUrl };
}

/** Fetches a FRESH signed URL for an already-uploaded evidence file. The
 * bucket is private, so there is no permanent public URL — every viewer
 * (Manager review dialog, the FO's own later view of their own photo) must
 * call this at display time rather than trust a downloadUrl persisted once
 * at upload time, which will eventually expire. Subject to the same RLS as
 * upload: an FO can only successfully sign a path under their own uid; a
 * Manager (via the public.managers allowlist) can sign any evidence path. */
export async function getEvidenceSignedUrl(storagePath: string, expirySeconds = SIGNED_URL_TTL_SECONDS): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.storage.from(EVIDENCE_BUCKET).createSignedUrl(storagePath, expirySeconds);
  if (error || !data) throw error ?? new Error("Failed to create a signed URL for this evidence photo.");
  return data.signedUrl;
}
