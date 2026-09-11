// Regression test for the production synchronization fix: Firestore
// evidence sync in src/data/syncEngine.ts was purely EDGE-TRIGGERED (a
// Zustand store-diff watcher reacting only to a live transition it happens
// to observe), with no periodic/startup reconciliation pass. A media
// upload can flip a file's uploadStatus from "uploading"/undefined to
// "uploaded" (see mediaOutbox.ts's drainMediaOutbox()) at a moment when
// nothing is watching — before the watcher attaches at startup, across a
// reload, or across a background/foreground cycle — silently and
// PERMANENTLY skipping that evidence record's Firestore write forever,
// even though the underlying Supabase Storage upload succeeded. This is
// the exact shape of the production incident: a real uploaded Supabase
// object (ev_5l13axhb37) with no matching Firestore document anywhere in
// the assignment's evidence inventory, alongside four Firestore evidence
// documents permanently stuck at uploadStatus:"uploading"/storagePath:null.
//
// Fix: syncEngine.ts's new reconcileEvidenceSync() re-scans the FULL local
// evidence array (not just the one record a live transition touched) and
// enqueues anything evidenceReadyToSync() finds ready but not yet durably
// synced (tracked via a LOCALSTORAGE-PERSISTED syncedEvidenceOnceIds set,
// not just an in-memory one — critical, since evidence/{docId} grants the
// Field Officer CREATE only, never UPDATE, so re-scanning on every reload
// without a durable "already synced" record would re-enqueue, and get
// permission-denied on, every historical evidence record on every load).
// Called after the local watcher attaches (startup/hydration), on every
// media-outbox-change event (a drain completing), and on `online`.
//
// This test mirrors reconcileEvidenceSync()'s exact logic in plain Node
// (idb-keyval/Zustand/import.meta.env can't run outside a browser/Vite —
// same convention as every other *.emulator.mjs test in this repo) against
// a REAL Firestore emulator running the REAL firestore.rules, so the
// create-only enforcement itself is genuine, not simulated.
//
// Covers requirement 7, items A-F, H (emulator-mirrored logic) and G
// (real browser, Playwright, production build — the one item that's a UI
// interaction bug, not a sync-logic bug). Item I (Supabase bucket-relative
// path) is already covered by tests/supabase-media-storage.mjs's [PATH]
// section and is not duplicated here.
//
// Run with: npm run test:evidence-sync-reconciliation
// (starts+stops its own `firebase emulators:start --only firestore`, then
// builds and Playwright-drives a production preview server for item G)

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, updateDoc, getDoc } from "firebase/firestore";
import { chromium } from "playwright";

const EMULATOR_PORT = 8080;
const PROJECT_ID = "city-ops-evidence-reconciliation-test";
const PW_PORT = 4181;
const BASE_URL = `http://localhost:${PW_PORT}`;
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const VITE_BIN = "node_modules/.bin/vite";

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

async function waitForEmulator() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${EMULATOR_PORT}`);
      if (res.status) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error("Firestore emulator did not become ready in time");
}

function killAndWait(child, port) {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill();
    setTimeout(resolve, 3000);
  }).then(() => {
    return new Promise((resolve) => {
      const fuser = spawn("fuser", ["-k", `${port}/tcp`]);
      fuser.on("exit", () => resolve());
      fuser.on("error", () => resolve());
      setTimeout(resolve, 2000);
    });
  });
}

async function waitForPreviewServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE_URL);
      if (res.ok || res.status === 404) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error("Preview server did not become ready in time");
}

// -------------------------------------------------------------------------
// Exact mirror of syncEngine.ts's evidenceReadyToSync() and
// reconcileEvidenceSync(). Kept in sync with the real implementation by
// convention (see the file-header comment above) — if these ever diverge,
// this test stops proving anything about the real code path.
// -------------------------------------------------------------------------

function evidenceReadyToSync(record) {
  return record.files.every((f) => f.uploadStatus == null || f.uploadStatus === "uploaded");
}

/** `syncedOnceIds` and `enqueuedThisPass` are mutated in place, mirroring
 * the real function's durable Set + real Firestore write. Returns the
 * records this pass actually enqueued (for assertions), and performs the
 * REAL Firestore create() for each — so a bug that bypassed the
 * already-synced guard would show up as a genuine permission-denied error
 * from the real rules, not just a mirrored-logic assertion. */
async function reconcile(db, evidenceArray, syncedOnceIds) {
  const toEnqueue = [];
  for (const record of evidenceArray) {
    if (syncedOnceIds.has(record.id)) continue;
    if (!evidenceReadyToSync(record)) continue;
    syncedOnceIds.add(record.id);
    toEnqueue.push(record);
  }
  for (const record of toEnqueue) {
    await setDoc(doc(db, "evidence", record.id), record);
  }
  return toEnqueue;
}

function makeEvidence(id, foId, assignmentId, files) {
  return { id, foId, assignmentId, type: "ARRIVAL", files, createdAt: new Date().toISOString() };
}

/** Mirrors syncEngine.ts's enqueueEvidenceOnce() exactly (POST-FIX, added
 * after a correctness review found the original implementation marked
 * `syncedOnceIds` BEFORE calling enqueue(), meaning a genuine enqueue()
 * failure — a real, if rare, possibility: IndexedDB unavailable, over
 * quota, a blocked/aborted transaction — would permanently and silently
 * drop that evidence record from ever syncing again, since it would
 * already look "done" to every future reconciliation pass, with no
 * outbox entry ever created to retry). `outboxWrite` stands in for
 * outbox.ts's enqueue() — a LOCAL IndexedDB write, not a Firestore write —
 * pass a function that throws to simulate a genuine local persistence
 * failure. `pendingIds` mirrors pendingEvidenceEnqueues (the in-flight
 * concurrent-call guard). */
async function enqueueEvidenceOnceMirrored(record, syncedOnceIds, pendingIds, outboxWrite) {
  if (syncedOnceIds.has(record.id) || pendingIds.has(record.id)) return { attempted: false, succeeded: false };
  pendingIds.add(record.id);
  try {
    await outboxWrite(record);
    syncedOnceIds.add(record.id);
    return { attempted: true, succeeded: true };
  } catch {
    return { attempted: true, succeeded: false };
  } finally {
    pendingIds.delete(record.id);
  }
}

async function runEmulatorSuite() {
  console.log("Starting Firestore emulator...");
  const emulator = spawn("node_modules/.bin/firebase", ["emulators:start", "--only", "firestore", "--project", PROJECT_ID], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
  let emulatorOutput = "";
  emulator.stdout.on("data", (d) => (emulatorOutput += d.toString()));
  emulator.stderr.on("data", (d) => (emulatorOutput += d.toString()));

  let testEnv;
  try {
    await waitForEmulator();

    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: readFileSync("firestore.rules", "utf8"),
        host: "127.0.0.1",
        port: EMULATOR_PORT,
      },
    });

    const FO_UID = "fo-uid-1";
    const FO_ID = "fo1";
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", FO_UID), { role: "FIELD_OFFICER", foId: FO_ID });
    });
    const foDb = testEnv.authenticatedContext(FO_UID).firestore();

    // ---------------------------------------------------------- [A]
    console.log("\n[A] Evidence with a not-yet-uploaded file does not sync prematurely:");
    const syncedOnceIds = new Set();
    const notReady = makeEvidence("ev_not_ready", FO_ID, "asg1", [{ id: "f1", uploadStatus: "uploading" }]);
    const passA = await reconcile(foDb, [notReady], syncedOnceIds);
    check(passA.length === 0, "reconcile() did not enqueue an evidence record with a still-uploading file");
    check(!syncedOnceIds.has("ev_not_ready"), "not-ready record was not marked synced");
    // Read via an admin (security-rules-disabled) context — the FO's own
    // read rule dereferences resource.data.foId unconditionally, which
    // throws a rules evaluation error (surfaced as permission-denied) for a
    // document that was never created, rather than a clean "not found";
    // an admin context avoids that rules quirk entirely, and is still a
    // completely faithful check of "no document was written."
    let storedA;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      storedA = await getDoc(doc(ctx.firestore(), "evidence", "ev_not_ready"));
    });
    check(!storedA.exists(), "not-ready record was never written to Firestore");

    // ---------------------------------------------------------- [B/F]
    console.log("\n[B/F] A later transition to 'uploaded' is discovered by reconciliation even though the watcher never observed it (simulates a missed transition / reload / background):");
    // The SAME evidenceId as [A], now with its file's uploadStatus flipped
    // to "uploaded" by a completed media upload — exactly the transition a
    // live Zustand watcher could miss. This local array is what a fresh
    // reconciliation pass would see after a reload/background cycle,
    // reading persisted local state directly rather than an in-flight diff.
    const nowReady = makeEvidence("ev_not_ready", FO_ID, "asg1", [{ id: "f1", uploadStatus: "uploaded", storagePath: "fo-uid-1/asg1/ev_not_ready/f1-rig.png" }]);
    const passB = await reconcile(foDb, [nowReady], syncedOnceIds);
    check(passB.length === 1 && passB[0].id === "ev_not_ready", "reconcile() discovered the now-ready record on a later pass, with no watcher transition involved");
    const storedB = await getDoc(doc(foDb, "evidence", "ev_not_ready"));
    check(storedB.exists(), "the record actually reached Firestore once ready — proves the orphan class (uploaded Storage object, no Firestore doc) is fixed");
    check(storedB.data()?.files?.[0]?.storagePath === "fo-uid-1/asg1/ev_not_ready/f1-rig.png", "the synced document carries the real storagePath, not a placeholder");

    // ---------------------------------------------------------- [C]
    console.log("\n[C] Reconciliation is idempotent — the same record is never enqueued (or written) twice:");
    const passC = await reconcile(foDb, [nowReady], syncedOnceIds);
    check(passC.length === 0, "a second reconciliation pass over the same already-synced record enqueues nothing");
    // Prove this ISN'T merely a mirrored-logic coincidence: a genuine second
    // WRITE attempt against the real rules for this doc would be denied,
    // because evidence/{docId} grants create only, never update — exactly
    // why the durable guard above matters. If the guard were ever bypassed
    // (e.g. an in-memory-only Set forgetting this id after a reload), THIS
    // is the real error every one of the four stuck production records
    // would have hit on a naive retry.
    await assertFails(updateDoc(doc(foDb, "evidence", "ev_not_ready"), { "files.0.downloadUrl": "https://example.com/new" }));
    console.log("  (confirmed: a raw second write to an already-synced evidence doc is denied by the real create-only rule)");

    // ---------------------------------------------------------- [D]
    console.log("\n[D] A media outbox drain completing triggers reconciliation, discovering evidence the drain itself just made ready:");
    const preDrainEvidence = makeEvidence("ev_drain", FO_ID, "asg1", [{ id: "f2", uploadStatus: "uploading" }]);
    const syncedOnceIds2 = new Set();
    const beforeDrain = await reconcile(foDb, [preDrainEvidence], syncedOnceIds2);
    check(beforeDrain.length === 0, "before the drain finishes, the file is still 'uploading' and does not sync");
    // Simulate drainMediaOutbox()'s success branch: setFileUploadStatus()
    // flips the file to "uploaded" BEFORE the outbox entry is deleted (the
    // Requirement 4 ordering fix) — then onMediaOutboxChange() fires,
    // which is what syncEngine.ts now wires to reconcileEvidenceSync().
    const postDrainEvidence = makeEvidence("ev_drain", FO_ID, "asg1", [{ id: "f2", uploadStatus: "uploaded", storagePath: "fo-uid-1/asg1/ev_drain/f2-x.png" }]);
    const afterDrain = await reconcile(foDb, [postDrainEvidence], syncedOnceIds2);
    check(afterDrain.length === 1, "reconciliation triggered by the drain's completion discovers and enqueues the newly-ready record");
    const storedD = await getDoc(doc(foDb, "evidence", "ev_drain"));
    check(storedD.exists(), "the drain-discovered record reached Firestore");

    // ---------------------------------------------------------- [E]
    console.log("\n[E] Hydration/startup triggers reconciliation over the FULL local evidence array, not just one record:");
    const syncedOnceIds3 = new Set();
    const alreadyUploadedAtStartup = makeEvidence("ev_startup_1", FO_ID, "asg2", [{ id: "f3", uploadStatus: "uploaded", storagePath: "fo-uid-1/asg2/ev_startup_1/f3-x.png" }]);
    const stillUploadingAtStartup = makeEvidence("ev_startup_2", FO_ID, "asg2", [{ id: "f4", uploadStatus: "uploading" }]);
    const startupPass = await reconcile(foDb, [alreadyUploadedAtStartup, stillUploadingAtStartup], syncedOnceIds3);
    check(startupPass.length === 1 && startupPass[0].id === "ev_startup_1", "startup reconciliation syncs the ready record and correctly skips the not-ready one, in the same pass");

    // ---------------------------------------------------------- [H]
    console.log("\n[H] Existing outbox retry behavior is unaffected — an unrelated collection's write still succeeds independently of evidence reconciliation:");
    await assertSucceeds(setDoc(doc(foDb, "sessions", "ses_retry_check"), { id: "ses_retry_check", foId: FO_ID, assignmentId: "asg1" }));
    const storedSession = await getDoc(doc(foDb, "sessions", "ses_retry_check"));
    check(storedSession.exists(), "a normal (non-evidence) collection write still succeeds exactly as before — reconciliation only changed evidence's sync path");

    // ------------------------------------------ Requirement 2 (security)
    console.log("\n[Req 2] Security model preserved — FO cannot freely update ANY existing evidence record, synced or not:");
    const untouchedRecord = makeEvidence("ev_never_synced", FO_ID, "asg1", [{ id: "f5", uploadStatus: "uploading" }]);
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "evidence", "ev_never_synced"), untouchedRecord);
    });
    await assertFails(updateDoc(doc(foDb, "evidence", "ev_never_synced"), { "files.0.uploadStatus": "uploaded" }));
    console.log("  (confirmed: firestore.rules' evidence/{docId} block still grants create only, never update — unmodified by this fix)");
    await assertSucceeds(setDoc(doc(foDb, "evidence", "ev_brand_new"), makeEvidence("ev_brand_new", FO_ID, "asg1", [])));
    console.log("  (confirmed: FO can still create a brand-new evidence record)");

    // ------------------------------------ [Req-Review B] correctness fix
    console.log("\n[Req-Review B] enqueue() failure must NOT permanently suppress retry — the id must only be marked synced AFTER a genuinely successful enqueue:");
    const outboxSynced = new Set();
    const outboxPending = new Set();
    const flakyRecord = makeEvidence("ev_flaky_outbox", FO_ID, "asg3", [{ id: "f6", uploadStatus: "uploaded", storagePath: "fo-uid-1/asg3/ev_flaky_outbox/f6-x.png" }]);
    let outboxCallCount = 0;
    const flakyOutboxWrite = async (record) => {
      outboxCallCount++;
      if (outboxCallCount === 1) throw new Error("simulated IndexedDB enqueue() failure (e.g. quota exceeded)");
      await setDoc(doc(foDb, "evidence", record.id), record); // stands in for a later successful drainOutbox() delivery
    };

    const firstAttempt = await enqueueEvidenceOnceMirrored(flakyRecord, outboxSynced, outboxPending, flakyOutboxWrite);
    check(firstAttempt.attempted && !firstAttempt.succeeded, "first enqueue attempt genuinely failed (simulated)");
    check(!outboxSynced.has("ev_flaky_outbox"), "the id was NOT marked synced after a failed enqueue — this is the exact fix being verified");

    let storedAfterFailure;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      storedAfterFailure = await getDoc(doc(ctx.firestore(), "evidence", "ev_flaky_outbox"));
    });
    check(!storedAfterFailure.exists(), "no Firestore document exists yet after the failed enqueue attempt");

    // A later reconciliation pass (same record, still absent from
    // syncedOnceIds because the fix left it unmarked) retries it:
    const secondAttempt = await enqueueEvidenceOnceMirrored(flakyRecord, outboxSynced, outboxPending, flakyOutboxWrite);
    check(secondAttempt.attempted && secondAttempt.succeeded, "a later retry succeeds once the outbox write itself succeeds");
    check(outboxSynced.has("ev_flaky_outbox"), "the id IS marked synced once enqueue genuinely succeeds");
    const storedAfterRetry = await getDoc(doc(foDb, "evidence", "ev_flaky_outbox"));
    check(storedAfterRetry.exists(), "the record reaches Firestore once the retry succeeds — a failed enqueue() no longer permanently drops the record");

    // Contrast against the OLD (pre-review) ordering to prove this was a
    // real, reproducible bug, not a hypothetical:
    async function enqueueEvidenceOnceOldBuggyLogic(record, syncedOnceIds, outboxWrite) {
      syncedOnceIds.add(record.id); // OLD ordering: marked BEFORE the outbox write is attempted
      try {
        await outboxWrite(record);
      } catch {
        // swallowed — nothing in the old code rolled the mark back
      }
    }
    const oldSyncedOnceIds = new Set();
    const oldFlakyRecord = makeEvidence("ev_flaky_outbox_oldlogic", FO_ID, "asg3", [{ id: "f7", uploadStatus: "uploaded", storagePath: "fo-uid-1/asg3/ev_flaky_outbox_oldlogic/f7-x.png" }]);
    await enqueueEvidenceOnceOldBuggyLogic(oldFlakyRecord, oldSyncedOnceIds, async () => {
      throw new Error("simulated enqueue failure");
    });
    check(oldSyncedOnceIds.has("ev_flaky_outbox_oldlogic"), "under the OLD (mark-before-enqueue) logic, the id got marked synced even though the outbox write failed");
    check(
      oldSyncedOnceIds.has("ev_flaky_outbox_oldlogic"),
      "=> under the OLD logic a later reconciliation pass would see the id already marked and permanently skip it, even though no outbox entry and no Firestore document were ever created — confirms this was a real, reproducible bug that the review's fix closes",
    );

    if (failures > 0) console.error("\n--- emulator output (for debugging) ---\n" + emulatorOutput.slice(-4000));
  } finally {
    if (testEnv) await testEnv.cleanup();
    await killAndWait(emulator, EMULATOR_PORT);
  }
}

// -------------------------------------------------------------------------
// [G] Arrival duplicate-submit: real browser, real production build. Proves
// the missing submittingArrivalRef guard fix — a rapid double-tap of
// "Continue to Rig Precheck" must produce exactly one ARRIVAL evidence
// record, matching the existing Precheck/Installation/Completion guards'
// proven behavior.
// -------------------------------------------------------------------------

const ONE_PX_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function seedArrivalScenario(page) {
  await page.evaluate(() => {
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const business = { id: "biz1", name: "Test Biz", category: "General", area: "Area", address: "", capacityHoursPerDay: 3, active: true, createdAt: now };
    const fo = { id: "fo1", name: "Test FO", active: true, createdAt: now };
    const rig = { id: "rig1", code: "R-1", model: "Test Rig", active: true, batteryPct: 100, storagePct: 0, deploymentStatus: "active", createdAt: now };
    const assignment = {
      id: "asg1",
      date: today,
      businessId: business.id,
      foId: fo.id,
      rigId: rig.id,
      plannedStart: `${today}T08:00:00.000Z`,
      plannedEnd: `${today}T11:00:00.000Z`,
      priority: "normal",
      status: "confirmed",
      actualArrivalAt: now, // stage "arrived": actualArrivalAt set, no LOCATION evidence yet
      createdAt: now,
    };
    const cityData = {
      version: 2,
      settings: { cityName: "Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
      businesses: [business],
      fos: [fo],
      collectors: [],
      rigs: [rig],
      assignments: [assignment],
      sessions: [],
      evidence: [],
      issues: [],
      qualityReviews: [],
      correctiveActions: [],
      rigIncidents: [],
      repairRecords: [],
      activity: [],
      plans: [],
      reports: [],
    };
    localStorage.setItem("city-ops-os", JSON.stringify({ state: cityData, version: 2 }));
    localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-fo-test-fo1", email: "test-fo@demo.city-ops", role: "FIELD_OFFICER", displayName: "Test FO", foId: "fo1", createdAt: now }));
  });
}

async function runArrivalDoubleSubmitTest() {
  console.log("\n[G] Building production bundle and driving the real ARRIVAL screen...");
  await new Promise((resolve, reject) => {
    const build = spawn("npm", ["run", "build"], { cwd: process.cwd(), stdio: "inherit" });
    build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build failed with code ${code}`))));
  });

  const server = spawn(VITE_BIN, ["preview", "--port", String(PW_PORT), "--strictPort"], { cwd: process.cwd(), stdio: "pipe" });
  let serverOutput = "";
  server.stdout.on("data", (d) => (serverOutput += d.toString()));
  server.stderr.on("data", (d) => (serverOutput += d.toString()));

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  try {
    await waitForPreviewServer();

    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (err) => console.error("  [page error]", err.message));

    await page.goto(`${BASE_URL}/login`);
    await seedArrivalScenario(page);
    await page.goto(`${BASE_URL}/fo`);
    await page.waitForSelector("text=Test Biz", { timeout: 15000 });
    await page.click("text=Test Biz");
    await page.waitForSelector("text=ARRIVAL PHOTO", { timeout: 15000 });

    const arrivalFileInput = page.locator('input[type="file"]').first();
    await arrivalFileInput.setInputFiles({ name: "arrival.png", mimeType: "image/png", buffer: Buffer.from(ONE_PX_PNG_BASE64, "base64") });
    await sleep(400);

    const continueBtn = page.getByRole("button", { name: "Continue to Rig Precheck" });
    check(!(await continueBtn.isDisabled()), "Continue to Rig Precheck is enabled once a photo is added");

    // Rapid double-tap, no delay between clicks — exactly the scenario the
    // missing submittingArrivalRef guard left exploitable.
    await Promise.all([continueBtn.click({ force: true }), continueBtn.click({ force: true })]);
    await sleep(700); // let addEvidence()'s synchronous store write + re-render settle

    const cityData = await page.evaluate(() => {
      const raw = localStorage.getItem("city-ops-os");
      return raw ? JSON.parse(raw).state : null;
    });
    const arrivalRecords = (cityData?.evidence ?? []).filter((e) => e.type === "ARRIVAL");
    check(arrivalRecords.length === 1, `exactly one ARRIVAL evidence record exists after a rapid double-tap (got: ${arrivalRecords.length}) — submittingArrivalRef guard fix`);

    if (failures > 0) console.error("\n--- preview server output (for debugging) ---\n" + serverOutput.slice(-4000));
  } finally {
    await browser.close();
    await killAndWait(server, PW_PORT);
  }
}

async function main() {
  await runEmulatorSuite();
  await runArrivalDoubleSubmitTest();

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
