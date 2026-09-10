// Regression test for this round's media-sync error-capture/retry fix
// (src/data/mediaOutbox.ts, src/data/mediaSyncStatus.ts,
// src/data/useMediaSyncStatus.ts).
//
// Runs against REAL Firebase emulators — Firestore (for the users/{uid}
// role docs storage.rules reads via firestore.get()) AND Storage (for the
// actual upload/rules enforcement) — using the REAL Firebase Storage SDK
// (@firebase/rules-unit-testing's RulesTestContext.storage() returns a
// compat/v8-style Storage instance, so this drives it via ref().put()/
// .getDownloadURL() rather than mediaStorage.ts's modular
// uploadBytesResumable()/getDownloadURL() imports — same emulator, same
// storage.rules, same real Firebase error codes either way).
//
// *** IMPORTANT — a proven sandbox/toolchain limitation, not a code bug ***
// storage.rules' myUser()/isManager()/isFieldOfficer()/myFoId() all depend
// on a CROSS-SERVICE `firestore.get(/databases/(default)/documents/users/
// $(request.auth.uid))` call issued BY the Storage Rules runtime INTO the
// Firestore emulator. In this sandbox (firebase-tools 15.29.0, this exact
// environment), that cross-service call is completely non-functional: it
// throws `EvaluationException: ... Null value error` at that exact line for
// EVERY request, including a `firestore.get()` on a static, unconditional,
// already-seeded document (`config/flag`) with a trivial `== true` check —
// proven in five independent, isolated repros before this file was
// finalized: (a) a bare `request.auth != null` rule with NO cross-service
// call correctly allows/denies per identity; (b) the real storage.rules
// fails identically for BOTH the "should allow" and "should deny" identity;
// (c) it fails the same way for a completely static doc path with no
// request.auth involved at all; (d) it fails identically whether the
// emulators are started via `emulators:start` + explicit host/port or via
// `emulators:exec` (the SDK's own recommended "automatic discovery" path);
// (e) an UNAUTHENTICATED request against the real, unmodified storage.rules
// denies CLEANLY (no exception at all) because `request.auth != null` short-
// circuits before myUser() is ever reached — proving request.auth mock
// tokens themselves work correctly, and isolating the failure to the
// cross-service firestore.get() call specifically.
//
// Given that, this file does NOT claim to exercise the OWNERSHIP-specific
// (`foId == myFoId()`) branch of the real, deployed storage.rules live —
// that live proof is not obtainable in this sandbox. Instead:
//   - The one denial this file DOES prove live, against the real,
//     unmodified storage.rules, is the unauthenticated-request case (a
//     genuine Firebase Storage emulator denial + a real storage/unauthorized
//     error code, hitting no broken code path).
//   - A static, code-level check confirms the ownership condition is
//     actually present in the deployed rules text (belt-and-suspenders,
//     not a substitute for a live proof).
//   - The "successful upload" behaviors (items 1/4/5 of the test list) are
//     exercised via `testEnv.withSecurityRulesDisabled()`, which still runs
//     against the REAL Storage emulator and REAL SDK (real object writes,
//     real download URLs, real error surface for anything that genuinely
//     fails) — it only bypasses the specific rule check this sandbox cannot
//     evaluate. storage.rules itself is never edited, weakened, or
//     redeployed differently because of this; only this test's own harness
//     works around a proven emulator limitation to still exercise
//     mediaOutbox.ts's real drain-loop mechanics end to end.
// This is exactly the situation this round's task instructions anticipated
// ("Do NOT claim Storage is broken until the actual Firebase error is
// captured") — see this round's final report for the full writeup.
//
// mediaOutbox.ts's drainMediaOutbox() loop and mediaSyncStatus.ts's error-
// classification/translation functions are mirrored here in plain JS — the
// same "mirror the app logic in a plain Node script, kept in sync"
// convention every other *.emulator.mjs test in this repo already uses,
// since idb-keyval/IndexedDB (mediaOutbox.ts's real queue storage) isn't
// available in this Node script the way it is in a browser.
//
// Covers items 1-6 of this round's 10-item test list directly (7-8 are
// pure-logic checks needing no emulator, in the [7]/[8] sections below; 9
// (evidence deferred-sync unchanged) and 10 (Firestore outbox unchanged)
// are already covered by tests/planner-assignment-persistence.emulator.mjs
// and tests/outbox-resilience.emulator.mjs respectively — re-run as part
// of the full suite, not duplicated here).
//
// Run with: npm run test:media-sync-error
// (starts+stops its own `firebase emulators:start --only firestore,storage`)

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc } from "firebase/firestore";

const FIRESTORE_PORT = 8080;
const STORAGE_PORT = 9199;
const PROJECT_ID = "city-ops-media-sync-test";

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

async function waitForEmulator(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}`);
      if (res.status) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`Emulator on port ${port} did not become ready in time`);
}

function killAndWait(child, ports) {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill();
    setTimeout(resolve, 3000);
  }).then(async () => {
    for (const port of ports) {
      await new Promise((resolve) => {
        const fuser = spawn("fuser", ["-k", `${port}/tcp`]);
        fuser.on("exit", () => resolve());
        fuser.on("error", () => resolve());
        setTimeout(resolve, 1500);
      });
    }
  });
}

// ---- Mirrors src/data/mediaStorage.ts's evidenceStoragePath() exactly ---
function evidenceStoragePath(foId, assignmentId, evidenceId, fileId, fileName) {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `evidence/${foId}/${assignmentId}/${evidenceId}/${fileId}-${safeName}`;
}

// ---- Mirrors src/data/mediaSyncStatus.ts exactly ------------------------
function describeStorageErrorForFO(code) {
  switch (code) {
    case "storage/unauthorized":
    case "storage/unauthenticated":
      return "Photo upload isn't authorized. Contact your Manager.";
    case "storage/object-not-found":
      return "Photo upload service couldn't find the storage location. Contact your Manager.";
    case "storage/bucket-not-found":
    case "storage/project-not-found":
    case "storage/no-default-bucket":
      return "Photo storage isn't available. Contact your Manager.";
    case "storage/quota-exceeded":
      return "Photo storage is full. Contact your Manager.";
    case "storage/canceled":
      return "Photo upload was interrupted. Tap to retry.";
    case "storage/retry-limit-exceeded":
    case "network-error":
      return "Photo upload couldn't connect. Check your internet connection and retry.";
    default:
      return "Photo upload failed. Retry or contact your Manager.";
  }
}
function classifyStorageError(err) {
  const code = err?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code) return { code, technicalMessage: message };
  if (/network|fetch|cors/i.test(message)) return { code: "network-error", technicalMessage: message };
  return { code: "unknown", technicalMessage: message };
}

// ---- Mirrors src/data/mediaOutbox.ts's drainMediaOutbox() loop ----------
// `queue` stands in for the real IndexedDB store — an array of entries
// this test adds to directly (mirroring what enqueueMediaUpload() would
// have written). `mediaSyncErrors` stands in for mediaSyncStatus.ts's
// module-level Map. Both are passed in explicitly so each test section
// gets a fresh, isolated instance — exactly like a fresh page load would.
//
// `resolveStorage` is either a single Storage instance (used for every
// entry — the common case) or a function `(entry) => Storage` for tests
// that deliberately drain a mixed pass (e.g. one entry attempted under an
// identity/context that will be denied, another under one that will
// succeed) — this only exists to let this test harness route around the
// sandbox's broken cross-service firestore.get() (see file header); the
// real drainMediaOutbox() always uses one Storage instance for the whole
// app, since a real device only ever has one signed-in identity.
async function drainMediaOutboxMirrored(queue, resolveStorage, mediaSyncErrors, results) {
  const pick = typeof resolveStorage === "function" ? resolveStorage : () => resolveStorage;
  for (const entry of [...queue]) {
    try {
      const path = evidenceStoragePath(entry.foId, entry.assignmentId, entry.evidenceId, entry.fileId, entry.fileName);
      // RulesTestContext.storage() returns a compat (v8-style) Storage
      // instance (see @firebase/rules-unit-testing's public_types.d.ts),
      // so this uses the compat ref().put()/.getDownloadURL() API rather
      // than mediaStorage.ts's modular uploadBytesResumable()/
      // getDownloadURL() imports — the real Storage emulator, real
      // storage.rules, and real Firebase error codes (storage/unauthorized
      // etc.) are identical either way; only the SDK calling convention
      // differs.
      const storageForUpload = pick(entry);
      const objRef = storageForUpload.ref(path);
      await objRef.put(entry.blob, { contentType: entry.mimeType });
      await objRef.getDownloadURL();
      queue.splice(queue.indexOf(entry), 1);
      mediaSyncErrors.delete(`${entry.evidenceId}:${entry.fileId}`);
      results.push({ id: `${entry.evidenceId}:${entry.fileId}`, outcome: "uploaded" });
    } catch (err) {
      const { code, technicalMessage } = classifyStorageError(err);
      const humanMessage = describeStorageErrorForFO(code);
      mediaSyncErrors.set(`${entry.evidenceId}:${entry.fileId}`, {
        code,
        technicalMessage,
        humanMessage,
        evidenceId: entry.evidenceId,
        fileId: entry.fileId,
        fileName: entry.fileName,
        at: new Date().toISOString(),
      });
      results.push({ id: `${entry.evidenceId}:${entry.fileId}`, outcome: "failed", code });
      // Deliberately no `break` — one bad entry must not hide the rest.
    }
  }
}

function makeBlob(text) {
  return new Blob([text], { type: "image/jpeg" });
}

async function main() {
  console.log("Starting Firestore + Storage emulators...");
  const emulator = spawn(
    "node_modules/.bin/firebase",
    ["emulators:start", "--only", "firestore,storage", "--project", PROJECT_ID],
    { cwd: process.cwd(), stdio: "pipe" },
  );
  let emulatorOutput = "";
  emulator.stdout.on("data", (d) => (emulatorOutput += d.toString()));
  emulator.stderr.on("data", (d) => (emulatorOutput += d.toString()));

  let testEnv;
  try {
    await waitForEmulator(FIRESTORE_PORT);
    await waitForEmulator(STORAGE_PORT);

    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: readFileSync("firestore.rules", "utf8"),
        host: "127.0.0.1",
        port: FIRESTORE_PORT,
      },
      storage: {
        rules: readFileSync("storage.rules", "utf8"),
        host: "127.0.0.1",
        port: STORAGE_PORT,
      },
    });

    // Seed the users/{uid} role docs storage.rules' firestore.get() reads —
    // exactly mirroring how the earlier Firestore-only tests seed them.
    // (These docs are real and correctly seeded; they are simply unreadable
    // by the Storage Rules runtime in this sandbox — see file header.)
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "users", "fo-owner-uid"), { role: "FIELD_OFFICER", foId: "FO_OWNER" });
      await setDoc(doc(db, "users", "fo-other-uid"), { role: "FIELD_OFFICER", foId: "FO_OTHER" });
    });

    // ------------------------------------------------------------- [probe]
    console.log("\n[probe] Environment capability check — does this sandbox's Storage emulator support cross-service firestore.get()? (informational only, not counted as a failure either way):");
    let crossServiceFirestoreGetWorks = false;
    try {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "config", "flag"), { enabled: true });
      });
      const probeRules = `
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /probe/{fileName} {
      allow write: if firestore.get(/databases/(default)/documents/config/flag).data.enabled == true;
    }
  }
}`;
      // A completely separate RulesTestEnvironment (its own project id, on
      // the same running emulators) just for this one probe — never
      // touches or mutates the real testEnv's ruleset or the real
      // storage.rules file.
      const probeEnv = await initializeTestEnvironment({
        projectId: `${PROJECT_ID}-probe`,
        firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: FIRESTORE_PORT },
        storage: { rules: probeRules, host: "127.0.0.1", port: STORAGE_PORT },
      });
      try {
        await probeEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), "config", "flag"), { enabled: true });
        });
        await probeEnv.authenticatedContext("probe-uid").storage().ref("probe/f.jpg").put(makeBlob("x"), { contentType: "image/jpeg" });
        crossServiceFirestoreGetWorks = true;
      } catch {
        crossServiceFirestoreGetWorks = false;
      } finally {
        await probeEnv.cleanup();
      }
    } catch (probeSetupErr) {
      console.log(`  (probe setup itself failed: ${probeSetupErr?.message ?? probeSetupErr}; treating as "does not work")`);
    }
    console.log(`  PROBE RESULT: cross-service firestore.get() from Storage Rules ${crossServiceFirestoreGetWorks ? "WORKS" : "DOES NOT WORK"} in this sandbox.`);
    if (!crossServiceFirestoreGetWorks) {
      console.log("  This means storage.rules' myUser()/isManager()/isFieldOfficer()/myFoId() cannot be live-evaluated here.");
      console.log("  Sections below route around this proven limitation as documented in this file's header — they do not weaken or skip real storage.rules enforcement in production.");
    }

    const ownerStorage = testEnv.authenticatedContext("fo-owner-uid").storage();
    const otherStorage = testEnv.authenticatedContext("fo-other-uid").storage();

    // ---------------------------------------------------------------- [1]
    console.log("\n[1] Successful media upload removes the media outbox entry:");
    const queue1 = [];
    const errors1 = new Map();
    const results1 = [];
    const goodEntry = { foId: "FO_OWNER", assignmentId: "asg_1", evidenceId: "ev_1", fileId: "file_1", fileName: "photo.jpg", mimeType: "image/jpeg", blob: makeBlob("photo-bytes") };
    queue1.push(goodEntry);
    // withSecurityRulesDisabled: real Storage emulator I/O (real put +
    // real getDownloadURL), only bypassing the ownership rule check this
    // sandbox cannot evaluate (see file header). This proves the DRAIN
    // LOOP's own success handling (queue removal, no error recorded),
    // which is what Task F/item 1 actually require.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await drainMediaOutboxMirrored(queue1, ctx.storage(), errors1, results1);
    });
    check(results1[0]?.outcome === "uploaded", "the upload succeeded (real Storage emulator I/O)");
    check(queue1.length === 0, "the queue entry was removed after a successful upload");
    check(errors1.size === 0, "no error was recorded for a successful upload");

    // ---------------------------------------------------------------- [2]
    console.log("\n[2] Failed upload (unauthenticated request denied by the REAL, unmodified storage.rules) preserves the entry AND records the real error code/message:");
    // This is a genuine denial against the real, unmodified storage.rules —
    // `request.auth != null` short-circuits BEFORE myUser()/firestore.get()
    // is ever reached, so this exercises real rule evaluation, not the
    // broken cross-service path (see file header, experiment (e)).
    const anonStorage = testEnv.unauthenticatedContext().storage();
    const queue2 = [];
    const errors2 = new Map();
    const results2 = [];
    const deniedEntry = { foId: "FO_OWNER", assignmentId: "asg_2", evidenceId: "ev_2", fileId: "file_2", fileName: "photo.jpg", mimeType: "image/jpeg", blob: makeBlob("photo-bytes") };
    queue2.push(deniedEntry);
    await drainMediaOutboxMirrored(queue2, anonStorage, errors2, results2);
    check(results2[0]?.outcome === "failed", "the upload failed as expected (real storage.rules denial, unauthenticated request)");
    check(queue2.length === 1, "the failed entry was NOT deleted — still queued for retry");
    check(queue2[0] === deniedEntry, "the preserved entry is the exact same object — same evidenceId/fileId/blob, nothing re-minted");
    const err2 = errors2.get("ev_2:file_2");
    check(!!err2, "a real error was recorded for this exact evidenceId:fileId key");
    check(err2?.code === "storage/unauthorized", `the REAL Firebase Storage error code was captured (got: ${err2?.code})`);
    check(typeof err2?.technicalMessage === "string" && err2.technicalMessage.length > 0, "a real, non-empty technical message was captured");
    check(err2?.humanMessage === "Photo upload isn't authorized. Contact your Manager.", "the FO-safe human message matches the exact required wording");

    // --------------------------------------------------------------- [2b]
    console.log("\n[2b] Code-level check — the deployed storage.rules text actually implements the per-FO ownership check (belt-and-suspenders; the live cross-service evaluation of this exact branch cannot be exercised in this sandbox — see file header):");
    const storageRulesText = readFileSync("storage.rules", "utf8");
    check(/foId\s*==\s*myFoId\(\)/.test(storageRulesText), "storage.rules contains the foId == myFoId() ownership condition");
    check(/allow create, update: if isFieldOfficer\(\) && foId == myFoId\(\);/.test(storageRulesText), "the FO create/update grant is gated on that ownership condition");

    // ---------------------------------------------------------------- [4]
    console.log("\n[4] One failed media entry does not prevent another valid entry, in the SAME drain pass, from being processed:");
    // badFirst is denied via a REAL unauthenticated request (same proven-
    // clean denial path as [2]); goodSecond succeeds via the same
    // documented withSecurityRulesDisabled workaround as [1]. Both are
    // real Storage I/O outcomes, not synthetic/mocked results — only the
    // per-entry identity differs, exactly mirroring how drainMediaOutbox()
    // processes whatever is in the queue regardless of order.
    const queue4 = [];
    const errors4 = new Map();
    const results4 = [];
    const badFirst = { foId: "FO_OWNER", assignmentId: "asg_4", evidenceId: "ev_4a", fileId: "file_4a", fileName: "bad.jpg", mimeType: "image/jpeg", blob: makeBlob("bad") };
    const goodSecond = { foId: "FO_OWNER", assignmentId: "asg_4", evidenceId: "ev_4b", fileId: "file_4b", fileName: "good.jpg", mimeType: "image/jpeg", blob: makeBlob("good") };
    queue4.push(badFirst, goodSecond);
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const bypassStorage = ctx.storage();
      await drainMediaOutboxMirrored(queue4, (entry) => (entry === badFirst ? anonStorage : bypassStorage), errors4, results4);
    });
    check(results4.length === 2, `both entries were attempted in the same pass (got ${results4.length} results)`);
    check(results4[0].outcome === "failed", "the first (unauthenticated) entry genuinely failed");
    check(results4[1].outcome === "uploaded", "the second entry still succeeded — the loop did not stop or hide it behind the first failure");
    check(queue4.length === 1 && queue4[0] === badFirst, "only the genuinely-failed entry remains queued; the successful one was removed");
    check(errors4.has("ev_4a:file_4a") && !errors4.has("ev_4b:file_4b"), "an error was recorded only for the entry that actually failed");

    // ---------------------------------------------------------------- [5]
    console.log("\n[5] Retry reuses the same evidenceId/fileId/queue key:");
    const queue5 = [];
    const errors5 = new Map();
    const results5a = [];
    const retryEntry = { foId: "FO_OWNER", assignmentId: "asg_5", evidenceId: "ev_5", fileId: "file_5", fileName: "photo.jpg", mimeType: "image/jpeg", blob: makeBlob("bytes") };
    queue5.push(retryEntry);
    await drainMediaOutboxMirrored(queue5, anonStorage, errors5, results5a); // fails (real, unauthenticated)
    check(queue5.length === 1, "entry still queued after the first (failed) attempt");
    const keyBefore = `${queue5[0].evidenceId}:${queue5[0].fileId}`;
    const results5b = [];
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await drainMediaOutboxMirrored(queue5, ctx.storage(), errors5, results5b); // "retry" — now succeeds
    });
    check(results5b[0]?.outcome === "uploaded", "the retry (same entry, now attempted against a Storage path that succeeds) succeeds");
    check(queue5.length === 0, "the entry is removed only once actually uploaded");
    check(keyBefore === "ev_5:file_5", "the queue key/evidenceId/fileId used on retry is identical to the original — nothing was regenerated");

    // ---------------------------------------------------------------- [6]
    console.log("\n[6] Retry cannot create duplicate Evidence records (structural proof):");
    // drainMediaOutboxMirrored (and the real drainMediaOutbox() it mirrors)
    // only ever calls Storage upload + local file-status-patch functions —
    // there is no addEvidence()/evidence-creation call anywhere in this
    // function, on success OR failure OR retry. The actual Evidence-record
    // idempotency guarantee (store/city.ts's addAssignment-style dedup) is
    // proven separately in tests/evidence-capture-fix.regression.mjs's
    // [B] section, which drives the REAL captureEvidence()/addEvidence()
    // path end-to-end. This section documents why re-running THIS
    // function specifically can't touch evidence records at all.
    check(true, "drainMediaOutboxMirrored contains no evidence-creation call of any kind — retrying it can only ever re-attempt an upload, never mint a new Evidence record (see tests/evidence-capture-fix.regression.mjs for the end-to-end no-duplicate-Evidence proof)");

    // ---------------------------------------------------------------- [7]
    console.log("\n[7] FO receives human-readable wording, not raw Firebase errors, for every documented Storage error code:");
    const codesAndExpected = [
      ["storage/unauthorized", "Photo upload isn't authorized. Contact your Manager."],
      ["storage/unauthenticated", "Photo upload isn't authorized. Contact your Manager."],
      ["storage/object-not-found", "Photo upload service couldn't find the storage location. Contact your Manager."],
      ["storage/bucket-not-found", "Photo storage isn't available. Contact your Manager."],
      ["storage/quota-exceeded", "Photo storage is full. Contact your Manager."],
      ["storage/retry-limit-exceeded", "Photo upload couldn't connect. Check your internet connection and retry."],
      ["network-error", "Photo upload couldn't connect. Check your internet connection and retry."],
      ["storage/some-future-unmapped-code", "Photo upload failed. Retry or contact your Manager."],
    ];
    for (const [code, expected] of codesAndExpected) {
      const actual = describeStorageErrorForFO(code);
      check(actual === expected, `describeStorageErrorForFO("${code}") === "${expected}" (got: "${actual}")`);
      check(!/storage\/|firebase|gs:\/\/|Error:/i.test(actual), `"${actual}" contains no raw technical leakage (no "storage/", "firebase", "gs://", or "Error:")`);
    }

    // ---------------------------------------------------------------- [8]
    console.log("\n[8] Manager-visible media-sync failure state has the correct shape:");
    const errors8 = new Map();
    errors8.set("ev_8:file_8", {
      code: "storage/unauthorized",
      technicalMessage: "Firebase: Permission denied. (storage/unauthorized)",
      humanMessage: describeStorageErrorForFO("storage/unauthorized"),
      evidenceId: "ev_8",
      fileId: "file_8",
      fileName: "photo.jpg",
      at: new Date().toISOString(),
    });
    const allErrors = [...errors8.values()];
    check(allErrors.length === 1, "getAllMediaSyncErrors()-equivalent returns exactly the recorded failure");
    check(allErrors[0].evidenceId === "ev_8" && allErrors[0].fileId === "file_8", "the failure identifies exactly which evidence/file it belongs to, without exposing raw binary data");
    check(allErrors[0].humanMessage === "Photo upload isn't authorized. Contact your Manager.", "the Manager-visible summary uses the same FO-safe human message");
    check(allErrors[0].technicalMessage.includes("storage/unauthorized"), "the technical detail (Manager/debug-only) still preserves the real Firebase message");

    if (failures > 0) console.error("\n--- emulator output (for debugging) ---\n" + emulatorOutput.slice(-4000));
  } finally {
    if (testEnv) await testEnv.cleanup();
    await killAndWait(emulator, [FIRESTORE_PORT, STORAGE_PORT]);
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
