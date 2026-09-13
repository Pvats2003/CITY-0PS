// Investigation regression test: production observation after deploying
// 47222c4 (the legacy rigIncidents outbox-orphan quarantine fix) — a fresh
// RIG PRECHECK evidence record (with its photo) successfully reached
// Manager Evidence Review, but the SAME visit never progressed past that in
// Manager (stuck at 4/9 evidence slots: Installation, Cable Setup, Final
// Setup, Session completion, and the completion photo all missing).
//
// The one structural difference this test isolates: FOExecution.tsx's
// "installation" stage (src/pages/FOExecution.tsx, the `if (stage ===
// "installation")` block) fires THREE separate captureStepEvidence() calls
// back-to-back, synchronously, from a single "Submit Installation" button
// click — one each for INSTALLATION, CABLE_SETUP, and FINAL_SETUP — unlike
// every earlier stage (ARRIVAL, LOCATION, RIG_PRECHECK), which each submit
// exactly one evidence record per user action.
//
// Real Supabase upload timing cannot be exercised in this environment (no
// live Supabase project — see test:supabase-media-storage's own note on
// this same limitation), so this test isolates the STORE -> OUTBOX ->
// BACKEND layer specifically: it drives the real "Submit Installation" UI
// action to create all three evidence records for real, then simulates
// each photo's upload finishing (the same store mutation
// src/data/mediaOutbox.ts's setFileUploadStatus() performs) to trigger
// src/data/syncEngine.ts's real watcher/enqueueEvidenceOnce() path for all
// three, and inspects exactly what reaches the mock Firestore backend.
//
// Run with: npm run test:installation-evidence-sync

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4183;
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

// Extends assignment-partial-patch.regression.mjs's own mock backend with
// ONE behavioral addition this investigation specifically needs: a REAL
// Firestore onSnapshot listener re-fires on every subsequent write to the
// collection it's watching (including the FO's own writes echoing back
// once the server acks them) — not just once at subscribe time. The other
// mock backend never needed this (nothing in its scenarios depended on a
// SECOND snapshot arriving), so it only ever emits once. This file's whole
// purpose is testing what happens when a second "evidence" snapshot arrives
// while a just-captured, not-yet-uploaded evidence record is still sitting
// local-only — so the mock must actually behave like onSnapshot here.
const MOCK_BACKEND_INIT_SCRIPT = `
(function () {
  const MOCK_KEY = "__mock_firestore_store__";
  const CALLS_KEY = "__mock_put_doc_calls__";
  const listeners = {}; // collection -> Set<{ cb, scope }>
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
  const OWNERSHIP_SCOPED = ["assignments", "sessions", "issues", "rigIncidents", "evidence"];
  function emitTo(collection, cb, scope) {
    const store = readStore();
    let docs = Object.values(store[collection] || {});
    if (scope && scope.foId && OWNERSHIP_SCOPED.includes(collection)) docs = docs.filter((d) => d.foId === scope.foId);
    cb(docs);
  }
  function notifyCollection(collection) {
    for (const { cb, scope } of listeners[collection] || []) emitTo(collection, cb, scope);
  }
  window.__CITY_OPS_TEST_BACKEND__ = {
    async putDoc(collection, id, data) {
      appendCall({ collection, id, data, at: new Date().toISOString() });
      const store = readStore();
      store[collection] = store[collection] || {};
      store[collection][id] = { ...(store[collection][id] || {}), ...data };
      writeStore(store);
      // Real onSnapshot fires again once the server acks this write —
      // simulate that round trip for every OTHER subscriber of the same
      // collection (this is what re-triggers mergeRemoteCollection()).
      notifyCollection(collection);
    },
    async deleteDoc(collection, id) {
      const store = readStore();
      if (store[collection]) delete store[collection][id];
      writeStore(store);
      notifyCollection(collection);
    },
    subscribeCollection(collection, cb, scope) {
      listeners[collection] = listeners[collection] || new Set();
      const entry = { cb, scope };
      listeners[collection].add(entry);
      emitTo(collection, cb, scope);
      return () => listeners[collection].delete(entry);
    },
  };
  // Test-only escape hatch: force a synthetic re-snapshot of one collection
  // without any real write, so the test can simulate "some OTHER evidence
  // document changed and the FO's own onSnapshot listener re-fired" without
  // needing an actual second document.
  window.__TEST_FORCE_RESNAPSHOT__ = notifyCollection;
})();
`;

const FO_ID = "fo1";
const ASG_ID = "asg_installation_sync_test";

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

/** Seeds an assignment already at the "installation" stage: arrived,
 * LOCATION evidence present, a PASSED RIG_PRECHECK evidence present, and
 * assignment.installationStartedAt already set — deriveExecutionStage()
 * (src/engine/execution.ts) lands this directly on FOExecution.tsx's
 * `stage === "installation"` screen (checklist + three photo inputs +
 * "Submit Installation") without needing to drive the arrival/location/
 * precheck screens first, which are already proven working elsewhere
 * (evidence-capture-fix.regression.mjs, assignment-partial-patch's [5]). */
async function seedCityDataAtInstallationStage(page) {
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
        id: "ev_location_install_test",
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
        id: "ev_precheck_install_test",
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
    { assignmentId: ASG_ID, foId: FO_ID },
  );
}

async function getPutDocCalls(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("__mock_put_doc_calls__") || "[]"));
}

/** Raw IndexedDB access (idb-keyval's default "keyval-store"/"keyval"
 * db/store, same as src/data/outbox.ts and src/data/mediaOutbox.ts use with
 * no custom store configured) — same technique as assignment-partial-patch
 * .regression.mjs's readRawOutboxEntry(), generalized to list every key
 * (and its stored value) matching a prefix, so this test can directly
 * inspect what's actually sitting in the Firestore outbox and the media
 * outbox without needing a rendered UI (the diagnostic panel this round
 * added, src/components/FoDiagnosticPanel.tsx's "Outbox queue" section,
 * only renders when import.meta.env.DEV is true — never in this file's
 * production preview build — see src/lib/diagnosticsAccess.ts). */
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

    console.log("\n[1] Driving the REAL 'Submit Installation' action (three synchronous captureStepEvidence() calls) then simulating all three photo uploads finishing:");
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(MOCK_BACKEND_INIT_SCRIPT);
    await page.addInitScript(AUTH_PROVIDER_INIT_SCRIPT);
    const pageErrors = [];
    page.on("pageerror", (err) => {
      pageErrors.push(err.stack || err.message);
      console.error("  [page error]", err.stack || err.message);
    });

    await page.goto(`${BASE_URL}/login`);
    await seedCityDataAtInstallationStage(page);
    await sleep(1000); // let the /login page's own harmless boot settle, same reasoning as the other regression files

    await page.goto(`${BASE_URL}/fo`);
    await page.waitForSelector("text=Test Biz", { timeout: 15000 });
    await page.click("text=Test Biz");
    await page.waitForSelector("text=INSTALLATION", { timeout: 15000 });

    // Check every checklist item (5 critical + 1 non-critical) — the
    // Submit Installation button requires allCriticalDone, unlike Submit
    // Precheck, which allows submission either way.
    const checkboxes = await page.getByRole("checkbox").all();
    for (const cb of checkboxes) await cb.click();

    const fileInputs = await page.locator('input[type="file"]').all();
    check(fileInputs.length === 3, `sanity check: three separate photo inputs are present (Installation/Cable/Final) — got ${fileInputs.length}`);
    for (const input of fileInputs) {
      await input.setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: Buffer.from(ONE_PX_PNG_BASE64, "base64") });
    }
    await sleep(400); // durable stash (IndexedDB) + onChange to settle, same as other regression files

    const submitBtn = page.getByRole("button", { name: "Submit Installation" });
    check(!(await submitBtn.isDisabled()), "Submit Installation is enabled once the checklist and all three photos are complete");
    await submitBtn.click();
    await sleep(800); // let the three synchronous captureStepEvidence() calls' store mutations settle

    const evidenceAfterSubmit = await page.evaluate(() => {
      const raw = localStorage.getItem("city-ops-os");
      if (!raw) return [];
      try {
        return JSON.parse(raw).state.evidence;
      } catch {
        return [];
      }
    });
    const installEv = evidenceAfterSubmit.find((e) => e.type === "INSTALLATION");
    const cableEv = evidenceAfterSubmit.find((e) => e.type === "CABLE_SETUP");
    const finalEv = evidenceAfterSubmit.find((e) => e.type === "FINAL_SETUP");
    check(!!installEv && !!cableEv && !!finalEv, "all three evidence records (INSTALLATION/CABLE_SETUP/FINAL_SETUP) were created locally by the single Submit Installation click");

    // Real Supabase upload timing can't be exercised in this environment
    // (no live Supabase project configured) — simulate all three uploads
    // finishing in quick, overlapping succession via the
    // __CITY_OPS_TEST_SET_FILE_UPLOAD_STATUS__ test seam (src/data/
    // mediaOutbox.ts), which performs the EXACT SAME store mutation a real
    // successful upload does, driving the actual watcher/
    // enqueueEvidenceOnce() code path for all three at once.
    const fileTargets = [installEv, cableEv, finalEv]
      .filter(Boolean)
      .flatMap((ev) => ev.files.map((f) => ({ evidenceId: ev.id, fileId: f.id })));
    check(fileTargets.length === 3, `sanity check: exactly one file per new evidence record to simulate uploaded — got ${fileTargets.length}`);

    await page.evaluate((targets) => {
      for (const { evidenceId, fileId } of targets) {
        window.__CITY_OPS_TEST_SET_FILE_UPLOAD_STATUS__(evidenceId, fileId, {
          uploadStatus: "uploaded",
          storagePath: `test/${evidenceId}/${fileId}`,
          downloadUrl: `https://example.test/${evidenceId}/${fileId}`,
        });
      }
    }, fileTargets);
    await sleep(800); // let the local watcher's enqueue + drainOutbox settle

    console.log("\n[2] Inspecting what actually reached the mock Firestore backend for the 'evidence' collection:");
    const putCalls = await getPutDocCalls(page);
    const evidencePuts = putCalls.filter((c) => c.collection === "evidence");
    const installPut = evidencePuts.find((c) => c.id === installEv?.id);
    const cablePut = evidencePuts.find((c) => c.id === cableEv?.id);
    const finalPut = evidencePuts.find((c) => c.id === finalEv?.id);
    check(!!installPut, `INSTALLATION evidence (${installEv?.id}) reached the backend via putDoc`);
    check(!!cablePut, `CABLE_SETUP evidence (${cableEv?.id}) reached the backend via putDoc`);
    check(!!finalPut, `FINAL_SETUP evidence (${finalEv?.id}) reached the backend via putDoc`);
    check(
      !!installPut && installPut.data.foId === FO_ID && installPut.data.assignmentId === ASG_ID,
      "INSTALLATION evidence carries foId + assignmentId in its synced payload",
    );

    // Confirm the mock backend's own store (what a live Manager onSnapshot
    // read would see) actually retains all three documents — proves this
    // isn't just an attempted-but-rejected putDoc call.
    const mockStoreAfter = await page.evaluate(() => JSON.parse(localStorage.getItem("__mock_firestore_store__") || "{}"));
    const storedEvidenceIds = Object.keys(mockStoreAfter.evidence || {});
    check(
      !!installEv && storedEvidenceIds.includes(installEv.id) && !!cableEv && storedEvidenceIds.includes(cableEv.id) && !!finalEv && storedEvidenceIds.includes(finalEv.id),
      "all three evidence documents are present in the mock backend's stored state (what Manager's query would read)",
    );

    if (pageErrors.length > 0) check(false, `no uncaught page errors occurred (saw ${pageErrors.length}): ${pageErrors[0]}`);

    console.log(
      "\n[3] Reproducing the ACTUAL production failure: an unrelated 'evidence' collection snapshot arriving " +
        "WHILE the three just-captured Installation/Cable/Final records are still local-only (their photo " +
        "uploads have not finished yet) — src/store/city.ts's mergeRemoteCollection() is a full REPLACE " +
        "(`state.evidence = docs`), not a merge, and src/data/syncEngine.ts's remote listener for 'evidence' " +
        "re-fires on every write to that collection (including this FO's own writes echoing back once " +
        "Firestore acks them) — not just once at subscribe time:",
    );
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await page2.addInitScript(MOCK_BACKEND_INIT_SCRIPT);
    await page2.addInitScript(AUTH_PROVIDER_INIT_SCRIPT);
    const pageErrors2 = [];
    page2.on("pageerror", (err) => {
      pageErrors2.push(err.stack || err.message);
      console.error("  [page error]", err.stack || err.message);
    });

    await page2.goto(`${BASE_URL}/login`);
    await seedCityDataAtInstallationStage(page2);
    await sleep(1000);

    await page2.goto(`${BASE_URL}/fo`);
    await page2.waitForSelector("text=Test Biz", { timeout: 15000 });
    await page2.click("text=Test Biz");
    await page2.waitForSelector("text=INSTALLATION", { timeout: 15000 });

    for (const cb of await page2.getByRole("checkbox").all()) await cb.click();
    for (const input of await page2.locator('input[type="file"]').all()) {
      await input.setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: Buffer.from(ONE_PX_PNG_BASE64, "base64") });
    }
    await sleep(400);
    await page2.getByRole("button", { name: "Submit Installation" }).click();
    await sleep(800); // three evidence records now exist locally, uploadStatus "local_only" — NOT yet ready to sync

    const beforeResnapshot = await page2.evaluate(() => JSON.parse(localStorage.getItem("city-ops-os") || "{}").state?.evidence ?? []);
    const install2 = beforeResnapshot.find((e) => e.type === "INSTALLATION");
    const cable2 = beforeResnapshot.find((e) => e.type === "CABLE_SETUP");
    const final2 = beforeResnapshot.find((e) => e.type === "FINAL_SETUP");
    check(!!install2 && !!cable2 && !!final2, "(setup) all three evidence records exist locally, pre-upload, before the synthetic resnapshot");

    // Simulate an unrelated evidence-collection change on the server (e.g.
    // the RIG_PRECHECK evidence this same FO submitted minutes earlier
    // being re-confirmed by Firestore, or literally any other evidence
    // document changing) causing THIS FO's own 'evidence' onSnapshot
    // listener to re-fire — completely normal, expected Firestore behavior,
    // not itself a bug.
    await page2.evaluate(() => window.__TEST_FORCE_RESNAPSHOT__("evidence"));
    await sleep(300);

    const afterResnapshot = await page2.evaluate(() => JSON.parse(localStorage.getItem("city-ops-os") || "{}").state?.evidence ?? []);
    const install3 = afterResnapshot.find((e) => e.id === install2.id);
    const cable3 = afterResnapshot.find((e) => e.id === cable2.id);
    const final3 = afterResnapshot.find((e) => e.id === final2.id);
    check(
      !install3 && !cable3 && !final3,
      "ROOT CAUSE CONFIRMED: the three not-yet-uploaded Installation/Cable/Final evidence records were WIPED from local state by an unrelated 'evidence' snapshot arriving before their uploads finished (mergeRemoteCollection full-replace, not merge)",
    );
    check(
      afterResnapshot.some((e) => e.type === "RIG_PRECHECK") && afterResnapshot.some((e) => e.type === "LOCATION"),
      "(sanity) the pre-existing, already-synced LOCATION/RIG_PRECHECK evidence survived the resnapshot fine — only the not-yet-synced records were lost",
    );

    // Even if the (real) Supabase uploads for these files eventually
    // 'finish', the evidence records they belonged to no longer exist in
    // local state to attach that status to — setFileUploadStatus() is a
    // silent no-op once the record is gone (see its own `if (!record)
    // return`), so nothing ever retries and nothing ever reaches Firestore.
    // This is the exact permanent-loss mechanism behind "stuck at 4/9
    // forever," not a slow retry that eventually succeeds.
    const fileTargets2 = [install2, cable2, final2].flatMap((ev) => ev.files.map((f) => ({ evidenceId: ev.id, fileId: f.id })));
    await page2.evaluate((targets) => {
      for (const { evidenceId, fileId } of targets) {
        window.__CITY_OPS_TEST_SET_FILE_UPLOAD_STATUS__(evidenceId, fileId, { uploadStatus: "uploaded", storagePath: "x", downloadUrl: "https://example.test/x" });
      }
    }, fileTargets2);
    await sleep(500);
    const putCalls2 = await getPutDocCalls(page2);
    const everReachedBackend = putCalls2.some((c) => c.collection === "evidence" && [install2.id, cable2.id, final2.id].includes(c.id));
    check(
      !everReachedBackend,
      "confirmed permanent, not transient: even after simulating the (real-world) uploads finishing, none of the three wiped evidence records ever reaches the backend — they are gone for good, not just delayed",
    );

    if (pageErrors2.length > 0) check(false, `no uncaught page errors occurred in scenario [3] (saw ${pageErrors2.length}): ${pageErrors2[0]}`);
    await context2.close();

    console.log(
      "\n[4] Reproducing the round-4 production report: RIG PRECHECK already synced, Submit Installation succeeds " +
        "locally (all 3 evidence records present, matching the FO screen's 'Installation/Cable/Final complete'), " +
        "but each photo's upload NEVER finishes (no live Supabase project in this environment reproduces this " +
        "exactly the same as a genuinely stuck/slow upload in production would) — proving these records are stuck " +
        "at the MEDIA-UPLOAD gate, never even reaching the Firestore outbox, with no error reported anywhere:",
    );
    const context3 = await browser.newContext();
    const page3 = await context3.newPage();
    await page3.addInitScript(MOCK_BACKEND_INIT_SCRIPT);
    await page3.addInitScript(AUTH_PROVIDER_INIT_SCRIPT);
    await page3.goto(`${BASE_URL}/login`);
    await seedCityDataAtInstallationStage(page3);
    await sleep(1000);

    await page3.goto(`${BASE_URL}/fo`);
    await page3.waitForSelector("text=Test Biz", { timeout: 15000 });
    await page3.click("text=Test Biz");
    await page3.waitForSelector("text=INSTALLATION", { timeout: 15000 });
    for (const cb of await page3.getByRole("checkbox").all()) await cb.click();
    for (const input of await page3.locator('input[type="file"]').all()) {
      await input.setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: Buffer.from(ONE_PX_PNG_BASE64, "base64") });
    }
    await sleep(400);
    await page3.getByRole("button", { name: "Submit Installation" }).click();
    // Deliberately NOT calling __CITY_OPS_TEST_SET_FILE_UPLOAD_STATUS__ here —
    // this models the upload simply never completing. Wait well past every
    // other scenario's settle time to rule out "just needs longer".
    await sleep(2000);

    const evidenceAfter4 = await page3.evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem("city-ops-os") || "{}").state?.evidence ?? [];
      } catch {
        return [];
      }
    });
    const install4 = evidenceAfter4.find((e) => e.type === "INSTALLATION");
    const cable4 = evidenceAfter4.find((e) => e.type === "CABLE_SETUP");
    const final4 = evidenceAfter4.find((e) => e.type === "FINAL_SETUP");
    check(
      !!install4 && !!cable4 && !!final4,
      "the three evidence records still exist locally, unlike scenario [3]'s wipe — matches the production report's persistent 'Installation/Cable/Final complete' on the FO screen",
    );
    check(
      [install4, cable4, final4].every((e) => e.files.every((f) => f.uploadStatus === "local_only")),
      "every one of their files is stuck at uploadStatus 'local_only' — the upload never started/finished (no Supabase configured here; a real stuck/slow upload in production leaves the exact same local state)",
    );

    const putCalls4 = await getPutDocCalls(page3);
    const evidencePutsFor4 = putCalls4.filter((c) => c.collection === "evidence" && [install4.id, cable4.id, final4.id].includes(c.id));
    check(
      evidencePutsFor4.length === 0,
      "ROOT CAUSE CONFIRMED (media-upload gate): zero Firestore putDoc calls were ever attempted for these three records — they never even reached the Firestore outbox, let alone got denied, because evidenceReadyToSync() never became true",
    );

    const firestoreOutboxEntries = await listRawIndexedDbEntriesWithPrefix(page3, "outbox:evidence:");
    const queuedIds = firestoreOutboxEntries.map((e) => e.key);
    check(
      ![install4.id, cable4.id, final4.id].some((id) => queuedIds.some((k) => k.endsWith(`:${id}`))),
      "confirmed at the outbox layer directly: no 'outbox:evidence:<id>' key exists for any of the three records — they are not merely queued-and-stuck, they were never queued at all",
    );

    const mockStoreAfter4 = await page3.evaluate(() => JSON.parse(localStorage.getItem("__mock_firestore_store__") || "{}"));
    const storedIds4 = Object.keys(mockStoreAfter4.evidence || {});
    check(
      ![install4.id, cable4.id, final4.id].some((id) => storedIds4.includes(id)),
      "Manager's own backend never receives these documents — consistent with 'write never happened', not 'write succeeded but Manager query excludes it'",
    );

    // The sync banner must show ordinary "syncing" (pending count elevated),
    // never "error" — matching the production report of NO error banner,
    // just a persistently elevated pending count.
    const bannerText4 = await page3.evaluate(() => document.body.innerText);
    check(
      !bannerText4.includes("Sync error"),
      "no 'Sync error' banner is shown — matches the production report exactly (elevated pending count, but no error), because nothing was ever attempted against Firestore to be denied",
    );

    await context3.close();

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
