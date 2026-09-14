// PRODUCTION-STYLE regression test for: after commit 2e79f83, the reported
// production bug STILL occurs — Manager approves a resubmitted replacement
// evidence item, but the FO's device keeps showing "RESUBMITTED — waiting
// on your Manager to review the new evidence."
//
// WHY THE EARLIER TEST (evidence-recheck-reconciliation.regression.mjs)
// COULD NOT HAVE CAUGHT THIS: that file seeds Manager and FO views by
// writing directly to `localStorage`'s `city-ops-os` key and switching
// `city-ops-auth` within ONE Playwright browser context/page. That never
// exercises src/data/syncEngine.ts's real subscribeCollection()/enqueue()/
// drainOutbox() pipeline at all — demo mode (no __CITY_OPS_TEST_BACKEND__,
// no Firebase configured) takes syncEngine.ts's early "demo mode: no
// subscriptions, no outbox draining, zero network" return, so it proves the
// LOCAL derivation logic (recalculateAssignmentReviewStatus() itself) is
// correct, but proves NOTHING about whether that recalculated state ever
// reaches a second, independent device. This file closes that gap: it uses
// TWO SEPARATE Playwright browser CONTEXTS (separate localStorage, separate
// in-page Zustand store — genuinely simulating "Manager's device" and "FO's
// device") talking to ONE SHARED backend held in THIS Node process (bridged
// into each page via page.exposeFunction — see SharedBackend below), with a
// continuously-repolling subscribeCollection() (not prior tests' one-shot
// emit-once mock), so the real syncEngine.ts local-watcher -> outbox ->
// drainOutbox() -> backend.putDoc() -> (poll-based) remote listener ->
// mergeRemoteCollection() path is exercised exactly as production's
// Firestore-backed path would be, end to end, across two devices.
//
// Traces (per this round's investigation request):
//   1. Which evidence object reviewEvidence() actually receives when the
//      Manager clicks Approve on the real EvidenceReviewDialog card for the
//      NEW replacement (not the superseded original) — proven via the same
//      card-targeting technique evidence-recheck-reconciliation.regression.mjs
//      established (a record's OWN distinctly-named photo disambiguates its
//      card, since two "LOCATION" cards can render side by side).
//   2. Whether updateEvidence()/updateAssignment()'s resulting writes
//      actually reach the SHARED backend (not just the Manager's own local
//      store) — this is the "local store vs persisted state" distinction
//      the previous test could not prove.
//   3. Whether the FO's OWN, independent device/session ever observes the
//      change, via the REAL subscribeCollection()/mergeRemoteCollection()
//      path — not a shared-localStorage shortcut.
//   4. Whether a reload of either device is consistent with the shared
//      backend's actual persisted state (not a stale in-memory artifact).
//
// Run with: npm run test:evidence-recheck-persistence

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4189;
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

// ---------------------------------------------------------------------------
// SharedBackend — the "Firestore" both browser contexts actually talk to,
// held here in the Node process (never in either page's own localStorage),
// bridged in via page.exposeFunction(). This is what makes the test
// genuinely cross-device: writing from the Manager's context and reading
// from the FO's context go through the SAME store instance, exactly like
// two real devices hitting the same Firestore project.
// ---------------------------------------------------------------------------
class SharedBackend {
  constructor() {
    this.store = { businesses: {}, fos: {}, rigs: {}, assignments: {}, evidence: {}, sessions: {}, issues: {}, rigIncidents: {}, activity: {} };
    this.putDocLog = [];
  }
  seed(collection, docs) {
    this.store[collection] = this.store[collection] || {};
    for (const d of docs) this.store[collection][d.id] = d;
  }
  async putDoc(collection, id, data) {
    this.store[collection] = this.store[collection] || {};
    // Mirrors firebaseBackend.ts's real `setDoc(ref, data, { merge: true })`
    // — a field-level merge onto whatever already exists, not a blind
    // replace of the whole document.
    this.store[collection][id] = { ...(this.store[collection][id] || {}), ...data };
    this.putDocLog.push({ collection, id, data, at: Date.now() });
  }
  async deleteDoc(collection, id) {
    if (this.store[collection]) delete this.store[collection][id];
  }
  getCollection(collection, foId) {
    let docs = Object.values(this.store[collection] || {});
    // Mirrors firebaseBackend.ts's own OWNERSHIP_SCOPED_FO_COLLECTIONS
    // check exactly — "fos" (and every other non-ownership-scoped
    // collection) has no `foId` field on its own documents at all (a `fos`
    // document's `id` IS the foId assignments/evidence reference, not a
    // field named `foId` on itself), so filtering it by foId would
    // incorrectly return zero results for every collection, not just the
    // ownership-scoped ones.
    if (foId && OWNERSHIP_SCOPED.includes(collection)) docs = docs.filter((d) => d.foId === foId);
    return docs;
  }
}
const OWNERSHIP_SCOPED = ["assignments", "sessions", "issues", "rigIncidents", "evidence"];

/** Wires one page's window.__CITY_OPS_TEST_BACKEND__ to the SharedBackend
 * via page.exposeFunction — writes go straight to the Node-side store;
 * reads are a REPOLLING listener (150ms), not prior tests' single emit-at-
 * subscribe-time mock, so a change made from the OTHER context's page is
 * actually observed here, the way a real onSnapshot listener would. */
async function wireSharedBackend(page, backend, prefix) {
  await page.exposeFunction(`${prefix}PutDoc`, (collection, id, data) => backend.putDoc(collection, id, data));
  await page.exposeFunction(`${prefix}DeleteDoc`, (collection, id) => backend.deleteDoc(collection, id));
  await page.exposeFunction(`${prefix}GetCollection`, (collection, foId) => backend.getCollection(collection, foId));
  await page.addInitScript(
    (prefix) => {
      window.__CITY_OPS_TEST_BACKEND__ = {
        async putDoc(collection, id, data) {
          await window[`${prefix}PutDoc`](collection, id, data);
        },
        async deleteDoc(collection, id) {
          await window[`${prefix}DeleteDoc`](collection, id);
        },
        subscribeCollection(collection, cb, scope) {
          let lastJson = null;
          const poll = async () => {
            const docs = await window[`${prefix}GetCollection`](collection, scope && scope.foId);
            const json = JSON.stringify(docs);
            if (json !== lastJson) {
              lastJson = json;
              cb(docs);
            }
          };
          poll();
          const iv = setInterval(poll, 150);
          return () => clearInterval(iv);
        },
      };
    },
    prefix,
  );
}

function authProviderInitScript(user) {
  return `
(function () {
  window.__CITY_OPS_TEST_AUTH_PROVIDER__ = {
    onChange(cb) {
      setTimeout(() => cb({ kind: "signed_in", user: ${JSON.stringify(user)} }), 0);
      return () => {};
    },
    async loginWithEmail() { return { ok: true }; },
    async logout() {},
  };
})();
`;
}

async function getLocalAssignment(page, id) {
  return page.evaluate((id) => {
    try {
      const raw = JSON.parse(localStorage.getItem("city-ops-os") || "{}");
      return (raw.state?.assignments ?? []).find((a) => a.id === id) ?? null;
    } catch {
      return null;
    }
  }, id);
}

/** Finds the Approve/Request Recheck/Reject button-group for the SPECIFIC
 * evidence record whose photo has this file name — same technique as
 * evidence-recheck-reconciliation.regression.mjs, since multiple evidence
 * cards can share the same type label (an original and its replacement are
 * both "LOCATION"). This is also this round's explicit check #1/#2: proving
 * the Approve click targets the NEW replacement's own card, not the
 * superseded original's. */
function evidenceCardByFileName(page, fileName) {
  return page.locator(`img[alt="${fileName}"]`).locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
}

const ONE_PX_PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function onePxFile(id) {
  return { id, name: `${id}.png`, type: "image/png", sizeBytes: 100, localUrl: ONE_PX_PNG_DATA_URI, capturedAt: new Date().toISOString(), uploadStatus: "local_only" };
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

    const backend = new SharedBackend();
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const BIZ_ID = "biz_persist";
    const FO_ID = "fo_persist";
    const RIG_ID = "rig_persist";
    const ASG_ID = "asg_persist";
    const ORIG_ID = "ev_orig_persist";
    const REPLACEMENT_ID = "ev_replacement_persist";

    backend.seed("businesses", [{ id: BIZ_ID, name: "Persistence Test Biz", category: "General", area: "Area", address: "", capacityHoursPerDay: 3, active: true, createdAt: now }]);
    backend.seed("fos", [{ id: FO_ID, name: "Persistence Test FO", active: true, createdAt: now }]);
    backend.seed("rigs", [{ id: RIG_ID, code: "R-PS", model: "Test Rig", active: true, batteryPct: 100, storagePct: 0, deploymentStatus: "active", createdAt: now }]);
    backend.seed("assignments", [
      { id: ASG_ID, date: today, businessId: BIZ_ID, foId: FO_ID, rigId: RIG_ID, plannedStart: `${today}T08:00:00.000Z`, plannedEnd: `${today}T11:00:00.000Z`, priority: "normal", status: "confirmed", actualArrivalAt: now, reviewStatus: "recheck_requested", createdAt: now },
    ]);
    backend.seed("evidence", [
      { id: ORIG_ID, assignmentId: ASG_ID, businessId: BIZ_ID, foId: FO_ID, rigId: RIG_ID, type: "LOCATION", startedAt: now, capturedAt: now, files: [onePxFile("f_orig_persist")], status: "recheck_requested", reviewNote: "Retake needed", metadata: { verified: true, message: "Within range" }, createdAt: now },
      { id: REPLACEMENT_ID, assignmentId: ASG_ID, businessId: BIZ_ID, foId: FO_ID, rigId: RIG_ID, type: "LOCATION", startedAt: now, capturedAt: now, files: [onePxFile("f_replacement_persist")], status: "submitted", replacesEvidenceId: ORIG_ID, metadata: { verified: true, message: "Within range" }, createdAt: now },
    ]);

    // ------------------------------------------------------------------
    console.log("\n[1] FO device (separate browser context): confirm baseline RESUBMITTED, reading purely from the shared backend via the REAL sync engine:");
    const foContext = await browser.newContext();
    const foPage = await foContext.newPage();
    foPage.on("pageerror", (err) => console.error("  [FO page error]", err.message));
    await wireSharedBackend(foPage, backend, "fo");
    await foPage.addInitScript(authProviderInitScript({ id: "test-fo-" + FO_ID, email: "fo@demo.city-ops", role: "FIELD_OFFICER", foId: FO_ID, createdAt: now }));

    await foPage.goto(`${BASE_URL}/fo`);
    await foPage.waitForSelector("text=Persistence Test Biz", { timeout: 15000 });
    await foPage.click("text=Persistence Test Biz");
    await foPage.waitForSelector("text=RESUBMITTED", { timeout: 15000 });
    check(await foPage.locator("text=RESUBMITTED").isVisible(), "(baseline) FO device shows RESUBMITTED, reading assignment.reviewStatus purely from the shared backend through the real sync engine — not a localStorage shortcut");

    // ------------------------------------------------------------------
    console.log("\n[2] Manager device (separate browser context): open Evidence Review, verify card targeting, approve the REPLACEMENT:");
    const mgrContext = await browser.newContext();
    const mgrPage = await mgrContext.newPage();
    mgrPage.on("pageerror", (err) => console.error("  [Manager page error]", err.message));
    await wireSharedBackend(mgrPage, backend, "mgr");
    await mgrPage.addInitScript(authProviderInitScript({ id: "demo-manager", email: "manager@demo.city-ops", role: "MANAGER", createdAt: now }));

    await mgrPage.goto(`${BASE_URL}/field-officers`);
    await mgrPage.waitForSelector('a[href^="/field-officers/"]', { timeout: 15000 });
    await mgrPage.click('a[href^="/field-officers/"]');
    await mgrPage.waitForSelector('button[title="Review evidence"]', { timeout: 15000 });
    await mgrPage.click('button[title="Review evidence"]');
    await mgrPage.waitForSelector("text=Evidence records", { timeout: 15000 });

    check(await mgrPage.locator("text=Superseded by a later resubmission").isVisible(), "the original evidence is correctly shown as superseded");
    const replacementCard = evidenceCardByFileName(mgrPage, "f_replacement_persist.png");
    check(await replacementCard.getByRole("button", { name: "Approve" }).isVisible(), "(1)(2) an Approve button exists specifically on the NEW REPLACEMENT's own card (not the superseded original's, which shows no action buttons)");
    await replacementCard.getByRole("button", { name: "Approve" }).click();
    await sleep(400);

    const mgrLocalEvidenceAfter = await mgrPage.evaluate(() => JSON.parse(localStorage.getItem("city-ops-os") || "{}").state?.evidence ?? []);
    const replacementLocal = mgrLocalEvidenceAfter.find((e) => e.id === REPLACEMENT_ID);
    check(replacementLocal?.status === "approved", `(5) immediately after the click, the Manager's OWN local store shows the replacement as 'approved' (got '${replacementLocal?.status}')`);
    const asgLocal = await getLocalAssignment(mgrPage, ASG_ID);
    check(asgLocal?.reviewStatus === "pending", `(6)-(9) recalculateAssignmentReviewStatus() ran and flipped the Manager's OWN local assignment.reviewStatus to 'pending' (got '${asgLocal?.reviewStatus}')`);

    // ------------------------------------------------------------------
    console.log("\n[3] THE ACTUAL PERSISTENCE QUESTION: did these writes reach the SHARED backend (not just the Manager's own browser)?");
    // Generous wait for enqueue() (async IndexedDB write) + drainOutbox()
    // (async backend.putDoc()) to actually complete — this is the exact
    // asynchronous gap a purely-local, same-tick assertion would miss.
    await sleep(2000);
    const serverEvidence = backend.store.evidence[REPLACEMENT_ID];
    const serverAssignment = backend.store.assignments[ASG_ID];
    check(serverEvidence?.status === "approved", `(2)(3)(4) the REPLACEMENT evidence document in the SHARED backend itself shows status 'approved' (got '${serverEvidence?.status}') — proves the write left the Manager's browser and actually persisted`);
    check(serverAssignment?.reviewStatus === "pending", `THE CORE QUESTION: the ASSIGNMENT document in the SHARED backend itself shows reviewStatus 'pending' (got '${serverAssignment?.reviewStatus}')`);
    const assignmentPutCalls = backend.putDocLog.filter((c) => c.collection === "assignments" && c.id === ASG_ID);
    console.log(`  Assignment putDoc call log (${assignmentPutCalls.length} call(s)): ${JSON.stringify(assignmentPutCalls.map((c) => ({ reviewStatus: c.data.reviewStatus, at: c.at })))}`);
    check(assignmentPutCalls.length >= 1, "at least one putDoc call was made for this assignment");
    check(assignmentPutCalls[assignmentPutCalls.length - 1]?.data?.reviewStatus === "pending", "the LAST putDoc call for this assignment carries reviewStatus 'pending' — no later, stale write reverted it (rules out a stale-patch race)");
    const evidencePutCalls = backend.putDocLog.filter((c) => c.collection === "evidence" && c.id === REPLACEMENT_ID);
    check(evidencePutCalls.some((c) => c.data.status === "approved"), "a putDoc call for the replacement evidence carrying status 'approved' actually reached the shared backend — the Manager's evidence decision is NOT local-only");

    // ------------------------------------------------------------------
    console.log("\n[4] Does the FO's SEPARATE device (its own context, its own listener) actually observe the change?");
    await foPage.waitForSelector('text="RESUBMITTED"', { state: "detached", timeout: 15000 }).catch(() => {});
    await sleep(500);
    const foStillShowsResubmitted = await foPage.locator("text=RESUBMITTED").isVisible().catch(() => false);
    check(!foStillShowsResubmitted, "THE FIX (production path): the FO's independent device, reading only through the real subscribeCollection()/mergeRemoteCollection() pipeline, no longer shows RESUBMITTED");
    const foStillShowsActionRequired = await foPage.locator("text=ACTION REQUIRED").isVisible().catch(() => false);
    check(!foStillShowsActionRequired, "the FO is not swapped into a different stuck state either");
    const foLocalAssignment = await getLocalAssignment(foPage, ASG_ID);
    check(foLocalAssignment?.reviewStatus === "pending", `the FO's OWN local (synced-from-backend) copy of the assignment shows reviewStatus 'pending' (got '${foLocalAssignment?.reviewStatus}') — same source of truth as the Manager's, not a divergent one`);

    // ------------------------------------------------------------------
    console.log("\n[5] Reload BOTH devices — the shared backend is the actual source of truth, not either browser's in-memory state:");
    await mgrPage.reload();
    await mgrPage.waitForSelector("text=Command Center", { timeout: 15000 });
    await sleep(1500); // let the re-subscribed listeners re-poll and hydrate
    const mgrAfterReload = await getLocalAssignment(mgrPage, ASG_ID);
    check(mgrAfterReload?.reviewStatus === "pending", `Manager device, after a full reload (re-fetching from the shared backend from scratch): reviewStatus is still 'pending' (got '${mgrAfterReload?.reviewStatus}')`);

    await foPage.reload();
    await foPage.waitForSelector("text=Persistence Test Biz", { timeout: 15000 });
    await sleep(1000);
    await foPage.click("text=Persistence Test Biz");
    await sleep(500);
    check(!(await foPage.locator("text=RESUBMITTED").isVisible().catch(() => false)), "FO device, after a full reload, still does not show RESUBMITTED — the shared backend itself (not a transient in-memory state) carries the correct value");

    console.log("\n[6] No automatic assignment approval occurred — reviewStatus is 'pending', never silently 'approved':");
    check(serverAssignment?.reviewStatus !== "approved", "the assignment was never auto-approved by this flow — 'pending' only, exactly as recalculateAssignmentReviewStatus() is designed to produce");

    if (failures > 0) console.error("\n--- SharedBackend final state ---\n" + JSON.stringify(backend.store, null, 2).slice(0, 4000));
    if (failures > 0) console.error("\n--- preview server output (for debugging) ---\n" + serverOutput.slice(-4000));
    await mgrContext.close();
    await foContext.close();
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
