// Investigation regression test (round 4c): production report is FO shows
// 7/9 evidence complete (Installation/Cable/Final captured with photos
// attached), Manager receives none of them, no Permission Denied error is
// ever shown, and the "changes waiting to upload" count just sits elevated.
// The prior round (installation-evidence-sync.regression.mjs) proved the
// FIRESTORE side of this (evidenceReadyToSync() blocks enqueue while any
// file isn't "uploaded") but could not exercise the REAL Supabase upload
// path, since Supabase is never configured in this environment and no test
// seam previously existed to control it.
//
// This file adds that seam (src/data/mediaOutbox.ts's
// __CITY_OPS_TEST_UPLOAD_EVIDENCE_FILE__ — mirrors the existing
// __CITY_OPS_TEST_BACKEND__ pattern, inert for real users) so
// drainMediaOutbox()'s REAL queue/concurrency/retry logic can be exercised
// deterministically, and uses it to test the specific hypothesis this round
// surfaced from reading that logic: drainMediaOutbox() processes queued
// uploads in a plain sequential `for...of` loop with `await upload(...)`
// inside — NOT Promise.all, and with no per-upload timeout of any kind. If
// one upload's promise never settles (a real possibility on a flaky mobile
// connection — neither the browser's fetch() nor, absent explicit
// configuration, the Supabase storage-js client enforce a timeout), every
// OTHER entry queued in that same pass is never even attempted, forever,
// with no error ever recorded (nothing failed — it simply never finished).
//
// Run with: npm run test:media-upload-concurrency

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4184;
const BASE_URL = `http://localhost:${PORT}`;
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

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE_URL);
      if (res.ok || res.status === 404) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error("Server did not become ready in time");
}

function killAndWait(child) {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill();
    setTimeout(resolve, 3000);
  }).then(() => {
    return new Promise((resolve) => {
      const fuser = spawn("fuser", ["-k", `${PORT}/tcp`]);
      fuser.on("exit", () => resolve());
      fuser.on("error", () => resolve());
      setTimeout(resolve, 2000);
    });
  });
}

// Standard mock Firestore backend — single emit at subscribe time (this
// file is about the MEDIA upload path, not the mergeRemoteCollection race
// already covered by installation-evidence-sync.regression.mjs's scenario
// [3], so the simpler non-reemitting mock avoids conflating the two).
const MOCK_BACKEND_INIT_SCRIPT = `
(function () {
  const MOCK_KEY = "__mock_firestore_store__";
  const CALLS_KEY = "__mock_put_doc_calls__";
  function readStore() {
    try { return JSON.parse(localStorage.getItem(MOCK_KEY) || "{}"); } catch { return {}; }
  }
  function writeStore(store) {
    localStorage.setItem(MOCK_KEY, JSON.stringify(store));
  }
  function readCalls() {
    try { return JSON.parse(localStorage.getItem(CALLS_KEY) || "[]"); } catch { return []; }
  }
  function appendCall(call) {
    const calls = readCalls();
    calls.push(call);
    localStorage.setItem(CALLS_KEY, JSON.stringify(calls));
  }
  window.__CITY_OPS_TEST_BACKEND__ = {
    async putDoc(collection, id, data) {
      appendCall({ collection, id, data, at: new Date().toISOString() });
      const store = readStore();
      store[collection] = store[collection] || {};
      store[collection][id] = { ...(store[collection][id] || {}), ...data };
      writeStore(store);
    },
    async deleteDoc(collection, id) {
      const store = readStore();
      if (store[collection]) delete store[collection][id];
      writeStore(store);
    },
    subscribeCollection(collection, cb, scope) {
      const OWNERSHIP_SCOPED = ["assignments", "sessions", "issues", "rigIncidents", "evidence"];
      const emit = () => {
        const store = readStore();
        let docs = Object.values(store[collection] || {});
        if (scope && scope.foId && OWNERSHIP_SCOPED.includes(collection)) docs = docs.filter((d) => d.foId === scope.foId);
        cb(docs);
      };
      emit();
      return () => {};
    },
  };
})();
`;

const FO_ID = "fo1";

const ONE_PX_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const AUTH_PROVIDER_INIT_SCRIPT = `
(function () {
  window.__CITY_OPS_TEST_AUTH_PROVIDER__ = {
    onChange(cb) {
      setTimeout(() => {
        cb({
          kind: "signed_in",
          user: { id: "test-fo-${FO_ID}", email: "test-fo@demo.city-ops", role: "FIELD_OFFICER", foId: "${FO_ID}", createdAt: new Date().toISOString() },
        });
      }, 0);
      return () => {};
    },
    async loginWithEmail() {
      return { ok: true };
    },
    async logout() {},
  };
})();
`;

// Test-only Supabase-upload seam (src/data/mediaOutbox.ts's
// __CITY_OPS_TEST_UPLOAD_EVIDENCE_FILE__). Behavior is configured per
// fileName (set BEFORE the file is attached via setInputFiles, so this
// object is read fresh on every upload attempt) via
// window.__TEST_UPLOAD_BEHAVIOR__[fileName] = { delayMs, fail, hang }.
// Every attempt (start/success/fail) is appended to
// localStorage["__test_upload_calls__"] with real Date.now() timestamps —
// the only way to prove whether uploads actually ran concurrently or were
// serialized, and whether a later one was ever even ATTEMPTED.
const UPLOAD_SEAM_INIT_SCRIPT = `
(function () {
  window.__TEST_UPLOAD_BEHAVIOR__ = {};
  function appendUploadCall(call) {
    const key = "__test_upload_calls__";
    const calls = JSON.parse(localStorage.getItem(key) || "[]");
    calls.push(call);
    localStorage.setItem(key, JSON.stringify(calls));
  }
  window.__CITY_OPS_TEST_UPLOAD_EVIDENCE_FILE__ = async function (params) {
    const cfg = (window.__TEST_UPLOAD_BEHAVIOR__ || {})[params.fileName] || {};
    appendUploadCall({ fileName: params.fileName, evidenceId: params.evidenceId, fileId: params.fileId, event: "start", at: Date.now() });
    if (cfg.hang) {
      // Never settles — models a real stalled fetch()/Supabase request that
      // never fires either a success or an error event.
      return new Promise(() => {});
    }
    if (cfg.delayMs) await new Promise((r) => setTimeout(r, cfg.delayMs));
    if (cfg.fail) {
      appendUploadCall({ fileName: params.fileName, evidenceId: params.evidenceId, fileId: params.fileId, event: "fail", at: Date.now() });
      const err = new Error(cfg.failMessage || "Simulated upload failure");
      err.statusCode = cfg.failStatus || "500";
      throw err;
    }
    appendUploadCall({ fileName: params.fileName, evidenceId: params.evidenceId, fileId: params.fileId, event: "success", at: Date.now() });
    return { storagePath: "test/" + params.evidenceId + "/" + params.fileId, downloadUrl: "https://example.test/" + params.evidenceId + "/" + params.fileId };
  };
})();
`;

async function seedCityDataAtInstallationStage(page, assignmentId) {
  await page.evaluate(
    ({ assignmentId, foId }) => {
      const now = new Date().toISOString();
      const today = now.slice(0, 10);
      const business = { id: "biz1", name: "Test Biz", category: "General", area: "Area", address: "", capacityHoursPerDay: 3, active: true, createdAt: now };
      const fo = { id: foId, name: "Test FO", active: true, createdAt: now };
      const rig = { id: "rig1", code: "R-1", model: "Test Rig", active: true, batteryPct: 100, storagePct: 0, deploymentStatus: "active", createdAt: now };
      const assignment = {
        id: assignmentId,
        date: today,
        businessId: business.id,
        foId,
        rigId: rig.id,
        plannedStart: `${today}T08:00:00.000Z`,
        plannedEnd: `${today}T11:00:00.000Z`,
        priority: "normal",
        status: "confirmed",
        actualArrivalAt: now,
        installationStartedAt: now,
        createdAt: now,
      };
      const locationEvidence = {
        id: "ev_location_" + assignmentId,
        assignmentId,
        businessId: business.id,
        foId,
        type: "LOCATION",
        startedAt: now,
        capturedAt: now,
        files: [],
        status: "submitted",
        createdAt: now,
      };
      const precheckEvidence = {
        id: "ev_precheck_" + assignmentId,
        assignmentId,
        businessId: business.id,
        foId,
        rigId: rig.id,
        type: "RIG_PRECHECK",
        startedAt: now,
        capturedAt: now,
        files: [],
        status: "submitted",
        metadata: { passed: true, checklist: {}, failedItems: [] },
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
        evidence: [locationEvidence, precheckEvidence],
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
      localStorage.setItem(
        "city-ops-auth",
        JSON.stringify({ id: "demo-fo-test-" + foId, email: "test-fo@demo.city-ops", role: "FIELD_OFFICER", displayName: "Test FO", foId, createdAt: now }),
      );
      const mockStore = {
        businesses: { [business.id]: business },
        fos: { [fo.id]: fo },
        rigs: { [rig.id]: rig },
        assignments: { [assignment.id]: assignment },
        evidence: { [locationEvidence.id]: locationEvidence, [precheckEvidence.id]: precheckEvidence },
      };
      localStorage.setItem("__mock_firestore_store__", JSON.stringify(mockStore));
    },
    { assignmentId, foId: FO_ID },
  );
}

async function setUploadBehavior(page, behaviorByFileName) {
  await page.evaluate((behavior) => {
    window.__TEST_UPLOAD_BEHAVIOR__ = behavior;
  }, behaviorByFileName);
}

async function getUploadCalls(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("__test_upload_calls__") || "[]"));
}

async function getLocalEvidence(page) {
  return page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("city-ops-os") || "{}").state?.evidence ?? [];
    } catch {
      return [];
    }
  });
}

async function getPutDocCalls(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("__mock_put_doc_calls__") || "[]"));
}

async function refetchEvidenceById(page, id) {
  const all = await getLocalEvidence(page);
  return all.find((e) => e.id === id);
}

/** Raw IndexedDB access (idb-keyval's default "keyval-store"/"keyval"
 * db/store, same as src/data/outbox.ts and src/data/mediaOutbox.ts use with
 * no custom store configured) — same technique as
 * installation-evidence-sync.regression.mjs's identically-named helper,
 * duplicated here so this file stays fully self-contained. Lists every key
 * (and its stored value) matching a prefix. */
async function listRawIndexedDbEntriesWithPrefix(page, prefix) {
  return page.evaluate(
    (prefix) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("keyval-store");
        req.onerror = () => resolve([]); // db doesn't exist yet — nothing queued
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("keyval")) {
            resolve([]);
            return;
          }
          const tx = db.transaction("keyval", "readonly");
          const store = tx.objectStore("keyval");
          const cursorReq = store.openCursor();
          const out = [];
          cursorReq.onerror = () => reject(cursorReq.error);
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) {
              resolve(out);
              return;
            }
            if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) out.push({ key: cursor.key, value: cursor.value });
            cursor.continue();
          };
        };
      }),
    prefix,
  );
}

/** Drives the real "Submit Installation" action: checks every checklist
 * item, attaches one distinctly-named photo to each of the three inputs
 * (Installation/Cable/Final), and clicks Submit. Returns the three
 * evidence records as they exist locally right after the click.
 *
 * CRITICAL ordering note: `behavior` is applied AFTER the last page
 * navigation (to `/fo`), never before — `page.goto()` tears down the JS
 * execution context and re-runs every `addInitScript`, including
 * UPLOAD_SEAM_INIT_SCRIPT's `window.__TEST_UPLOAD_BEHAVIOR__ = {}`. Setting
 * the behavior before that navigation silently wipes it back to empty
 * before a single upload is ever attempted — a real bug this test file hit
 * on its first draft, catching it only because scenario [A]'s assertions
 * happened to still pass by coincidence (empty behavior == immediate
 * success, indistinguishable from a working configured delay). */
async function submitInstallation(page, assignmentId, fileNames, behavior) {
  await page.goto(`${BASE_URL}/login`);
  await seedCityDataAtInstallationStage(page, assignmentId);
  await sleep(1000);

  await page.goto(`${BASE_URL}/fo`);
  await page.waitForSelector("text=Test Biz", { timeout: 15000 });
  await page.click("text=Test Biz");
  await page.waitForSelector("text=INSTALLATION", { timeout: 15000 });
  if (behavior) await setUploadBehavior(page, behavior);

  for (const cb of await page.getByRole("checkbox").all()) await cb.click();
  const fileInputs = await page.locator('input[type="file"]').all();
  for (let i = 0; i < fileInputs.length; i++) {
    await fileInputs[i].setInputFiles({ name: fileNames[i], mimeType: "image/png", buffer: Buffer.from(ONE_PX_PNG_BASE64, "base64") });
  }
  await sleep(400);
  await page.getByRole("button", { name: "Submit Installation" }).click();
  await sleep(500); // let the three synchronous captureStepEvidence() calls settle

  const evidence = await getLocalEvidence(page);
  return {
    install: evidence.find((e) => e.type === "INSTALLATION"),
    cable: evidence.find((e) => e.type === "CABLE_SETUP"),
    final: evidence.find((e) => e.type === "FINAL_SETUP"),
  };
}

async function main() {
  console.log("Building production bundle...");
  await new Promise((resolve, reject) => {
    const build = spawn("npm", ["run", "build"], { cwd: process.cwd(), stdio: "inherit" });
    build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build failed with code ${code}`))));
  });

  console.log("Serving production build via `vite preview`...");
  const server = spawn(VITE_BIN, ["preview", "--port", String(PORT), "--strictPort"], { cwd: process.cwd(), stdio: "pipe" });
  let serverOutput = "";
  server.stdout.on("data", (d) => (serverOutput += d.toString()));
  server.stderr.on("data", (d) => (serverOutput += d.toString()));

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  try {
    await waitForServer();

    // ------------------------------------------------------------------
    console.log("\n[A] Baseline: a single evidence photo upload succeeds end to end (store -> media outbox -> Supabase seam -> Firestore):");
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.addInitScript(MOCK_BACKEND_INIT_SCRIPT);
      await page.addInitScript(AUTH_PROVIDER_INIT_SCRIPT);
      await page.addInitScript(UPLOAD_SEAM_INIT_SCRIPT);
      const { install, cable, final } = await submitInstallation(page, "asg_A", ["solo.png", "solo-cable.png", "solo-final.png"], {
        "solo.png": { delayMs: 50 },
        "solo-cable.png": { delayMs: 50 },
        "solo-final.png": { delayMs: 50 },
      });
      await sleep(1500);
      const evidenceAfter = await getLocalEvidence(page);
      const allUploaded = [install, cable, final].every((e) => {
        const cur = evidenceAfter.find((x) => x.id === e.id);
        return cur && cur.files.every((f) => f.uploadStatus === "uploaded");
      });
      check(allUploaded, "all three files reach uploadStatus 'uploaded' when nothing is misbehaving");
      const putCalls = await getPutDocCalls(page);
      const synced = [install, cable, final].every((e) => putCalls.some((c) => c.collection === "evidence" && c.id === e.id));
      check(synced, "all three evidence records reach the Firestore mock backend once their uploads succeed");
      await context.close();
    }

    // ------------------------------------------------------------------
    console.log(
      "\n[B/C/D] Three simultaneous evidence photo uploads (Installation/Cable/Final, exactly as production captures them), " +
        "with Installation's upload HANGING (never resolving or rejecting — models a real stalled mobile-network request). " +
        "NOTE: whether Cable/Final's own drainMediaOutbox() calls land in the SAME pass as Installation's (and so get stuck " +
        "behind it) or in an EARLIER/separate pass (and so complete fine) depends on the exact Promise/microtask interleaving " +
        "of three independent async chains — this is a genuine, non-deterministic RACE, not a fixed outcome. This scenario " +
        "reports what actually happened rather than asserting one specific interleaving; scenario [D2] below proves the " +
        "underlying blocking mechanism deterministically, with the race removed.",
    );
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.addInitScript(MOCK_BACKEND_INIT_SCRIPT);
      await page.addInitScript(AUTH_PROVIDER_INIT_SCRIPT);
      await page.addInitScript(UPLOAD_SEAM_INIT_SCRIPT);
      const initial = await submitInstallation(page, "asg_B", ["install-hang.png", "cable-ok.png", "final-ok.png"], {
        "install-hang.png": { hang: true },
        "cable-ok.png": { delayMs: 20 },
        "final-ok.png": { delayMs: 20 },
      });
      await sleep(2000); // generous settle time — long enough that a NON-blocked cable/final would have finished by now
      const installEv = await refetchEvidenceById(page, initial.install.id);
      const cableEv = await refetchEvidenceById(page, initial.cable.id);
      const finalEv = await refetchEvidenceById(page, initial.final.id);

      const uploadCalls = await getUploadCalls(page);
      const cableAttempted = uploadCalls.some((c) => c.fileName === "cable-ok.png" && c.event === "start");
      const finalAttempted = uploadCalls.some((c) => c.fileName === "final-ok.png" && c.event === "start");

      check(!!installEv && !!cableEv && !!finalEv, "(setup) all three evidence records were created locally");
      check(
        installEv.files[0].uploadStatus === "uploading",
        `Installation's file is stuck at 'uploading' (the hung upload) — got '${installEv?.files?.[0]?.uploadStatus}'`,
      );
      console.log(
        `  OBSERVED (this run): cable attempted=${cableAttempted} final attempted=${finalAttempted} — ` +
          "either outcome is a valid, self-consistent interleaving; see [D2] for the deterministic proof",
      );
      // Whichever way the race went, the result must be internally
      // consistent in the one direction the local uploadStatus field can
      // actually prove: reaching 'uploaded' REQUIRES having been attempted
      // and having succeeded (the reverse doesn't hold — enqueueMediaUpload()
      // flips status to 'uploading' at enqueue time, before drainMediaOutbox()
      // ever runs, so 'uploading' alone can't distinguish "not yet attempted"
      // from "attempted and now stuck" — that ambiguity is exactly what
      // scenario [D2] below removes).
      const cableCur = cableEv.files[0].uploadStatus;
      const finalCur = finalEv.files[0].uploadStatus;
      check(
        (cableCur !== "uploaded" || cableAttempted) && (finalCur !== "uploaded" || finalAttempted),
        `local upload-status state is internally consistent with the attempt log (cable: attempted=${cableAttempted} status=${cableCur}; final: attempted=${finalAttempted} status=${finalCur})`,
      );
      const putCallsHang = await getPutDocCalls(page);
      check(
        !putCallsHang.some((c) => c.collection === "evidence" && c.id === installEv.id),
        "Installation itself never reaches the Firestore mock backend (its upload never finished) — this part IS deterministic regardless of the race",
      );
      check(
        putCallsHang.some((c) => c.collection === "evidence" && c.id === cableEv.id) === (cableCur === "uploaded") &&
          putCallsHang.some((c) => c.collection === "evidence" && c.id === finalEv.id) === (finalCur === "uploaded"),
        "Cable/Final reach Firestore if and only if their own upload actually completed — no partial/inconsistent sync",
      );
      await context.close();
    }

    // ------------------------------------------------------------------
    console.log(
      "\n[D2] THE FIX: with the 3-way capture race removed (two SEPARATE, sequential, single-photo RIG_PRECHECK submissions " +
        "on two different assignments), an upload that hangs forever must now TIME OUT (via the test-only " +
        "__CITY_OPS_TEST_UPLOAD_TIMEOUT_MS__ override — production always uses the real 30s UPLOAD_TIMEOUT_MS) instead of " +
        "blocking the device's entire media queue forever. Proves: the hung entry is marked failed/upload-timeout and stays " +
        "retryable; a later, unrelated upload IS attempted and can still succeed; the drain is never permanently stuck; a " +
        "retry of the timed-out entry succeeds with no duplicate upload.",
    );
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.addInitScript(MOCK_BACKEND_INIT_SCRIPT);
      await page.addInitScript(AUTH_PROVIDER_INIT_SCRIPT);
      await page.addInitScript(UPLOAD_SEAM_INIT_SCRIPT);

      await page.goto(`${BASE_URL}/login`);
      await page.evaluate(
        ({ foId }) => {
          const now = new Date().toISOString();
          const today = now.slice(0, 10);
          const fo = { id: foId, name: "Test FO", active: true, createdAt: now };
          const rig = { id: "rig1", code: "R-1", model: "Test Rig", active: true, batteryPct: 100, storagePct: 0, deploymentStatus: "active", createdAt: now };
          function biz(id, name) {
            return { id, name, category: "General", area: "Area", address: "", capacityHoursPerDay: 3, active: true, createdAt: now };
          }
          function asg(id, businessId) {
            return {
              id,
              date: today,
              businessId,
              foId,
              rigId: rig.id,
              plannedStart: `${today}T08:00:00.000Z`,
              plannedEnd: `${today}T11:00:00.000Z`,
              priority: "normal",
              status: "confirmed",
              actualArrivalAt: now,
              createdAt: now,
            };
          }
          function locationEv(id, assignmentId, businessId) {
            return { id, assignmentId, businessId, foId, type: "LOCATION", startedAt: now, capturedAt: now, files: [], status: "submitted", createdAt: now };
          }
          const b1 = biz("biz_d2a", "Test Biz D2A");
          const b2 = biz("biz_d2b", "Test Biz D2B");
          const a1 = asg("asg_d2a", b1.id);
          const a2 = asg("asg_d2b", b2.id);
          const cityData = {
            version: 2,
            settings: { cityName: "Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
            businesses: [b1, b2],
            fos: [fo],
            collectors: [],
            rigs: [rig],
            assignments: [a1, a2],
            sessions: [],
            evidence: [locationEv("ev_loc_d2a", a1.id, b1.id), locationEv("ev_loc_d2b", a2.id, b2.id)],
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
          localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-fo-test-" + foId, email: "test-fo@demo.city-ops", role: "FIELD_OFFICER", displayName: "Test FO", foId, createdAt: now }));
          localStorage.setItem(
            "__mock_firestore_store__",
            JSON.stringify({
              businesses: { [b1.id]: b1, [b2.id]: b2 },
              fos: { [fo.id]: fo },
              rigs: { [rig.id]: rig },
              assignments: { [a1.id]: a1, [a2.id]: a2 },
              evidence: { ev_loc_d2a: cityData.evidence[0], ev_loc_d2b: cityData.evidence[1] },
            }),
          );
        },
        { foId: FO_ID },
      );
      await sleep(1000);

      await page.goto(`${BASE_URL}/fo`);
      await page.waitForSelector("text=Test Biz D2A", { timeout: 15000 });
      await page.click("text=Test Biz D2A");
      await page.waitForSelector("text=Submit Precheck", { timeout: 15000 });
      // Short timeout ONLY in this test context — never changes the real
      // production UPLOAD_TIMEOUT_MS (30s), which withUploadTimeout() in
      // src/data/mediaOutbox.ts falls back to whenever this seam is absent.
      await page.evaluate(() => {
        window.__CITY_OPS_TEST_UPLOAD_TIMEOUT_MS__ = 500;
      });
      await setUploadBehavior(page, { "d2-hang.png": { hang: true }, "d2-ok.png": { delayMs: 20 } });
      // Check every checklist item so precheck PASSES cleanly — a FAILED
      // precheck flags the RIG (not just this assignment) as unsafe via
      // reportRigIncident(), which would also block the second assignment
      // below since both share the same seeded rig. Not what this scenario
      // is testing.
      for (const cb of await page.getByRole("checkbox").all()) await cb.click();
      await page.locator('input[type="file"]').first().setInputFiles({ name: "d2-hang.png", mimeType: "image/png", buffer: Buffer.from(ONE_PX_PNG_BASE64, "base64") });
      await sleep(300);
      await page.getByRole("button", { name: "Submit Precheck" }).click();

      // Wait until the upload log actually shows the hang has STARTED —
      // proves the queue is now genuinely occupied before we ever create
      // the second entry, removing all ambiguity about interleaving.
      let hangStarted = false;
      for (let i = 0; i < 20; i++) {
        const calls = await getUploadCalls(page);
        if (calls.some((c) => c.fileName === "d2-hang.png" && c.event === "start")) {
          hangStarted = true;
          break;
        }
        await sleep(100);
      }
      check(hangStarted, "(setup) confirmed the hung upload actually started before the second, unrelated assignment's photo is even created");

      const evidenceBeforeB = await getLocalEvidence(page);
      const firstEv = evidenceBeforeB.find((e) => e.type === "RIG_PRECHECK" && e.assignmentId === "asg_d2a");

      await page.locator("header button").first().click(); // back arrow (ChevronLeft) to the Today list (setSelected(null)) — always the first header button when an assignment is selected
      await page.waitForSelector("text=Test Biz D2B", { timeout: 15000 });
      await page.click("text=Test Biz D2B");
      await page.waitForSelector("text=Submit Precheck", { timeout: 15000 });
      for (const cb of await page.getByRole("checkbox").all()) await cb.click();
      await page.locator('input[type="file"]').first().setInputFiles({ name: "d2-ok.png", mimeType: "image/png", buffer: Buffer.from(ONE_PX_PNG_BASE64, "base64") });
      await sleep(300);
      await page.getByRole("button", { name: "Submit Precheck" }).click();
      // Wait comfortably past the 500ms test timeout so it has definitely
      // fired and the drain has had a chance to continue to D2B's entry.
      await sleep(2000);

      // --- A/C/D: the hung entry times out; the later, unrelated entry IS attempted and succeeds ---
      const uploadCallsD2 = await getUploadCalls(page);
      const secondAttempted = uploadCallsD2.some((c) => c.fileName === "d2-ok.png" && c.event === "start");
      const secondSucceeded = uploadCallsD2.some((c) => c.fileName === "d2-ok.png" && c.event === "success");
      check(
        secondAttempted,
        "FIX CONFIRMED (C): once the hung entry times out, a photo queued strictly after it IS attempted — the drain is no longer stuck forever",
      );
      check(secondSucceeded, "FIX CONFIRMED (D): the later, unrelated upload completes successfully");

      let evidenceD2 = await getLocalEvidence(page);
      const secondEv = evidenceD2.find((e) => e.type === "RIG_PRECHECK" && e.assignmentId === "asg_d2b");
      check(!!secondEv && secondEv.files[0].uploadStatus === "uploaded", `the second assignment's own evidence reaches 'uploaded' (got '${secondEv?.files?.[0]?.uploadStatus}')`);
      const putCallsD2 = await getPutDocCalls(page);
      check(
        putCallsD2.some((c) => c.collection === "evidence" && c.id === secondEv?.id),
        "FIX CONFIRMED (E/F): the second assignment's evidence reaches the Firestore mock backend — the drain is not permanently stuck, it eventually exits and moves on",
      );

      // --- A: the hung entry itself is marked failed/timeout, with the correct FO-safe error ---
      const firstEvAfter = evidenceD2.find((e) => e.id === firstEv.id);
      check(
        firstEvAfter?.files?.[0]?.uploadStatus === "upload_failed",
        `FIX CONFIRMED (A): the hung entry is marked 'upload_failed' once its timeout fires (got '${firstEvAfter?.files?.[0]?.uploadStatus}')`,
      );
      check(
        firstEvAfter?.files?.[0]?.uploadErrorCode === "upload-timeout",
        `the timed-out entry carries the distinct, machine-readable error code 'upload-timeout' (got '${firstEvAfter?.files?.[0]?.uploadErrorCode}')`,
      );
      check(
        firstEvAfter?.files?.[0]?.uploadErrorReason === "Photo upload timed out. It will be retried when the connection is available.",
        `the FO-safe error message matches the requested wording (got '${firstEvAfter?.files?.[0]?.uploadErrorReason}')`,
      );
      check(
        !putCallsD2.some((c) => c.collection === "evidence" && c.id === firstEv.id),
        "the timed-out entry's own evidence is correctly never marked synced/sent to Firestore — never silently marked successful",
      );

      // --- B: the timed-out entry remains retryable (still queued, not deleted) ---
      const mediaOutboxEntries = await listRawIndexedDbEntriesWithPrefix(page, "mediaOutbox:");
      check(
        mediaOutboxEntries.some((e) => e.key.includes(firstEv.id)),
        "FIX CONFIRMED (B): the timed-out entry's media outbox entry is still present (never deleted on timeout) — it remains retryable",
      );

      // --- G: retrying the timed-out entry (once the underlying condition is fixed) succeeds, with no duplicate upload ---
      await page.evaluate(() => {
        window.__TEST_UPLOAD_BEHAVIOR__ = { "d2-hang.png": { delayMs: 20 } };
      });
      const retryBtn = page.getByRole("button", { name: /retry/i });
      if (await retryBtn.count()) {
        await retryBtn.first().click();
      } else {
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
      }
      await sleep(1000);

      evidenceD2 = await getLocalEvidence(page);
      const firstEvRetried = evidenceD2.find((e) => e.id === firstEv.id);
      check(
        firstEvRetried?.files?.[0]?.uploadStatus === "uploaded",
        `FIX CONFIRMED (G): retrying the timed-out entry succeeds once the underlying condition is fixed (got '${firstEvRetried?.files?.[0]?.uploadStatus}')`,
      );
      check(!firstEvRetried?.files?.[0]?.uploadErrorCode, "the retried entry's error fields are cleared on success");

      const uploadCallsAfterRetry = await getUploadCalls(page);
      const hangFileSuccesses = uploadCallsAfterRetry.filter((c) => c.fileName === "d2-hang.png" && c.event === "success");
      // NOTE: this entry may legitimately be RE-ATTEMPTED more than once
      // before it finally succeeds — every drain trigger anywhere on the
      // device (D2B's own submit, an "online" event, etc.) naturally
      // re-attempts any still-queued entry, exactly as documented in this
      // file's own drainMediaOutbox() comment ("a later call to this same
      // function... re-attempts the identical entry"). That's correct,
      // idempotent retry-until-success behavior, not a duplicate — the
      // real "no duplicate upload" invariant is that it never reports
      // 'success' more than once (which would mean it kept uploading after
      // already finishing) and never writes more than one Firestore
      // document for it (checked separately below).
      check(
        hangFileSuccesses.length === 1,
        `no duplicate upload occurred because of the timeout handling — the entry reports 'success' exactly once (got ${hangFileSuccesses.length})`,
      );
      const putCallsAfterRetry = await getPutDocCalls(page);
      const firstEvPutCalls = putCallsAfterRetry.filter((c) => c.collection === "evidence" && c.id === firstEv.id);
      check(firstEvPutCalls.length === 1, `exactly one Firestore putDoc call for the retried entry — no duplicate evidence write (got ${firstEvPutCalls.length})`);

      await context.close();
    }

    // ------------------------------------------------------------------
    console.log("\n[E] One upload genuinely fails (not hangs) — is the failure recorded, and does it still block later entries in the SAME pass?");
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.addInitScript(MOCK_BACKEND_INIT_SCRIPT);
      await page.addInitScript(AUTH_PROVIDER_INIT_SCRIPT);
      await page.addInitScript(UPLOAD_SEAM_INIT_SCRIPT);
      const initialE = await submitInstallation(
        page,
        "asg_E",
        ["install-fail.png", "cable-after-fail.png", "final-after-fail.png"],
        {
          "install-fail.png": { fail: true, failStatus: "500", failMessage: "Simulated Supabase 500" },
          "cable-after-fail.png": { delayMs: 20 },
          "final-after-fail.png": { delayMs: 20 },
        },
      );
      await sleep(1500);
      const installEv = await refetchEvidenceById(page, initialE.install.id);
      const cableEv = await refetchEvidenceById(page, initialE.cable.id);
      const finalEv = await refetchEvidenceById(page, initialE.final.id);

      check(installEv.files[0].uploadStatus === "upload_failed", "Installation's file is correctly marked 'upload_failed' (a REAL rejection, unlike the hang case)");
      check(!!installEv.files[0].uploadErrorCode, `an error code was recorded for the failed upload (got '${installEv.files[0].uploadErrorCode}')`);

      const uploadCallsFail = await getUploadCalls(page);
      const cableAttemptedAfterFail = uploadCallsFail.some((c) => c.fileName === "cable-after-fail.png" && c.event === "start");
      const finalAttemptedAfterFail = uploadCallsFail.some((c) => c.fileName === "final-after-fail.png" && c.event === "start");
      check(
        cableAttemptedAfterFail && finalAttemptedAfterFail,
        "UNLIKE the hang case: a genuine failure (reject, not a never-settling promise) does NOT block later entries in the same pass — the for-loop's catch block lets it continue to the next key",
      );
      check(
        cableEv.files[0].uploadStatus === "uploaded" && finalEv.files[0].uploadStatus === "uploaded",
        "Cable Setup and Final Setup still succeed despite Installation's genuine failure",
      );

      const putCallsFail = await getPutDocCalls(page);
      check(
        putCallsFail.some((c) => c.collection === "evidence" && c.id === cableEv.id) && putCallsFail.some((c) => c.collection === "evidence" && c.id === finalEv.id),
        "Cable Setup and Final Setup still reach the Firestore mock backend even though Installation's upload failed",
      );
      check(
        !putCallsFail.some((c) => c.collection === "evidence" && c.id === installEv.id),
        "Installation itself correctly never reaches Firestore (its own file never finished uploading)",
      );

      console.log("\n[G] Retry after failure: fixing the seam and re-draining recovers the failed entry:");
      await page.evaluate(() => {
        window.__TEST_UPLOAD_BEHAVIOR__ = { "install-fail.png": { delayMs: 20 } };
      });
      // Drive the actual retry button if the UI exposes one; otherwise fall
      // back to the same trigger useMediaSyncStatus().retry() ultimately
      // relies on (an "online" event re-drains the queue).
      const retryBtn = page.getByRole("button", { name: /retry/i });
      if (await retryBtn.count()) {
        await retryBtn.first().click();
      } else {
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
      }
      await sleep(1000);
      const evidenceAfterRetry = await getLocalEvidence(page);
      const installAfterRetry = evidenceAfterRetry.find((e) => e.id === installEv.id);
      check(
        installAfterRetry?.files?.[0]?.uploadStatus === "uploaded",
        `retry recovers the previously-failed entry once the underlying condition is fixed (got '${installAfterRetry?.files?.[0]?.uploadStatus}')`,
      );
      const putCallsRetry = await getPutDocCalls(page);
      check(putCallsRetry.some((c) => c.collection === "evidence" && c.id === installEv.id), "Installation now reaches Firestore after the successful retry");

      await context.close();
    }

    if (failures > 0) console.error("\n--- preview server output (for debugging) ---\n" + serverOutput.slice(-4000));
  } finally {
    await browser.close();
    await killAndWait(server);
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
