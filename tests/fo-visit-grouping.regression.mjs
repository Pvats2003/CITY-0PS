// Regression test for: the FO Today screen's presentation-level grouping of
// same-business/same-FO/same-time-window assignments into ONE "visit" card
// (e.g. "4 Rigs Assigned"), implemented as groupAssignmentsIntoVisits() /
// visitGroupRigIds() / visitGroupTargetHours() in src/engine/execution.ts and
// consumed by TodayList() in src/pages/FOExecution.tsx.
//
// CRITICAL: this is a PRESENTATION-ONLY change. The underlying Assignment
// records are never merged, mutated, or deleted — each rig keeps its own
// assignmentId, status, reviewStatus, and evidence scoping exactly as
// before. This test proves that by reading back the real per-assignment
// state after every UI interaction, never by inspecting rendered DOM alone.
//
// Covers the 14 scenarios from the product requirement:
//   (1) 1 business + 1 FO + 1 rig -> 1 (unchanged, non-grouped) card
//   (2)/(3)/(4) 2/3/4 rigs, same business/FO/time -> 1 grouped visit card,
//       target hours = rigs x 10 (20h/30h/40h), never hardcoded per-count
//   (5) two businesses -> two separate visit cards (never merged across
//       businesses just because they share an FO)
//   (6) same business, two legitimately separate visit windows on the same
//       day -> two separate cards, never blindly merged by businessId alone
//   (7) one rig has evidence, another has none -> no cross-leakage at the
//       data layer after the grouped card renders
//   (8) one rig requires recheck -> ONLY that rig's row shows the recheck
//       indicator; the assignment-level reviewStatus stays authoritative
//   (9) completing one rig's assignment leaves the others independently
//       incomplete, reflected in the card's aggregate "N / M rigs completed"
//   (10) reload -> grouping is recomputed fresh from the same persisted
//       state, not cached/stale
//   (11) cross-device sync (via the established __CITY_OPS_TEST_BACKEND__
//       mock-Firestore seam) -> a rig added from "another device" is picked
//       up by this device's next listener refresh and the visit regroups
//       correctly (2 rigs -> 3 rigs), still one card
//   (12) mobile 375x812 / 390x844 / 412x915 -> no horizontal overflow on the
//       grouped card
//   (13)/(14) light and dark theme -> both render without layout breakage
//
// Run with: npm run test:fo-visit-grouping

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4197;
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
  function readStore() {
    try { return JSON.parse(localStorage.getItem(MOCK_KEY) || "{}"); } catch { return {}; }
  }
  function writeStore(store) {
    localStorage.setItem(MOCK_KEY, JSON.stringify(store));
  }
  window.__CITY_OPS_TEST_BACKEND__ = {
    async putDoc(collection, id, data) {
      for (const key of Object.keys(data)) {
        if (data[key] === undefined) throw new Error("Unsupported field value: undefined (found in field " + key + ")");
      }
      const store = readStore();
      store[collection] = store[collection] || {};
      store[collection][id] = data;
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

function emptyCityData(overrides) {
  return {
    version: 2,
    settings: { cityName: "Test City", workingHoursStart: "08:00", workingHoursEnd: "23:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
    businesses: [],
    fos: [],
    collectors: [],
    rigs: [],
    assignments: [],
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
    ...overrides,
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

    const today = new Date().toISOString().slice(0, 10);
    const iso = (t) => `${today}T${t}:00.000Z`;
    const FO_ID = "fo_grouping_test";
    const now = new Date().toISOString();

    const businesses = [
      { id: "biz_single", name: "Single Rig Biz", category: "General", area: "Area", address: "", capacityHoursPerDay: 10, active: true, createdAt: now },
      { id: "biz_two", name: "Two Rig Biz", category: "General", area: "Area", address: "", capacityHoursPerDay: 20, active: true, createdAt: now },
      { id: "biz_three", name: "Three Rig Biz", category: "General", area: "Area", address: "", capacityHoursPerDay: 30, active: true, createdAt: now },
      { id: "biz_four", name: "Four Rig Biz", category: "General", area: "Area", address: "", capacityHoursPerDay: 40, active: true, createdAt: now },
      { id: "biz_mb_a", name: "MultiBiz Alpha", category: "General", area: "Area", address: "", capacityHoursPerDay: 20, active: true, createdAt: now },
      { id: "biz_mb_b", name: "MultiBiz Bravo", category: "General", area: "Area", address: "", capacityHoursPerDay: 10, active: true, createdAt: now },
      { id: "biz_split", name: "Split Window Biz", category: "General", area: "Area", address: "", capacityHoursPerDay: 20, active: true, createdAt: now },
    ];
    const fos = [{ id: FO_ID, name: "Grouping Test FO", active: true, createdAt: now }];
    const rigDefs = [
      ["rig_s", "R-S"],
      ["rig_2a", "R-2A"],
      ["rig_2b", "R-2B"],
      ["rig_3a", "R-3A"],
      ["rig_3b", "R-3B"],
      ["rig_3c", "R-3C"],
      ["rig_4a", "R-4A"],
      ["rig_4b", "R-4B"],
      ["rig_4c", "R-4C"],
      ["rig_4d", "R-4D"],
      ["rig_mba1", "R-MBA1"],
      ["rig_mba2", "R-MBA2"],
      ["rig_mbb1", "R-MBB1"],
      ["rig_split_a", "R-SPLITA"],
      ["rig_split_b", "R-SPLITB"],
    ];
    const rigs = rigDefs.map(([id, code]) => ({ id, code, model: "Test Rig", active: true, batteryPct: 100, storagePct: 0, deploymentStatus: "active", createdAt: now }));

    function mkAssignment({ id, businessId, rigId, start, end }) {
      return {
        id,
        date: today,
        businessId,
        foId: FO_ID,
        rigId,
        plannedStart: iso(start),
        plannedEnd: iso(end),
        priority: "normal",
        status: "confirmed",
        createdAt: now,
      };
    }

    const assignments = [
      // (1) single rig, single business -> unchanged single-card behavior
      mkAssignment({ id: "asg_single", businessId: "biz_single", rigId: "rig_s", start: "08:00", end: "11:00" }),
      // (2) 2 rigs, same business/FO/time -> 1 card, 20h target
      mkAssignment({ id: "asg_2a", businessId: "biz_two", rigId: "rig_2a", start: "09:00", end: "19:00" }),
      mkAssignment({ id: "asg_2b", businessId: "biz_two", rigId: "rig_2b", start: "09:00", end: "19:00" }),
      // (3) 3 rigs -> 1 card, 30h target
      mkAssignment({ id: "asg_3a", businessId: "biz_three", rigId: "rig_3a", start: "09:00", end: "19:00" }),
      mkAssignment({ id: "asg_3b", businessId: "biz_three", rigId: "rig_3b", start: "09:00", end: "19:00" }),
      mkAssignment({ id: "asg_3c", businessId: "biz_three", rigId: "rig_3c", start: "09:00", end: "19:00" }),
      // (4) 4 rigs -> 1 card, 40h target; also carries the recheck (8),
      // completion (9), and evidence-isolation (7) fixtures
      mkAssignment({ id: "asg_4a", businessId: "biz_four", rigId: "rig_4a", start: "09:00", end: "19:00" }),
      mkAssignment({ id: "asg_4b", businessId: "biz_four", rigId: "rig_4b", start: "09:00", end: "19:00" }),
      mkAssignment({ id: "asg_4c", businessId: "biz_four", rigId: "rig_4c", start: "09:00", end: "19:00" }),
      mkAssignment({ id: "asg_4d", businessId: "biz_four", rigId: "rig_4d", start: "09:00", end: "19:00" }),
      // (5) multi-business regression: 2 rigs at Alpha, 1 rig at Bravo,
      // same FO/time -> two cards, never merged across businesses
      mkAssignment({ id: "asg_mba1", businessId: "biz_mb_a", rigId: "rig_mba1", start: "09:00", end: "19:00" }),
      mkAssignment({ id: "asg_mba2", businessId: "biz_mb_a", rigId: "rig_mba2", start: "09:00", end: "19:00" }),
      mkAssignment({ id: "asg_mbb1", businessId: "biz_mb_b", rigId: "rig_mbb1", start: "09:00", end: "19:00" }),
      // (6) separate-visits regression: same business, two disjoint windows
      // -> two cards, never merged just because businessId matches
      mkAssignment({ id: "asg_split_1", businessId: "biz_split", rigId: "rig_split_a", start: "09:00", end: "19:00" }),
      mkAssignment({ id: "asg_split_2", businessId: "biz_split", rigId: "rig_split_b", start: "20:00", end: "22:00" }),
    ];
    // (8) recheck isolation: only rig_4a's assignment is flagged
    assignments.find((a) => a.id === "asg_4a").reviewStatus = "recheck_requested";
    // (9) completion isolation: only rig_4b's assignment is completed
    assignments.find((a) => a.id === "asg_4b").status = "completed";

    const evidence = [
      // (7) evidence isolation: rig_4c has 3 records, rig_4d has 0
      { id: "ev_4c_1", assignmentId: "asg_4c", businessId: "biz_four", foId: FO_ID, type: "RIG_PRECHECK", startedAt: now, capturedAt: now, files: [], status: "submitted", metadata: { passed: true, checklist: {}, failedItems: [] }, createdAt: now },
      { id: "ev_4c_2", assignmentId: "asg_4c", businessId: "biz_four", foId: FO_ID, type: "INSTALLATION", startedAt: now, capturedAt: now, files: [], status: "submitted", metadata: { passed: true, checklist: {}, failedItems: [] }, createdAt: now },
      { id: "ev_4c_3", assignmentId: "asg_4c", businessId: "biz_four", foId: FO_ID, type: "SESSION_START", startedAt: now, capturedAt: now, files: [], status: "submitted", metadata: {}, createdAt: now },
    ];

    async function seed(page) {
      await page.evaluate(
        ({ businesses, fos, rigs, assignments, evidence }) => {
          const cityData = {
            version: 2,
            settings: { cityName: "Test City", workingHoursStart: "08:00", workingHoursEnd: "23:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
            businesses,
            fos,
            collectors: [],
            rigs,
            assignments,
            sessions: [],
            evidence,
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
        },
        { businesses, fos, rigs, assignments, evidence },
      );
    }

    async function signInAsFo(page) {
      await page.evaluate((foId) => {
        localStorage.setItem(
          "city-ops-auth",
          JSON.stringify({ id: "demo-fo-" + foId, email: "grouping.fo@demo.city-ops", role: "FIELD_OFFICER", displayName: "Grouping Test FO", foId, createdAt: new Date().toISOString() }),
        );
      }, FO_ID);
    }

    // ==================================================================
    console.log("\n[1-10] Core grouping scenarios (single context, seeded via localStorage):");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (err) => console.error("  [page error]", err.message));
    await page.goto(`${BASE_URL}/fo`);
    await seed(page);
    await signInAsFo(page);
    await page.goto(`${BASE_URL}/fo`);
    await page.waitForSelector("text=Today", { timeout: 15000 });
    await sleep(1000);

    let bodyText = await page.evaluate(() => document.body.innerText);
    check(bodyText.includes("8 VISITS"), `(header) FO Today shows "8 VISITS" for 15 assignments grouped into 8 physical visits (got body containing: ${(bodyText.match(/\d+ VISITS?/) || ["<none>"])[0]})`);

    console.log("\n  (1) Single rig business renders as a normal, unchanged single card:");
    const singleCardText = await page.locator("button", { hasText: "Single Rig Biz" }).first().innerText();
    check(!/Rigs? Assigned/.test(singleCardText), "(1) the single-rig visit card does NOT show 'N Rig(s) Assigned' framing");
    check(singleCardText.includes("R-S"), "(1) the single-rig card still shows the rig code inline, as before grouping existed");

    console.log("\n  (2)/(3)/(4) 2/3/4-rig visits each collapse into ONE card with the correct rig count, rig list, and target hours:");
    for (const [bizName, count, targetH, rigCodes] of [
      ["Two Rig Biz", 2, "20h", ["R-2A", "R-2B"]],
      ["Three Rig Biz", 3, "30h", ["R-3A", "R-3B", "R-3C"]],
      ["Four Rig Biz", 4, "40h", ["R-4A", "R-4B", "R-4C", "R-4D"]],
    ]) {
      const cardText = await page.locator("div.rounded-lg", { hasText: bizName }).first().innerText();
      check(cardText.includes(`${count} Rig${count === 1 ? "" : "s"} Assigned`), `(${count}) ${bizName} shows "${count} Rigs Assigned" as ONE card, not ${count} separate business cards`);
      check(cardText.includes(`Target ${targetH}`), `(${count}) ${bizName} target hours = ${count} rigs × 10h = ${targetH} — computed, not hardcoded per rig-count`);
      for (const code of rigCodes) {
        check(cardText.includes(code), `(${count}) ${bizName}'s grouped card lists rig ${code}`);
      }
    }

    console.log("\n  (5) Multi-business regression: Alpha (2 rigs) and Bravo (1 rig) render as TWO separate cards, not merged:");
    const alphaCardText = await page.locator("div.rounded-lg", { hasText: "MultiBiz Alpha" }).first().innerText();
    check(alphaCardText.includes("2 Rigs Assigned"), "(5) MultiBiz Alpha shows '2 Rigs Assigned'");
    const bravoCardText = await page.locator("button", { hasText: "MultiBiz Bravo" }).first().innerText();
    check(!/Rigs? Assigned/.test(bravoCardText), "(5) MultiBiz Bravo (1 rig) renders as its own normal single card, distinct from Alpha's grouped card");

    console.log("\n  (6) Separate-visits regression: same business, two disjoint time windows, must NOT be merged into one card:");
    const splitCardCount = await page.locator("text=Split Window Biz").count();
    check(splitCardCount === 2, `(6) 'Split Window Biz' appears as TWO separate cards (one per visit window), not one merged card — got ${splitCardCount} occurrence(s)`);

    console.log("\n  (7) Evidence isolation at the data layer (rig_4c has 3 records, rig_4d has 0) survives the grouped render:");
    const evidenceState = await page.evaluate(() => JSON.parse(localStorage.getItem("city-ops-os")).state.evidence);
    check(evidenceState.filter((e) => e.assignmentId === "asg_4c").length === 3, "(7) rig 4c's assignment still has exactly its own 3 evidence records after the grouped card rendered");
    check(evidenceState.filter((e) => e.assignmentId === "asg_4d").length === 0, "(7) rig 4d's assignment still has ZERO evidence records — no cross-rig leakage introduced by grouping");

    console.log("\n  (8) Recheck isolation: only rig 4a's row shows the recheck indicator:");
    const recheckOccurrences = await page.locator("text=Recheck required").count();
    check(recheckOccurrences === 1, `(8) exactly ONE 'Recheck required' indicator on the whole page (for rig 4a only) — got ${recheckOccurrences}`);
    const fourCardFullText = await page.locator("div.rounded-lg", { hasText: "Four Rig Biz" }).first().innerText();
    check(fourCardFullText.includes("Recheck required"), "(8) the recheck indicator is inside the Four Rig Biz card (rig 4a's own row)");
    const assignmentsAfterRender = await page.evaluate(() => JSON.parse(localStorage.getItem("city-ops-os")).state.assignments);
    check(
      assignmentsAfterRender.filter((a) => a.reviewStatus === "recheck_requested").length === 1 && assignmentsAfterRender.find((a) => a.id === "asg_4a").reviewStatus === "recheck_requested",
      "(8) the assignment-level reviewStatus stays authoritative and scoped to asg_4a only",
    );

    console.log("\n  (9) Completing one rig leaves the others independently incomplete, reflected in the aggregate count:");
    check(fourCardFullText.includes("1 / 4 rigs completed"), `(9) Four Rig Biz card reads '1 / 4 rigs completed' (only rig 4b is done) — got a card containing: ${fourCardFullText.slice(0, 120)}`);

    console.log("\n  (10) Reload: grouping is recomputed fresh from the same persisted state, not cached/stale:");
    await page.reload();
    await page.waitForSelector("text=Today", { timeout: 15000 });
    await sleep(1000);
    const bodyTextAfterReload = await page.evaluate(() => document.body.innerText);
    check(bodyTextAfterReload.includes("8 VISITS"), "(10) after reload, still exactly '8 VISITS'");
    check(bodyTextAfterReload.includes("4 Rigs Assigned"), "(10) after reload, Four Rig Biz still groups into '4 Rigs Assigned'");
    check(bodyTextAfterReload.includes("1 / 4 rigs completed"), "(10) after reload, completion aggregate is still correct");
    check((bodyTextAfterReload.match(/Split Window Biz/g) || []).length === 2, "(10) after reload, the two separate Split Window Biz visits are still NOT merged");

    await context.close();

    // ==================================================================
    console.log("\n[11] CROSS-DEVICE SYNC: a rig added from 'another device' via the shared mock backend regroups this device's visit correctly:");
    const syncContext = await browser.newContext();
    const syncPage = await syncContext.newPage();
    await syncPage.addInitScript(MOCK_BACKEND_INIT_SCRIPT);
    syncPage.on("pageerror", (err) => console.error("  [page error]", err.message));

    const SYNC_FO = "fo_sync_test";
    const SYNC_BIZ = "biz_sync_test";
    const syncNow = new Date().toISOString();
    const syncBusiness = { id: SYNC_BIZ, name: "Sync Test Biz", category: "General", area: "Area", address: "", capacityHoursPerDay: 20, active: true, createdAt: syncNow };
    const syncFo = { id: SYNC_FO, name: "Sync Test FO", active: true, createdAt: syncNow };
    const syncRigs = [
      { id: "rig_sync_a", code: "R-SYNC-A", model: "Test Rig", active: true, batteryPct: 100, storagePct: 0, deploymentStatus: "active", createdAt: syncNow },
      { id: "rig_sync_b", code: "R-SYNC-B", model: "Test Rig", active: true, batteryPct: 100, storagePct: 0, deploymentStatus: "active", createdAt: syncNow },
      { id: "rig_sync_c", code: "R-SYNC-C", model: "Test Rig", active: true, batteryPct: 100, storagePct: 0, deploymentStatus: "active", createdAt: syncNow },
    ];
    const syncAssignmentsInitial = [
      mkAssignment({ id: "asg_sync_a", businessId: SYNC_BIZ, rigId: "rig_sync_a", start: "09:00", end: "19:00" }),
      mkAssignment({ id: "asg_sync_b", businessId: SYNC_BIZ, rigId: "rig_sync_b", start: "09:00", end: "19:00" }),
    ].map((a) => ({ ...a, foId: SYNC_FO }));

    await syncPage.goto(`${BASE_URL}/fo`);
    await syncPage.evaluate(
      ({ syncBusiness, syncFo, syncRigs, syncAssignmentsInitial, SYNC_FO }) => {
        const now = new Date().toISOString();
        const cityData = {
          version: 2,
          settings: { cityName: "Test City", workingHoursStart: "08:00", workingHoursEnd: "23:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
          businesses: [syncBusiness],
          fos: [syncFo],
          collectors: [],
          rigs: syncRigs,
          assignments: syncAssignmentsInitial,
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
          "__mock_firestore_store__",
          JSON.stringify({
            businesses: { [syncBusiness.id]: syncBusiness },
            fos: { [syncFo.id]: syncFo },
            rigs: Object.fromEntries(syncRigs.map((r) => [r.id, r])),
            assignments: Object.fromEntries(syncAssignmentsInitial.map((a) => [a.id, a])),
            evidence: {},
          }),
        );
        localStorage.setItem(
          "city-ops-auth",
          JSON.stringify({ id: "demo-fo-" + SYNC_FO, email: "sync.fo@demo.city-ops", role: "FIELD_OFFICER", displayName: "Sync Test FO", foId: SYNC_FO, createdAt: now }),
        );
      },
      { syncBusiness, syncFo, syncRigs, syncAssignmentsInitial, SYNC_FO },
    );
    await syncPage.goto(`${BASE_URL}/fo`);
    await syncPage.waitForSelector("text=Today", { timeout: 15000 });
    await sleep(1000);
    let syncBodyText = await syncPage.evaluate(() => document.body.innerText);
    check(syncBodyText.includes("2 Rigs Assigned"), "(11) before the remote change: 'Sync Test Biz' shows '2 Rigs Assigned'");

    console.log("  Simulating a manager on another device assigning a 3rd rig to the same visit, via the shared backend...");
    const syncAssignment3 = { ...mkAssignment({ id: "asg_sync_c", businessId: SYNC_BIZ, rigId: "rig_sync_c", start: "09:00", end: "19:00" }), foId: SYNC_FO };
    await syncPage.evaluate((a) => {
      const store = JSON.parse(localStorage.getItem("__mock_firestore_store__"));
      store.assignments[a.id] = a;
      localStorage.setItem("__mock_firestore_store__", JSON.stringify(store));
    }, syncAssignment3);

    console.log("  This device's next listener refresh (reload re-subscribes via subscribeCollection) must pick up the remote rig and regroup:");
    await syncPage.reload();
    await syncPage.waitForSelector("text=Today", { timeout: 15000 });
    await sleep(1000);
    syncBodyText = await syncPage.evaluate(() => document.body.innerText);
    check(syncBodyText.includes("3 Rigs Assigned"), "(11) after the remote rig is picked up by the listener refresh, the SAME visit now shows '3 Rigs Assigned' (still one card, not a new/duplicate business card)");
    check(!/2 Rigs Assigned/.test(syncBodyText), "(11) the stale '2 Rigs Assigned' count is gone — the group recomputed fresh from the synced data, not cached");
    check(syncBodyText.includes("R-SYNC-C"), "(11) the newly-synced rig's own code is listed in the regrouped card");
    const syncCardCount = await syncPage.locator("text=Sync Test Biz").count();
    check(syncCardCount === 1, "(11) still exactly ONE card for Sync Test Biz after the remote rig arrived — not split into a second card");

    await syncContext.close();

    // ==================================================================
    console.log("\n[12] MOBILE: 375x812 / 390x844 / 412x915, no horizontal overflow on the grouped 4-rig card:");
    for (const [w, h] of [
      [375, 812],
      [390, 844],
      [412, 915],
    ]) {
      const mobileContext = await browser.newContext({ viewport: { width: w, height: h } });
      const mobilePage = await mobileContext.newPage();
      mobilePage.on("pageerror", (err) => console.error("  [page error]", err.message));
      await mobilePage.goto(`${BASE_URL}/fo`);
      await seed(mobilePage);
      await signInAsFo(mobilePage);
      await mobilePage.goto(`${BASE_URL}/fo`);
      await mobilePage.waitForSelector("text=Today", { timeout: 15000 });
      await sleep(800);
      const overflowInfo = await mobilePage.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      check(overflowInfo.scrollWidth <= overflowInfo.clientWidth + 1, `(12) at ${w}x${h}: no horizontal overflow (scrollWidth ${overflowInfo.scrollWidth} <= clientWidth ${overflowInfo.clientWidth})`);
      const mobileText = await mobilePage.evaluate(() => document.body.innerText);
      check(mobileText.includes("4 Rigs Assigned"), `(12) at ${w}x${h}: the grouped 4-rig card still renders correctly`);
      await mobileContext.close();
    }

    // ==================================================================
    console.log("\n[13]/[14] LIGHT and DARK theme, grouped card renders correctly in both:");
    for (const theme of ["light", "dark"]) {
      const themeContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const themePage = await themeContext.newPage();
      themePage.on("pageerror", (err) => console.error("  [page error]", err.message));
      await themePage.goto(`${BASE_URL}/fo`);
      await themePage.evaluate(
        ({ businesses, fos, rigs, assignments, evidence, theme }) => {
          const cityData = {
            version: 2,
            settings: { cityName: "Test City", workingHoursStart: "08:00", workingHoursEnd: "23:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme, onboarded: true },
            businesses,
            fos,
            collectors: [],
            rigs,
            assignments,
            sessions: [],
            evidence,
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
        },
        { businesses, fos, rigs, assignments, evidence, theme },
      );
      await signInAsFo(themePage);
      await themePage.goto(`${BASE_URL}/fo`);
      await themePage.waitForSelector("text=Today", { timeout: 15000 });
      await sleep(800);
      const isDark = await themePage.evaluate(() => document.documentElement.classList.contains("dark"));
      check(isDark === (theme === "dark"), `(${theme === "dark" ? "14" : "13"}) document root 'dark' class matches the ${theme} theme setting`);
      const themeBodyText = await themePage.evaluate(() => document.body.innerText);
      check(themeBodyText.includes("4 Rigs Assigned"), `(${theme === "dark" ? "14" : "13"}) grouped 4-rig card renders correctly in ${theme} theme`);
      check(themeBodyText.includes("Recheck required"), `(${theme === "dark" ? "14" : "13"}) recheck indicator still visible in ${theme} theme`);
      const themeOverflow = await themePage.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
      check(themeOverflow.scrollWidth <= themeOverflow.clientWidth + 1, `(${theme === "dark" ? "14" : "13"}) no horizontal overflow in ${theme} theme`);
      await themeContext.close();
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
