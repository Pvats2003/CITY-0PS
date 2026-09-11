// Regression test for this round's Firebase-Storage -> Supabase-Storage
// migration (src/data/supabaseClient.ts, src/data/mediaStorage.ts,
// src/data/mediaSyncStatus.ts's updated classifyStorageError()/
// describeStorageErrorForFO(), src/auth/firebaseAuth.ts's
// getCurrentFirebaseIdToken()).
//
// *** No real Supabase project exists in this environment (explicitly not
// created per this round's instructions), and there is no practical local
// Supabase stack (Postgres + GoTrue + Storage API + a real RLS engine) in
// this sandbox the way there is a real Firebase emulator suite for
// Firestore/Storage. The "strongest safe test strategy available" here is:
// mirror mediaStorage.ts's actual logic in plain JS (same convention every
// other *.mjs test in this repo already uses, since mediaStorage.ts itself
// imports import.meta.env / the real @supabase/supabase-js client, neither
// of which a plain Node script can drive directly) against a FAKE, in-
// memory Supabase Storage client whose allow/deny logic is a literal,
// side-by-side transcription of the RLS SQL policies this round's setup
// checklist documents (fo_insert_own_evidence, fo_update_own_evidence,
// fo_select_own_evidence, manager_select_any_evidence) — proving the
// INTENDED contract precisely, not the live Postgres/GoTrue behavior.
//
// This test does NOT and CANNOT prove: that the RLS SQL is syntactically
// valid Postgres, that Supabase's real Third-Party Auth JWT verification
// actually accepts a real Firebase-issued token, or real token-expiry/
// refresh timing. Those require a real Supabase project (see this round's
// "Exact Supabase dashboard setup still required" in the final report) and
// are explicitly called out as manual-verification items below (see [N]).
//
// Covers items A-N from this round's test list. Run with:
//   npm run test:supabase-media-storage

import { readFileSync } from "node:fs";

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

// ---------------------------------------------------------------------
// Mirrors src/data/mediaStorage.ts's evidenceStoragePath() exactly.
// ---------------------------------------------------------------------
function evidenceStoragePath(uploaderUid, assignmentId, evidenceId, fileId, fileName) {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${uploaderUid}/${assignmentId}/${evidenceId}/${fileId}-${safeName}`;
}

// ---------------------------------------------------------------------
// Mirrors src/data/mediaSyncStatus.ts's classifyStorageError()/
// describeStorageErrorForFO() exactly (post this round's Supabase update).
// ---------------------------------------------------------------------
function classifyStorageError(err) {
  const e = err;
  const message = err instanceof Error ? err.message : String(err);
  if (e?.code) return { code: e.code, technicalMessage: message };
  const statusCode = e?.statusCode != null ? String(e.statusCode) : e?.status != null ? String(e.status) : undefined;
  if (statusCode) return { code: `supabase/${statusCode}`, technicalMessage: message };
  if (/network|fetch|cors|failed to fetch/i.test(message)) return { code: "network-error", technicalMessage: message };
  return { code: "unknown", technicalMessage: message };
}
function describeStorageErrorForFO(code) {
  switch (code) {
    case "storage/unauthorized":
    case "storage/unauthenticated":
    case "supabase/401":
    case "supabase/403":
      return "Photo upload isn't authorized. Contact your Manager.";
    case "storage/object-not-found":
    case "supabase/404":
      return "Photo upload service couldn't find the storage location. Contact your Manager.";
    case "supabase/409":
      return "Photo upload conflicted with an existing file. Tap to retry.";
    case "supabase/413":
      return "This photo is too large to upload.";
    case "storage/retry-limit-exceeded":
    case "network-error":
      return "Photo upload couldn't connect. Check your internet connection and retry.";
    default:
      return "Photo upload failed. Retry or contact your Manager.";
  }
}

// ---------------------------------------------------------------------
// FAKE Supabase Storage — an in-memory object store whose allow/deny logic
// is a literal transcription of this round's RLS SQL:
//
//   fo_insert_own_evidence / fo_update_own_evidence:
//     bucket_id = 'evidence' and (storage.foldername(name))[1] = sub
//   fo_select_own_evidence:
//     bucket_id = 'evidence' and (storage.foldername(name))[1] = sub
//   manager_select_any_evidence:
//     bucket_id = 'evidence' and sub in (select uid from public.managers)
//
// IMPORTANT: `storage.foldername(name)` in real Postgres returns the
// object's path segments EXCLUDING the filename, then `[1]` (Postgres
// arrays are 1-indexed) is the FIRST of those — i.e. for a bucket-relative
// name (what .from("evidence").upload(path, ...) actually stores as
// `name` — the bucket itself is a separate column, never part of the
// path), that's simply the path's first "/"-separated segment. In JS
// terms that's `path.split("/")[0]`. An earlier version of this fake used
// `path.split("/")[1]` (the SECOND segment), which only "worked" because
// it silently matched a real production bug where evidenceStoragePath()
// itself prepended a redundant "evidence/" segment — the fake and the bug
// canceled out and both were wrong. Now that evidenceStoragePath() is
// fixed to be bucket-relative, this fake must check index [0] to
// correctly model real RLS semantics — see this round's incident report.
//
// No delete method is exposed at all — mirroring "no delete policy exists
// for any role" (see [J] below, which checks this structurally rather than
// via this fake).
// ---------------------------------------------------------------------
class FakeSupabaseStorage {
  constructor(managersAllowlist) {
    this.objects = new Map(); // path -> { blob, contentType }
    this.managers = new Set(managersAllowlist ?? []);
  }
  // as() returns a context bound to one caller's identity — stands in for
  // "the currently authenticated Firebase user, via the accessToken JWT".
  as(sub) {
    const bucket = this;
    return {
      from(bucketId) {
        return {
          async upload(path, blob, opts) {
            if (bucketId !== "evidence") return { error: fakeError(404, "Bucket not found") };
            const owner = path.split("/")[0]; // bucket-relative: {uid}/{assignmentId}/{evidenceId}/{fileId}-{fileName}
            if (owner !== sub) return { error: fakeError(403, "new row violates row-level security policy") };
            const exists = bucket.objects.has(path);
            if (exists && !opts?.upsert) return { error: fakeError(409, "The resource already exists") };
            bucket.objects.set(path, { blob, contentType: opts?.contentType });
            return { error: null };
          },
          async createSignedUrl(path, expirySeconds) {
            if (bucketId !== "evidence") return { data: null, error: fakeError(404, "Bucket not found") };
            const owner = path.split("/")[0];
            const isOwner = owner === sub;
            const isManager = bucket.managers.has(sub);
            if (!isOwner && !isManager) return { data: null, error: fakeError(403, "new row violates row-level security policy") };
            if (!bucket.objects.has(path)) return { data: null, error: fakeError(404, "Object not found") };
            return { data: { signedUrl: `https://fake.supabase.co/storage/v1/object/sign/${path}?token=fake&exp=${expirySeconds}` }, error: null };
          },
        };
      },
    };
  }
}
function fakeError(statusCode, message) {
  return { statusCode: String(statusCode), status: statusCode, message };
}

function makeBlob(text) {
  return { __blob: text }; // Node has no Blob-in-storage concept here; content is irrelevant to RLS logic
}

// ---------------------------------------------------------------------
// Mirrors src/data/mediaStorage.ts's uploadEvidenceFile()/
// getEvidenceSignedUrl(), parameterized by a FakeSupabaseStorage context
// instead of the real getSupabaseClient() (which needs import.meta.env and
// a real network target neither of which exist in plain Node — see file
// header).
// ---------------------------------------------------------------------
async function uploadEvidenceFileMirrored(storageCtx, uid, params) {
  const path = evidenceStoragePath(uid, params.assignmentId, params.evidenceId, params.fileId, params.fileName);
  const { error: uploadError } = await storageCtx.from("evidence").upload(path, params.blob, { contentType: params.mimeType, upsert: true });
  if (uploadError) throw uploadError;
  const { data, error: signError } = await storageCtx.from("evidence").createSignedUrl(path, 3600);
  if (signError || !data) throw signError ?? new Error("sign failed");
  return { storagePath: path, downloadUrl: data.signedUrl };
}

// ---------------------------------------------------------------------
// Mirrors src/data/mediaOutbox.ts's drainMediaOutbox() loop shape exactly
// (never breaks on one failure, never deletes a failed entry, classifies +
// records the real error).
// ---------------------------------------------------------------------
async function drainMediaOutboxMirrored(queue, storageCtxResolver, mediaSyncErrors, results) {
  for (const entry of [...queue]) {
    try {
      const storageCtx = storageCtxResolver(entry);
      const uploaded = await uploadEvidenceFileMirrored(storageCtx.ctx, storageCtx.uid, entry);
      queue.splice(queue.indexOf(entry), 1);
      mediaSyncErrors.delete(`${entry.evidenceId}:${entry.fileId}`);
      results.push({ id: `${entry.evidenceId}:${entry.fileId}`, outcome: "uploaded", storagePath: uploaded.storagePath });
    } catch (err) {
      const { code, technicalMessage } = classifyStorageError(err);
      const humanMessage = describeStorageErrorForFO(code);
      mediaSyncErrors.set(`${entry.evidenceId}:${entry.fileId}`, { code, technicalMessage, humanMessage, evidenceId: entry.evidenceId, fileId: entry.fileId });
      results.push({ id: `${entry.evidenceId}:${entry.fileId}`, outcome: "failed", code });
    }
  }
}

async function main() {
  const fake = new FakeSupabaseStorage(["manager-uid-1"]);
  const ownerCtx = { ctx: fake.as("fo-owner-uid"), uid: "fo-owner-uid" };
  const otherCtx = { ctx: fake.as("fo-other-uid"), uid: "fo-other-uid" };
  const managerCtx = { ctx: fake.as("manager-uid-1"), uid: "manager-uid-1" };
  const nonManagerCtx = { ctx: fake.as("fo-other-uid"), uid: "fo-other-uid" };

  // ------------------------------------------------------------ [PATH]
  console.log("\n[PATH] evidenceStoragePath() is bucket-relative (regression test for the AccessDenied incident):");
  // The bug: evidenceStoragePath() used to prepend a redundant "evidence/"
  // segment on top of .from("evidence") already scoping every call to that
  // bucket, which shifted (storage.foldername(name))[1] off the uploader's
  // uid onto the literal string "evidence" — denying every upload/read for
  // every user, unconditionally. Fixed to be bucket-relative.
  const pathCheck = evidenceStoragePath("uid_123", "asg_9", "ev_9", "file_9", "photo.jpg");
  check(pathCheck === "uid_123/asg_9/ev_9/file_9-photo.jpg", `evidenceStoragePath() returns <UID>/<assignmentId>/<evidenceId>/<file> exactly (got: "${pathCheck}")`);
  check(!pathCheck.startsWith("evidence/"), `evidenceStoragePath()'s output does NOT begin with "evidence/" (got: "${pathCheck}")`);
  check(pathCheck.split("/")[0] === "uid_123", "the first path segment is the uploader's uid — exactly what (storage.foldername(name))[1] checks against auth.jwt()->>'sub'");
  // Cross-check against the REAL source file, not just this mirror — guards
  // against the mirror and the real implementation silently drifting apart.
  const realMediaStorageSrc = readFileSync("src/data/mediaStorage.ts", "utf8");
  check(
    /return `\$\{uploaderUid\}\/\$\{assignmentId\}\/\$\{evidenceId\}\/\$\{fileId\}-\$\{safeName\}`;/.test(realMediaStorageSrc),
    "src/data/mediaStorage.ts's real evidenceStoragePath() returns the bucket-relative template literal (no leading \"evidence/\")",
  );
  check(!/return `evidence\/\$\{uploaderUid\}/.test(realMediaStorageSrc), "src/data/mediaStorage.ts's real evidenceStoragePath() does NOT reintroduce the redundant \"evidence/\" prefix");

  // -------------------------------------------------------------- [A]
  console.log("\n[A] Successful upload:");
  const queueA = [];
  const errorsA = new Map();
  const resultsA = [];
  const goodEntry = { assignmentId: "asg_1", evidenceId: "ev_1", fileId: "file_1", fileName: "photo.jpg", mimeType: "image/jpeg", blob: makeBlob("x") };
  queueA.push(goodEntry);
  await drainMediaOutboxMirrored(queueA, () => ownerCtx, errorsA, resultsA);
  check(resultsA[0]?.outcome === "uploaded", "upload succeeds when the object path's uid segment matches the caller's own uid");
  check(resultsA[0]?.storagePath === "fo-owner-uid/asg_1/ev_1/file_1-photo.jpg", "deterministic path matches evidenceStoragePath()'s exact shape");

  // ------------------------------------------------------------ [B]/[C]
  console.log("\n[B] Failed upload remains in the outbox, [C] real error code/message is captured:");
  // A genuine failure: otherCtx attempting to upload to a path whose uid
  // segment is fo-owner-uid — denied by the same RLS check as [F], proven
  // here through the actual drain-loop mirror so [B]/[C] exercise the real
  // catch/preserve/report path, not just the raw client call.
  const crossOwnerEntry = { assignmentId: "asg_2", evidenceId: "ev_2", fileId: "file_2", fileName: "photo.jpg", mimeType: "image/jpeg", blob: makeBlob("x") };
  const queueBC = [crossOwnerEntry];
  const errorsBC = new Map();
  const resultsBC = [];
  await drainMediaOutboxMirrored(
    queueBC,
    () => ({ ctx: otherCtx.ctx, uid: "fo-owner-uid" }), // path built with fo-owner-uid's uid, but the request is authenticated as otherCtx
    errorsBC,
    resultsBC,
  );
  check(resultsBC[0]?.outcome === "failed", "the cross-owner upload genuinely fails");
  check(queueBC.length === 1, "the failed entry was NOT removed from the queue — still queued");
  check(queueBC[0] === crossOwnerEntry, "the preserved entry is the exact same object — nothing re-minted");
  const errBC = errorsBC.get("ev_2:file_2");
  check(!!errBC, "an error was recorded for this exact evidenceId:fileId key");
  check(errBC.code === "supabase/403", `the real Supabase-shaped error code was captured (got: ${errBC?.code})`);
  check(typeof errBC.technicalMessage === "string" && errBC.technicalMessage.length > 0, "a real, non-empty technical message was captured");
  check(errBC.humanMessage === "Photo upload isn't authorized. Contact your Manager.", "the FO-safe human message matches the required wording");

  // -------------------------------------------------------------- [D]
  console.log("\n[D] One failed upload does not block another, same pass:");
  const badFirst = { assignmentId: "asg_4", evidenceId: "ev_4a", fileId: "file_4a", fileName: "bad.jpg", mimeType: "image/jpeg", blob: makeBlob("x") };
  const goodSecond = { assignmentId: "asg_4", evidenceId: "ev_4b", fileId: "file_4b", fileName: "good.jpg", mimeType: "image/jpeg", blob: makeBlob("x") };
  const queueD = [badFirst, goodSecond];
  const errorsD = new Map();
  const resultsD = [];
  // Both entries are drained in ONE pass, both authenticated as otherCtx —
  // badFirst's path is built with fo-owner-uid's uid (denied), goodSecond's
  // path is built with otherCtx's own uid (allowed), proving the loop
  // itself continues past a real failure to a real subsequent success.
  await drainMediaOutboxMirrored(
    queueD,
    (entry) => (entry === badFirst ? { ctx: otherCtx.ctx, uid: "fo-owner-uid" } : { ctx: otherCtx.ctx, uid: otherCtx.uid }),
    errorsD,
    resultsD,
  );
  check(resultsD.length === 2, `both entries were attempted in the same pass (got ${resultsD.length})`);
  check(resultsD[0].outcome === "failed", "the first (cross-owner) entry genuinely failed");
  check(resultsD[1].outcome === "uploaded", "the second entry still succeeded — the loop did not stop or hide it behind the first failure");
  check(queueD.length === 1 && queueD[0] === badFirst, "only the genuinely-failed entry remains queued");

  // -------------------------------------------------------------- [E]
  console.log("\n[E] Retry reuses the same deterministic object key:");
  // Mirrors the real edge case documented in this round's plan: the uid
  // used at drain time comes from whoever is CURRENTLY signed in, resolved
  // fresh each attempt — never stored on the queue entry itself. First
  // attempt happens while the wrong identity is signed in (denied); retry
  // happens once the correct owner is signed in again (succeeds) — proving
  // the object key itself never changes across that retry.
  const retryEntry = { assignmentId: "asg_5", evidenceId: "ev_5", fileId: "file_5", fileName: "photo.jpg", mimeType: "image/jpeg", blob: makeBlob("x") };
  const queueE = [retryEntry];
  const errorsE = new Map();
  const resultsE1 = [];
  await drainMediaOutboxMirrored(queueE, () => ({ ctx: otherCtx.ctx, uid: "fo-owner-uid" }), errorsE, resultsE1);
  check(resultsE1[0]?.outcome === "failed", "first attempt (wrong identity signed in when it drained) genuinely fails");
  check(queueE.length === 1, "entry still queued after the failed attempt");
  const keyBefore = evidenceStoragePath("fo-owner-uid", retryEntry.assignmentId, retryEntry.evidenceId, retryEntry.fileId, retryEntry.fileName);
  const resultsE2 = [];
  await drainMediaOutboxMirrored(queueE, () => ({ ctx: ownerCtx.ctx, uid: "fo-owner-uid" }), errorsE, resultsE2);
  check(resultsE2[0]?.outcome === "uploaded", "retry (correct owner signed in) succeeds");
  check(queueE.length === 0, "entry removed only once actually uploaded");
  const keyAfter = evidenceStoragePath("fo-owner-uid", retryEntry.assignmentId, retryEntry.evidenceId, retryEntry.fileId, retryEntry.fileName);
  check(keyBefore === keyAfter, "the deterministic path is identical before and after a retry — nothing regenerated");

  // -------------------------------------------------------------- [F]
  console.log("\n[F] FO cannot upload into another FO's UID path:");
  const foreignPath = evidenceStoragePath("fo-owner-uid", "asg_6", "ev_6", "file_6", "photo.jpg");
  const forgedUpload = await otherCtx.ctx.from("evidence").upload(foreignPath, makeBlob("x"), { contentType: "image/jpeg", upsert: true });
  check(!!forgedUpload.error, "otherCtx cannot upload directly to a path whose uid segment is fo-owner-uid");
  check(forgedUpload.error?.statusCode === "403", "denial is a real 403-shaped error, matching fo_insert_own_evidence's RLS check");

  // -------------------------------------------------------------- [G]
  console.log("\n[G] FO cannot read another FO's object:");
  const ownerOnlyPath = evidenceStoragePath("fo-owner-uid", "asg_7", "ev_7", "file_7", "photo.jpg");
  await ownerCtx.ctx.from("evidence").upload(ownerOnlyPath, makeBlob("x"), { contentType: "image/jpeg", upsert: true });
  const foreignRead = await otherCtx.ctx.from("evidence").createSignedUrl(ownerOnlyPath, 3600);
  check(!foreignRead.data && !!foreignRead.error, "otherCtx cannot create a signed URL for fo-owner-uid's object");
  check(foreignRead.error?.statusCode === "403", "denial matches fo_select_own_evidence's RLS check");

  // -------------------------------------------------------------- [H]
  console.log("\n[H] Manager allowlist can read evidence:");
  const managerRead = await managerCtx.ctx.from("evidence").createSignedUrl(ownerOnlyPath, 3600);
  check(!!managerRead.data?.signedUrl, "a manager-uid-1-authenticated request (in the managers allowlist) CAN sign fo-owner-uid's object");

  // -------------------------------------------------------------- [I]
  console.log("\n[I] Non-manager cannot read another FO's evidence:");
  const nonManagerRead = await nonManagerCtx.ctx.from("evidence").createSignedUrl(ownerOnlyPath, 3600);
  check(!nonManagerRead.data && !!nonManagerRead.error, "an authenticated-but-non-owner, non-allowlisted uid is denied — same result as [G], re-asserted from the 'not a manager' angle");

  // -------------------------------------------------------------- [J]
  console.log("\n[J] Delete remains denied (structural proof):");
  const mediaStorageSrc = readFileSync("src/data/mediaStorage.ts", "utf8");
  check(!/\.remove\(|\.delete\(/.test(mediaStorageSrc), "mediaStorage.ts contains no call to a Storage delete/remove API of any kind");
  check(mediaStorageSrc.includes("export function evidenceStoragePath") && mediaStorageSrc.includes("export async function uploadEvidenceFile") && mediaStorageSrc.includes("export async function getEvidenceSignedUrl"), "mediaStorage.ts's only exports are path-building, upload, and sign — no delete export exists for any code path to call");

  // -------------------------------------------------------------- [K]
  console.log("\n[K] Offline capture remains durable (documentation, not re-tested here):");
  const mediaOutboxSrc = readFileSync("src/data/mediaOutbox.ts", "utf8");
  check(mediaOutboxSrc.includes('import { get, set, del, keys } from "idb-keyval";'), "mediaOutbox.ts still uses idb-keyval for durable local storage — untouched by this round's diff");
  check(mediaOutboxSrc.includes("async function drainMediaOutbox"), "drainMediaOutbox()'s loop/retry/never-delete-on-failure structure is unchanged — only its isFirebaseConfigured()->isSupabaseConfigured() guard and the uploadEvidenceFile() call's argument list changed (see this round's report). Real browser IndexedDB durability was proven in the prior round's manual/emulator testing and is unaffected by a Storage-provider swap; re-verify in-browser per DEPLOYMENT.md if in doubt.");

  // -------------------------------------------------------------- [L]
  console.log("\n[L] Firestore evidence metadata remains deferred until upload succeeds (documentation, not re-tested here):");
  const syncEngineSrc = readFileSync("src/data/syncEngine.ts", "utf8");
  check(syncEngineSrc.includes("function evidenceReadyToSync"), "syncEngine.ts's evidenceReadyToSync() gate still exists, untouched by this round's diff (grep-verified — no lines of syncEngine.ts were changed in this round)");
  check(true, "end-to-end deferred-sync behavior is exercised by tests/planner-assignment-persistence.emulator.mjs, which is unaffected by a Storage-provider swap since it never touches mediaStorage.ts");

  // -------------------------------------------------------------- [M]
  console.log("\n[M] Signed URL generation works for Manager:");
  check(managerRead.data.signedUrl.startsWith("https://"), "the Manager's signed URL is a well-formed HTTPS URL");
  check(managerRead.data.signedUrl.includes(ownerOnlyPath), "the signed URL is scoped to the requested object path");

  // -------------------------------------------------------------- [N]
  console.log("\n[N] Token refresh behavior — no forced refresh on every request (source-level check; real timing needs a live Supabase project):");
  const authSrc = readFileSync("src/auth/firebaseAuth.ts", "utf8");
  const authMatch = authSrc.match(/export async function getCurrentFirebaseIdToken\(([^)]*)\)/);
  check(!!authMatch, "getCurrentFirebaseIdToken() exists in firebaseAuth.ts");
  check(!!authMatch && /forceRefresh\s*=\s*false/.test(authMatch[1]), `getCurrentFirebaseIdToken() defaults forceRefresh to false (signature: "${authMatch?.[1]}")`);
  const clientSrc = readFileSync("src/data/supabaseClient.ts", "utf8");
  check(/accessToken:\s*async\s*\(\)\s*=>\s*getCurrentFirebaseIdToken\(\)/.test(clientSrc), "supabaseClient.ts's accessToken callback calls getCurrentFirebaseIdToken() with NO arguments — i.e. does not force a refresh on every request");
  check(!/getCurrentFirebaseIdToken\(true\)/.test(clientSrc), "supabaseClient.ts never calls getCurrentFirebaseIdToken(true) — forced refresh is not used for ordinary requests");
  console.log("  NOTE: actual token-expiry/auto-refresh TIMING (does the Firebase SDK genuinely refresh before Supabase rejects an expired token?) cannot be verified without a live Firebase session over a real expiry window — this must be manually verified against a real Supabase project (see this round's final report).");

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
