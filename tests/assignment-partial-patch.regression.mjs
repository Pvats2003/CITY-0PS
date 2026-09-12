// Regression test for the production sync fix: src/data/syncEngine.ts's
// local watcher used to enqueue the FULL locally-cached assignments/
// rigIncidents record on every local mutation, even though
// firestore.rules' FO update grant on those two collections is
// field-scoped (affectedKeys().hasOnly([...])). Since the outbox entry
// was a full snapshot, ANY unrelated field that drifted between the FO's
// stale local cache and the live server document (a Manager changing
// `priority`/`reviewStatus`, a rig incident's `status`/`severity`
// advancing, ...) showed up in Firestore's diff as an "affected key"
// outside the allowed list, denying the WHOLE write — even though every
// field the FO's own code actually meant to change was allowed. This was
// the root cause of assignments/rigIncidents writes staying permanently
// stuck ("Sync error — Permission denied... N changes still waiting")
// even AFTER the scoped update grants (commit 86afa78) were deployed.
//
// Fix: store/city.ts's updateAssignment()/updateRigIncident() now trace
// their own `patch` argument into src/data/pendingFieldPatches.ts (the
// AUTHORITATIVE record of what that specific mutation intended to
// change — never inferred by diffing snapshots), and syncEngine.ts's
// local watcher sends THAT accumulated patch as the outbox payload
// instead of the full record, for these two collections, whenever an FO
// is signed in.
//
// A startup pass (quarantineStaleScopedOutboxEntries()) also finds any
// ALREADY-QUEUED full-snapshot entry left over from before this fix
// shipped — but, critically, it does NOT reduce such an entry down to
// "just its allowed fields" and resend that as a patch. An earlier
// version of this fix did exactly that, and it was wrong: an allowed
// field's NAME (status, sessionId, actualStart, ...) says nothing about
// whether that field's VALUE in a frozen old snapshot is still current —
// forwarding it could silently regress the server back to stale data
// (e.g. a `status` the Manager or a later sync has since moved forward)
// merely because the field happens to be on the whitelist. Since the
// entry's true mutation intent can't be recovered from
// pendingFieldPatches.ts either (that map only ever reflects a call made
// THIS session — structurally empty for anything that predates the
// current page load), such an entry is quarantined IN PLACE instead:
// flagged `needsManualReview` (outbox.ts's
// flagOutboxEntryNeedsManualReview()), never auto-sent, never deleted,
// never rewritten — its `data` stays byte-for-byte exactly as queued.
// drainOutbox() skips a flagged entry entirely so it can't block every
// other collection's writes behind a write that would always be denied
// anyway. A genuine NEW mutation on the same record still overwrites the
// same outbox key with a fresh, fully-automatic, correctly-scoped patch
// the moment the FO acts on it again.
//
// Drives the REAL app UI (real FOExecution "I'm on my way"/arrival flow)
// via Playwright against a production build, using the established
// __CITY_OPS_TEST_BACKEND__ seam (see assignment-fo-visibility.regression.mjs)
// so no live Firebase project is needed — extended here to also RECORD
// every putDoc() call's exact payload, which is the only way to prove the
// outbox entry that reached the "backend" was a genuine partial patch and
// not a full-record snapshot in disguise.
//
// Run with: npm run test:assignment-partial-patch

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4182;
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

// Same mock-backend pattern as assignment-fo-visibility.regression.mjs
// (localStorage-backed so it survives a reload), extended to record every
// putDoc() call's exact collection/id/payload into a persisted call log —
// the only way to prove what the app actually SENT, not just what ended
// up in the mock store after merge:true-style overwrites.
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
      // Mirrors src/data/backend.ts's OWNERSHIP_SCOPED_FO_COLLECTIONS: only
      // these collections carry a .foId field on their records at all and
      // are actually scoped by firebaseBackend.ts's real subscribeCollection.
      // fos/businesses/rigs have no .foId property, so filtering them here
      // would zero out every record (d.foId is always undefined), which is
      // exactly the fosCount=0/"fo-not-found" bug this comment now guards
      // against.
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

const now = new Date().toISOString();
const today = now.slice(0, 10);
const FO_ID = "fo1";
const ASG_ID = "asg_partial_patch_test";

// src/data/syncEngine.ts's waitForAuthReady() checks
// window.__CITY_OPS_TEST_AUTH_PROVIDER__ FIRST, before ever falling back to
// isFirebaseConfigured() — it does NOT read city-ops-auth localStorage
// itself (that's demoAuthProvider's job, consulted only by AuthContext.tsx
// for RENDERING). Without this seam also injected, waitForAuthReady()
// resolves { role: null } in plain demo mode regardless of what
// city-ops-auth says, meaning syncEngine's `scope` is always undefined and
// none of this round's FO-scoped partial-patch logic (or the pre-existing
// evidence-scoping logic) is ever reached — exactly the trap this test
// fell into on the first attempt. Injecting BOTH seams together (this one
// for the sync engine's role/foId resolution, the mock backend above for
// the actual reads/writes) is what makes this test genuinely exercise the
// FO-scoped code path, not just the FO-flavored UI.
const AUTH_PROVIDER_INIT_SCRIPT = `
(function () {
  window.__CITY_OPS_TEST_AUTH_PROVIDER__ = {
    onChange(cb) {
      // Deferred, not synchronous: src/auth/authReady.ts's testProvider
      // branch does \`const unsub = testProvider.onChange(cb); ... cb =
      // (event) => { ...; unsub(); ... }\` — calling cb() synchronously,
      // before onChange() has returned and assigned unsub, hits unsub's
      // own temporal dead zone (a real, pre-existing latent bug in
      // authReady.ts, unrelated to this round's fix, never triggered
      // before because no prior test drove a synchronous test auth
      // provider through this exact path). Real providers (Firebase's
      // onAuthStateChanged, demoAuthProvider) are never synchronous either,
      // so deferring here is also just a more faithful mock — not a
      // workaround for an app bug this test has no business fixing.
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

function baseAssignment(overrides = {}) {
  return {
    id: ASG_ID,
    date: today,
    businessId: "biz1",
    foId: FO_ID,
    rigId: "rig1",
    plannedStart: `${today}T08:00:00.000Z`,
    plannedEnd: `${today}T11:00:00.000Z`,
    priority: "normal",
    status: "confirmed",
    createdAt: now,
    ...overrides,
  };
}

async function seedCityData(page, assignment) {
  await page.evaluate(
    ({ assignment, foId }) => {
      const business = { id: "biz1", name: "Test Biz", category: "General", area: "Area", address: "", capacityHoursPerDay: 3, active: true, createdAt: new Date().toISOString() };
      const fo = { id: foId, name: "Test FO", active: true, createdAt: new Date().toISOString() };
      const rig = { id: "rig1", code: "R-1", model: "Test Rig", active: true, batteryPct: 100, storagePct: 0, deploymentStatus: "active", createdAt: new Date().toISOString() };
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
      localStorage.setItem(
        "city-ops-auth",
        JSON.stringify({ id: "demo-fo-test-" + foId, email: "test-fo@demo.city-ops", role: "FIELD_OFFICER", displayName: "Test FO", foId, createdAt: new Date().toISOString() }),
      );
      // The __CITY_OPS_TEST_BACKEND__ mock's subscribeCollection() fires
      // synchronously with whatever's in the mock "remote" store, and
      // mergeRemoteCollection() is a full REPLACE (`state[collection] =
      // docs`), not a merge — so an empty mock store would otherwise wipe
      // the locally-seeded assignment (and fos/businesses/rigs) the instant
      // the sync engine starts, before this test ever gets a chance to see
      // it rendered. Seeding the mock "remote" with the SAME records the
      // real backend would eventually have avoids that race entirely.
      const mockStore = { businesses: { [business.id]: business }, fos: { [fo.id]: fo }, rigs: { [rig.id]: rig }, assignments: { [assignment.id]: assignment } };
      localStorage.setItem("__mock_firestore_store__", JSON.stringify(mockStore));
    },
    { assignment, foId: FO_ID },
  );
}

async function getPutDocCalls(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("__mock_put_doc_calls__") || "[]"));
}

async function readRawOutboxEntry(page, collection, id) {
  // Raw IndexedDB access (no idb-keyval import available in page context) —
  // idb-keyval's default store is exactly this db/store name when no
  // custom store is configured, which src/data/outbox.ts never does.
  return page.evaluate(
    ({ collection, id }) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("keyval-store");
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("keyval", "readonly");
          const store = tx.objectStore("keyval");
          const getReq = store.get(`outbox:${collection}:${id}`);
          getReq.onsuccess = () => resolve(getReq.result ?? null);
          getReq.onerror = () => reject(getReq.error);
        };
      }),
    { collection, id },
  );
}

async function writeRawOutboxEntry(page, entry) {
  await page.evaluate(
    (entry) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("keyval-store", 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore("keyval");
        };
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("keyval", "readwrite");
          const store = tx.objectStore("keyval");
          const putReq = store.put(entry.value, entry.key);
          putReq.onsuccess = () => resolve();
          putReq.onerror = () => reject(putReq.error);
        };
      }),
    entry,
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

    // ------------------------------------------------------------ [1]
    console.log("\n[1] A single FO action (markEnRoute) sends a genuine partial patch, not the full assignment record:");
    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    await page1.addInitScript(MOCK_BACKEND_INIT_SCRIPT);
    await page1.addInitScript(AUTH_PROVIDER_INIT_SCRIPT);
    page1.on("pageerror", (err) => console.error("  [page error]", err.stack || err.message));

    await page1.goto(`${BASE_URL}/login`);
    await seedCityData(page1, baseAssignment());
    await page1.goto(`${BASE_URL}/fo`);
    await page1.waitForSelector("text=Test Biz", { timeout: 15000 });
    await page1.locator("text=Test Biz").click({ timeout: 20000 });
    await page1.waitForSelector("text=I'm on my way", { timeout: 15000 });
    await page1.click("text=I'm on my way");
    await sleep(800); // let the store mutation -> outbox -> mock putDoc chain settle

    const calls1 = await getPutDocCalls(page1);
    const assignmentCalls1 = calls1.filter((c) => c.collection === "assignments" && c.id === ASG_ID);
    check(assignmentCalls1.length > 0, `at least one assignments putDoc call was recorded (got ${assignmentCalls1.length})`);
    const lastCall1 = assignmentCalls1[assignmentCalls1.length - 1];
    check(!!lastCall1 && Object.keys(lastCall1.data).length === 1 && "enRouteAt" in lastCall1.data, `the payload contains ONLY enRouteAt, not the full record (got keys: ${JSON.stringify(lastCall1 && Object.keys(lastCall1.data))})`);
    check(!assignmentCalls1.some((c) => "priority" in c.data || "businessId" in c.data || "reviewStatus" in c.data), "no call ever included priority/businessId/reviewStatus — fields the FO's action never touched");

    await context1.close();

    // ------------------------------------------------------------ [2]
    console.log("\n[2] Two rapid, back-to-back FO actions on the same assignment accumulate correctly — neither field is lost:");
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await page2.addInitScript(MOCK_BACKEND_INIT_SCRIPT);
    await page2.addInitScript(AUTH_PROVIDER_INIT_SCRIPT);
    page2.on("pageerror", (err) => console.error("  [page error]", err.stack || err.message));

    await page2.goto(`${BASE_URL}/login`);
    // Seed already "arrived" (actualArrivalAt set, no LOCATION evidence) so
    // the ARRIVAL PHOTO screen is reachable, then also add enRouteAt via
    // markEnRoute equivalent isn't reachable from this screen — instead
    // seed at "assigned" stage so both "I'm on my way" AND "I'm at
    // Location" are both clickable in quick succession without waiting on
    // geolocation (mocked below).
    await page2.addInitScript(() => {
      // Deterministic, synchronous geolocation mock — avoids relying on a
      // real browser location permission prompt for this test.
      window.navigator.geolocation = {
        getCurrentPosition: (success) => success({ coords: { latitude: 12.9, longitude: 77.6, accuracy: 10 } }),
      };
    });
    await seedCityData(page2, baseAssignment());
    await page2.goto(`${BASE_URL}/fo`);
    await page2.waitForSelector("text=Test Biz", { timeout: 15000 });
    await page2.click("text=Test Biz");
    await page2.waitForSelector("text=I'm on my way", { timeout: 15000 });
    // Fire both actions back-to-back, without waiting for the first
    // mutation's enqueue() to settle before starting the second — this is
    // the exact race pendingFieldPatches.ts's accumulation is meant to
    // survive (enqueue() is async; a second local mutation can easily land
    // before the first's outbox write resolves).
    await Promise.all([page2.click("text=I'm on my way"), page2.click("text=I'm at Location")]);
    await sleep(1200); // let both mutations' outbox writes fully settle

    const mockStore2 = await page2.evaluate(() => JSON.parse(localStorage.getItem("__mock_firestore_store__") || "{}"));
    const finalAssignment2 = mockStore2.assignments?.[ASG_ID];
    check(!!finalAssignment2, "the assignment document exists in the mock backend after both actions");
    check(finalAssignment2 ? !!finalAssignment2.enRouteAt : false, "enRouteAt (from the FIRST action) was not lost");
    check(finalAssignment2 ? !!finalAssignment2.actualArrivalAt : false, "actualArrivalAt (from the SECOND action) was not lost");
    check(finalAssignment2 ? finalAssignment2.status !== undefined : false, "status is present after both actions");

    const calls2 = (await getPutDocCalls(page2)).filter((c) => c.collection === "assignments" && c.id === ASG_ID);
    const allSentKeys2 = new Set(calls2.flatMap((c) => Object.keys(c.data)));
    check(!allSentKeys2.has("priority") && !allSentKeys2.has("businessId") && !allSentKeys2.has("reviewStatus"), "across ALL calls from both actions, no unrelated field was ever sent");

    await context2.close();

    // ------------------------------------------------------------ [3]
    console.log("\n[3] A stale full-record outbox entry (as an older build would have created) is quarantined IN PLACE at startup — never auto-sent, never deleted, never rewritten:");
    const context3 = await browser.newContext();
    const page3 = await context3.newPage();
    await page3.addInitScript(MOCK_BACKEND_INIT_SCRIPT);
    await page3.addInitScript(AUTH_PROVIDER_INIT_SCRIPT);
    page3.on("pageerror", (err) => console.error("  [page error]", err.stack || err.message));

    await page3.goto(`${BASE_URL}/login`);
    await seedCityData(page3, baseAssignment({ enRouteAt: `${today}T07:55:00.000Z` }));
    // The /login page load above already boots a full (harmless, no-op)
    // sync-engine run of its own — startSyncEngine() isn't gated on route,
    // only on a resolved signed-in identity, and the mock auth provider
    // resolves regardless of which page it's injected into. That boot's
    // OWN drainOutbox() call is fire-and-forget (`void drainOutbox(...)`)
    // and reads the outbox's keys() asynchronously; if the stale entry
    // below were written while that scan is still in flight, THIS boot's
    // already-completed quarantine pass would never see it, and its
    // still-running drain would send it straight through unquarantined —
    // a false failure that belongs to this test's own two-navigation
    // setup, not to quarantineStaleScopedOutboxEntries()/drainOutbox()'s
    // real ordering guarantee (the quarantine pass is always awaited
    // before the FIRST drain of any single page load). Waiting here for
    // that first boot's cycle to fully settle before writing the stale
    // entry is what makes this test actually simulate "entry already sat
    // in IndexedDB before this page load happened" instead of "entry
    // appeared while a sync pass was already mid-flight."
    await sleep(1000);
    // Directly seed a STALE, pre-fix-shaped outbox entry — a FULL record
    // snapshot including fields no FO update grant ever allowed
    // (priority, reviewStatus) — simulating exactly what an older build
    // left sitting in IndexedDB before this fix shipped.
    const staleFullSnapshot = { ...baseAssignment({ enRouteAt: `${today}T07:55:00.000Z` }), priority: "high", reviewStatus: "approved" };
    await writeRawOutboxEntry(page3, {
      key: `outbox:assignments:${ASG_ID}`,
      value: { collection: "assignments", id: ASG_ID, data: staleFullSnapshot, queuedAt: new Date().toISOString() },
    });
    const seededEntry = await readRawOutboxEntry(page3, "assignments", ASG_ID);
    check(!!seededEntry && "priority" in seededEntry.data, "sanity check: the seeded stale entry really does contain the forbidden field before startup");

    await page3.goto(`${BASE_URL}/fo`);
    await page3.waitForSelector("text=Test Biz", { timeout: 15000 });
    await sleep(1500); // let quarantineStaleScopedOutboxEntries() + any drain attempt settle

    const quarantinedEntry = await readRawOutboxEntry(page3, "assignments", ASG_ID);
    check(!!quarantinedEntry, "the stale entry is still present in the outbox — never cleared/deleted by quarantining");
    check(
      quarantinedEntry && JSON.stringify(quarantinedEntry.data) === JSON.stringify(staleFullSnapshot),
      "the quarantined entry's data is byte-for-byte IDENTICAL to what was seeded — not migrated, reduced, or rewritten in any way",
    );
    check(quarantinedEntry?.needsManualReview === true, "the entry is flagged needsManualReview so drainOutbox() knows to skip it");

    const calls3 = (await getPutDocCalls(page3)).filter((c) => c.collection === "assignments" && c.id === ASG_ID);
    check(calls3.length === 0, "the quarantined entry was NEVER sent to the backend at all — not as a full snapshot, not as a reduced patch");

    // ------------------------------------------------------------ [4]
    console.log("\n[4] A stale allowed-field VALUE cannot overwrite a DIFFERENT, already-current server value merely because the field name is on the whitelist:");
    const context4 = await browser.newContext();
    const page4 = await context4.newPage();
    await page4.addInitScript(MOCK_BACKEND_INIT_SCRIPT);
    await page4.addInitScript(AUTH_PROVIDER_INIT_SCRIPT);
    page4.on("pageerror", (err) => console.error("  [page error]", err.stack || err.message));

    const ASG_ID_4 = "asg_stale_value_overwrite_test";
    // The mock "remote" (server) already has this assignment at a LATER
    // stage (status: "completed") than the stale local outbox entry below
    // claims (status: "in_progress") — exactly the shape of "the FO's own
    // later action, or a Manager's own write, already advanced this past
    // what an old, unsent local snapshot still remembers."
    await page4.goto(`${BASE_URL}/login`);
    await seedCityData(page4, { ...baseAssignment({ id: ASG_ID_4 }), status: "completed" });
    await sleep(1000); // let the /login page's own harmless boot settle, same reasoning as [3]

    const staleValueSnapshot = { ...baseAssignment({ id: ASG_ID_4 }), status: "in_progress", priority: "high", reviewStatus: "approved" };
    await writeRawOutboxEntry(page4, {
      key: `outbox:assignments:${ASG_ID_4}`,
      value: { collection: "assignments", id: ASG_ID_4, data: staleValueSnapshot, queuedAt: new Date().toISOString() },
    });

    await page4.goto(`${BASE_URL}/fo`);
    await page4.waitForSelector("text=Test Biz", { timeout: 15000 });
    await sleep(1500); // let quarantineStaleScopedOutboxEntries() + any drain attempt settle

    const calls4 = (await getPutDocCalls(page4)).filter((c) => c.collection === "assignments" && c.id === ASG_ID_4);
    check(calls4.length === 0, "the stale entry (status: in_progress, an allowed field) was never sent to the backend at all");
    check(
      !calls4.some((c) => c.data.status === "in_progress"),
      "no putDoc call ever carried the stale status value, whitelisted field name notwithstanding",
    );
    const mockStore4 = await page4.evaluate(() => JSON.parse(localStorage.getItem("__mock_firestore_store__") || "{}"));
    check(mockStore4.assignments?.[ASG_ID_4]?.status === "completed", "the server's own, more current status was never regressed by the stale local snapshot");

    const quarantinedEntry4 = await readRawOutboxEntry(page4, "assignments", ASG_ID_4);
    check(!!quarantinedEntry4 && quarantinedEntry4.needsManualReview === true, "the stale entry is preserved in the outbox, flagged for manual review, rather than silently converted into a partial write");
    check(quarantinedEntry4 && quarantinedEntry4.data.status === "in_progress", "the preserved entry still carries its original (stale) status value untouched — nothing was invented or dropped");

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
