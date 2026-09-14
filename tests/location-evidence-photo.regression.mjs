// Regression test for: LOCATION evidence has no photo in Manager Evidence
// Review even though the FO takes an arrival/location photo.
//
// ROOT CAUSE: src/engine/workflows.ts's captureLocationEvidence() always
// created the LOCATION evidence record with `files: []` — its signature
// never accepted a `files` parameter at all. src/pages/FOExecution.tsx's
// handleArrive() called it immediately on GPS resolution, before any photo
// capture UI was ever shown; the photo the FO subsequently took at the next
// screen ("ARRIVAL PHOTO") was written into a SEPARATE "ARRIVAL"-typed
// evidence record instead, which is not what Manager Evidence Review shows
// under the LOCATION entry.
//
// THE FIX: captureLocationEvidence() now accepts `files`, and
// FOExecution.tsx defers creating the LOCATION evidence record until the
// FO has attached a location photo at the "arrived" stage — the GPS fix
// resolved by handleArrive() is held in local state, and LOCATION evidence
// (GPS + photo, together, in the one append-only record) is created only
// once the FO submits that photo. No separate ARRIVAL evidence record is
// created by this flow. Existing architecture reused unchanged: PhotoCapture,
// stashPendingFile()/pendingFileBlobs (IndexedDB), mediaOutbox's
// enqueueMediaUpload()/drainMediaOutbox(), the Supabase-upload test seam,
// and evidence sync's "only after every file is uploaded" deferral.
//
// Drives the REAL app UI (real FOExecution "I'm at Location"/"arrived"
// screens, real Manager Evidence Review dialog) via Playwright against a
// production build, using the established __CITY_OPS_TEST_BACKEND__ mock
// Firestore and __CITY_OPS_TEST_UPLOAD_EVIDENCE_FILE__ mock Supabase-upload
// seams (same pattern as media-upload-concurrency.regression.mjs) — no live
// Firebase/Supabase project needed. Geolocation is mocked via Playwright's
// real browser geolocation API (context.setGeolocation), not a test seam —
// this is the actual navigator.geolocation path production code calls.
//
// Run with: npm run test:location-evidence-photo

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4186;
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
      for (const key of Object.keys(data)) {
        if (data[key] === undefined) throw new Error("Unsupported field value: undefined (found in field " + key + ")");
      }
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

const FO_ID = "fo_loc_test";
const BIZ_LAT = 37.7749;
const BIZ_LNG = -122.4194;

const ONE_PX_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

// Test-only Supabase-upload seam (src/data/mediaOutbox.ts's
// __CITY_OPS_TEST_UPLOAD_EVIDENCE_FILE__) — same pattern as
// media-upload-concurrency.regression.mjs, proving the REAL
// enqueueMediaUpload()/drainMediaOutbox() pipeline, not a stub.
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
    if (cfg.delayMs) await new Promise((r) => setTimeout(r, cfg.delayMs));
    appendUploadCall({ fileName: params.fileName, evidenceId: params.evidenceId, fileId: params.fileId, event: "success", at: Date.now() });
    return { storagePath: "test/" + params.evidenceId + "/" + params.fileId, downloadUrl: "https://example.test/" + params.evidenceId + "/" + params.fileId };
  };
})();
`;

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

async function getUploadCalls(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("__test_upload_calls__") || "[]"));
}

/** Raw IndexedDB access (idb-keyval's default "keyval-store"/"keyval"
 * db/store) — same technique as media-upload-concurrency.regression.mjs's
 * identically-named helper. Proves the photo binary was durably stashed
 * (pendingFileBlobs.ts) independent of what the evidence record itself
 * says. */
async function listRawIndexedDbEntriesWithPrefix(page, prefix) {
  return page.evaluate(
    (prefix) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("keyval-store");
        req.onerror = () => resolve([]);
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

async function seedAssignedStage(page) {
  await page.evaluate(
    ({ foId, bizLat, bizLng }) => {
      const now = new Date().toISOString();
      const today = now.slice(0, 10);
      const business = { id: "biz_loc", name: "Location Test Biz", category: "General", area: "Area", address: "", lat: bizLat, lng: bizLng, capacityHoursPerDay: 3, active: true, createdAt: now };
      const fo = { id: foId, name: "Location Test FO", active: true, createdAt: now };
      const rig = { id: "rig_loc", code: "R-LOC", model: "Test Rig", active: true, batteryPct: 100, storagePct: 0, deploymentStatus: "active", createdAt: now };
      const assignment = {
        id: "asg_loc",
        date: today,
        businessId: business.id,
        foId,
        rigId: rig.id,
        plannedStart: `${today}T08:00:00.000Z`,
        plannedEnd: `${today}T11:00:00.000Z`,
        priority: "normal",
        status: "planned",
        // Deliberately NOT arrived yet — this test drives the real
        // "I'm at Location" button so handleArrive()'s real geolocation
        // integration is exercised, not bypassed.
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
      localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-fo-test-" + foId, email: "test-fo@demo.city-ops", role: "FIELD_OFFICER", displayName: "Test FO", foId, createdAt: now }));
      const mockStore = {
        businesses: { [business.id]: business },
        fos: { [fo.id]: fo },
        rigs: { [rig.id]: rig },
        assignments: { [assignment.id]: assignment },
        evidence: {},
      };
      localStorage.setItem("__mock_firestore_store__", JSON.stringify(mockStore));
    },
    { foId: FO_ID, bizLat: BIZ_LAT, bizLng: BIZ_LNG },
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

    console.log("\n[1] Driving the REAL 'I'm at Location' -> location photo -> submit flow, with real (mocked) browser geolocation:");
    const context = await browser.newContext({
      permissions: ["geolocation"],
      geolocation: { latitude: BIZ_LAT, longitude: BIZ_LNG },
    });
    const page = await context.newPage();
    await page.addInitScript(MOCK_BACKEND_INIT_SCRIPT);
    await page.addInitScript(UPLOAD_SEAM_INIT_SCRIPT);
    page.on("pageerror", (err) => console.error("  [page error]", err.message));

    await page.goto(`${BASE_URL}/login`);
    await seedAssignedStage(page);
    await page.goto(`${BASE_URL}/fo`);
    await page.waitForSelector("text=Location Test Biz", { timeout: 15000 });
    await page.click("text=Location Test Biz");
    await page.waitForSelector('button:has-text("I\'m at Location")', { timeout: 15000 });

    check((await getLocalEvidence(page)).length === 0, "(setup) no evidence exists yet — LOCATION has not been auto-created just by opening the assignment");

    await page.click('button:has-text("I\'m at Location")');
    await page.waitForSelector("text=LOCATION PHOTO", { timeout: 15000 });

    console.log("  'arrived' stage reached — LOCATION evidence must still NOT exist yet (deferred until the photo is attached):");
    const evidenceBeforePhoto = await getLocalEvidence(page);
    check(evidenceBeforePhoto.filter((e) => e.type === "LOCATION").length === 0, "LOCATION evidence is not created merely from resolving GPS — it waits for the photo");

    check(
      await page.locator("text=LOCATION VERIFIED").isVisible().catch(() => false),
      "the live GPS-vs-business-coordinates preview shows LOCATION VERIFIED (the mocked geolocation matches the seeded business coordinates exactly) — proves a REAL, non-zero GPS fix was resolved via handleArrive(), not a 0,0 fallback",
    );

    const submitBtn = page.getByRole("button", { name: "Continue to Rig Precheck" });
    check(await submitBtn.isDisabled(), "the submit button is disabled until a location photo is attached — the photo is required for LOCATION evidence to be created at all");

    console.log("  Attaching the location photo and submitting...");
    await page.locator('input[type="file"]').first().setInputFiles({ name: "location.png", mimeType: "image/png", buffer: Buffer.from(ONE_PX_PNG_BASE64, "base64") });
    await sleep(400); // durable IndexedDB stash (pendingFileBlobs.ts) settles

    const pendingEntries = await listRawIndexedDbEntriesWithPrefix(page, "pendingFile:");
    check(pendingEntries.length > 0, "the photo's binary is durably stashed in IndexedDB (pendingFileBlobs.ts) BEFORE the evidence record is ever submitted");

    check(!(await submitBtn.isDisabled()), "the submit button becomes enabled once the location photo is attached");
    await submitBtn.click();
    await sleep(600); // captureLocationEvidence()'s synchronous store write + re-render

    console.log("\n[2] LOCATION evidence contains BOTH GPS verification AND the photo, in one record:");
    const evidenceAfterSubmit = await getLocalEvidence(page);
    const locationEvidence = evidenceAfterSubmit.filter((e) => e.type === "LOCATION");
    check(locationEvidence.length === 1, `exactly one LOCATION evidence record exists (got ${locationEvidence.length})`);
    const loc = locationEvidence[0];
    check(typeof loc?.lat === "number" && Math.abs(loc.lat - BIZ_LAT) < 0.001, `LOCATION evidence carries the real resolved latitude (got ${loc?.lat})`);
    check(typeof loc?.lng === "number" && Math.abs(loc.lng - BIZ_LNG) < 0.001, `LOCATION evidence carries the real resolved longitude (got ${loc?.lng})`);
    check(loc?.metadata?.verified === true, "LOCATION evidence's GPS verification metadata is present and verified (matches the seeded business coordinates)");
    check(loc?.files?.length === 1, `LOCATION evidence contains exactly the one captured photo (got ${loc?.files?.length} files)`);
    check(loc?.files?.[0]?.name === "location.png", "the file attached to LOCATION evidence is the exact photo the FO captured");

    console.log("\n[3] No duplicate/unrelated ARRIVAL evidence record was created by this flow:");
    const arrivalEvidence = evidenceAfterSubmit.filter((e) => e.type === "ARRIVAL");
    check(arrivalEvidence.length === 0, `no ARRIVAL evidence record exists (got ${arrivalEvidence.length}) — the location photo was not duplicated into an unrelated record`);

    console.log("\n[4] Media outbox receives the photo and the real upload pipeline runs it to completion:");
    await sleep(1500); // let drainMediaOutbox()'s async upload settle
    const uploadCalls = await getUploadCalls(page);
    check(uploadCalls.some((c) => c.fileName === "location.png" && c.event === "start"), "media outbox actually attempted the upload (enqueueMediaUpload() -> drainMediaOutbox() -> the real upload seam)");
    check(uploadCalls.some((c) => c.fileName === "location.png" && c.event === "success"), "the upload succeeded");

    const evidenceAfterUpload = await getLocalEvidence(page);
    const locAfterUpload = evidenceAfterUpload.find((e) => e.id === loc.id);
    check(locAfterUpload?.files?.[0]?.uploadStatus === "uploaded", `the location photo's local uploadStatus reaches 'uploaded' (got '${locAfterUpload?.files?.[0]?.uploadStatus}')`);

    console.log("\n[5] Firestore evidence is created/visible only once the file's upload has actually resolved (existing deferred-sync architecture, unchanged):");
    const putCalls = await getPutDocCalls(page);
    const locPutCalls = putCalls.filter((c) => c.collection === "evidence" && c.id === loc.id);
    check(locPutCalls.length >= 1, "the LOCATION evidence record reached the Firestore mock backend");
    check(
      locPutCalls.every((c) => (c.data.files ?? []).every((f) => f.uploadStatus === "uploaded")),
      "every Firestore write for this evidence record carries only fully-uploaded file state — never a local_only/uploading file synced prematurely",
    );

    console.log("\n[6] Manager Evidence Review shows the photo under the LOCATION record:");
    // Same browser/device, switched to Manager auth — same store/backend the
    // FO just wrote to, exercising the real EvidenceReviewDialog rendering
    // path (EvidenceThumb), not a re-implementation of it.
    await page.evaluate(() => {
      const now = new Date().toISOString();
      localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-manager", email: "manager@demo.city-ops", role: "MANAGER", displayName: "Demo Manager", createdAt: now }));
    });
    await page.goto(`${BASE_URL}/field-officers`);
    await page.waitForSelector('a[href^="/field-officers/"]', { timeout: 15000 });
    await page.click('a[href^="/field-officers/"]');
    await page.waitForSelector('button[title="Review evidence"]', { timeout: 15000 });
    await page.click('button[title="Review evidence"]');
    await page.waitForSelector("text=Evidence records", { timeout: 15000 });

    check(await page.locator("text=LOCATION").first().isVisible(), "Manager Evidence Review shows a LOCATION evidence record");
    check(
      (await page.locator('img[alt="location.png"]').count()) > 0,
      "Manager Evidence Review renders an actual photo thumbnail for the LOCATION record — THE BUG FIX: this used to render 'No photo attached' instead",
    );
    check((await page.locator("text=No photo attached").count()) === 0, "the 'No photo attached' fallback is no longer shown for this LOCATION record");

    console.log("\n[7] Existing evidence types still work (unaffected by this change) — spot-check via evidenceCompleteness()'s 'arrival' slot:");
    // The 'arrival' completeness slot is keyed off assignment.actualArrivalAt,
    // never off an ARRIVAL evidence record — confirms removing the ARRIVAL
    // evidence write from this flow doesn't regress it.
    const rawAssignment = (await page.evaluate(() => JSON.parse(localStorage.getItem("city-ops-os") || "{}").state?.assignments ?? []))[0];
    check(!!rawAssignment?.actualArrivalAt, "assignment.actualArrivalAt is still set by checkInAssignment() exactly as before — the 'Arrival' completeness slot is unaffected by this change");

    if (failures > 0) console.error("\n--- preview server output (for debugging) ---\n" + serverOutput.slice(-4000));
    await context.close();
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
