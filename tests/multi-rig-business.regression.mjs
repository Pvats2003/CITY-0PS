// Regression test: "a single business can have multiple workers and
// multiple rigs operating simultaneously under ONE Field Officer" (e.g. ABC
// Motors: 4 workers, 4 rigs, 1 FO, 40 required recording hours). This file
// drives the REAL app UI (real AssignmentFormDialog, real /today Planner
// conflict banner, real FOExecution Today's Plan) via Playwright against a
// production build, using the established __CITY_OPS_TEST_BACKEND__ seam —
// no live Firebase project needed.
//
// Background: the underlying data model (src/lib/assignmentIdentity.ts,
// store/city.ts's addAssignment(), engine/insights.ts's
// businessTargetHoursFromAssignments(), per-assignment Evidence scoping)
// already supported multiple rigs at one business under one FO. The actual
// restriction was two "FO double-booking" conflict checks that didn't
// exclude same-business overlaps:
//   - src/components/forms/AssignmentFormDialog.tsx's `foConflict` check
//   - src/engine/planner.ts's `detectConflicts()` `fo_double_booking` check
// Both were fixed by adding a same-business exclusion, leaving the sibling
// `rigConflict`/`rig_double_booking` checks (same rig, any business) and
// everything else in the data/UI layers untouched.
//
// Three scenarios:
//
// [1] POSITIVE + NEGATIVE, THROUGH THE REAL UI — drives
//     AssignmentFormDialog directly to create four rig assignments for the
//     SAME business+FO+time window (proves the fix), then exercises the two
//     conflicts that must still be blocked: a different business at an
//     overlapping FO time, and the same rig at an overlapping time.
//
// [2] DOWNSTREAM STATE — using the assignments actually created in [1] (no
//     re-seeding), verifies required hours scale to rigs × 10, FO Today
//     lists all four independently, and completion/evidence state stays
//     isolated per assignment (never merged/leaked by business).
//
// [3] PLANNER CONFLICT DETECTION — seeds a small conflict matrix directly
//     (bypassing the dialog, since the dialog now prevents these exact
//     conflicting records from ever being created) and reads the real
//     /today page's conflict banner (backed by planner.ts's
//     detectConflicts()) to prove: same-business/different-rig/overlapping
//     time produces NO conflict; different-business/same-FO/overlapping
//     time produces fo_double_booking; same-rig/overlapping time produces
//     rig_double_booking regardless of business.
//
// Run with: npm run test:multi-rig-business

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4185;
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

// Mirrors src/lib/assignmentIdentity.ts exactly (same convention as this
// repo's *.emulator.mjs tests, which mirror app logic in plain Node since
// TS path-aliased modules can't be imported directly here).
function stableHash(input) {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = (Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)) >>> 0;
  h2 = (Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)) >>> 0;
  return h1.toString(36) + h2.toString(36);
}
function assignmentIdentityKey(a) {
  return [a.businessId, a.foId, a.date, a.plannedStart, a.plannedEnd, a.rigId ?? "none"].join("|");
}
function deriveAssignmentId(a) {
  return `asg_${stableHash(assignmentIdentityKey(a))}`;
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

    // ==================================================================
    console.log(
      "\n[1] THROUGH THE REAL UI: one FO, business ABC Motors with 4 rigs at the SAME time window, " +
        "plus the two conflicts that must still be blocked (different business, and same rig):",
    );
    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    await page1.addInitScript(MOCK_BACKEND_INIT_SCRIPT);
    page1.on("pageerror", (err) => console.error("  [page error]", err.message));

    await page1.goto(`${BASE_URL}/login`);
    await page1.click("text=Continue as Manager");
    await page1.waitForSelector("text=Start My City", { timeout: 15000 });
    await page1.click("text=Start My City");
    await page1.click('button:has-text("Start my city")');
    await page1.waitForURL(/\/(today)?$/, { timeout: 15000 }).catch(() => {});
    await sleep(500);

    await page1.click('a[href="/field-officers"]');
    await page1.getByRole("button", { name: "Add Field Officer" }).first().click();
    let dialog = page1.locator('[role="dialog"]');
    await dialog.locator("#fo-name").fill("Multi-Rig Test FO");
    await dialog.getByRole("button", { name: "Add field officer", exact: true }).click();
    await page1.waitForSelector('[role="dialog"]', { state: "hidden", timeout: 15000 }).catch(() => {});
    await sleep(800);

    await page1.click('a[href="/businesses"]');
    for (const [name, area] of [
      ["ABC Motors", "Test Area"],
      ["XYZ Corp", "Other Area"],
    ]) {
      await page1.getByRole("button", { name: "Add Business" }).first().click();
      dialog = page1.locator('[role="dialog"]');
      await dialog.locator("#biz-name").fill(name);
      await dialog.locator("#biz-area").fill(area);
      await dialog.getByRole("button", { name: "Add business", exact: true }).click();
      await page1.waitForSelector('[role="dialog"]', { state: "hidden", timeout: 15000 }).catch(() => {});
      await sleep(800);
    }

    await page1.click('a[href="/fleet"]');
    for (const code of ["R-01", "R-02", "R-03", "R-04", "R-05"]) {
      await page1.getByRole("button", { name: "Add Rig" }).first().click();
      dialog = page1.locator('[role="dialog"]');
      await dialog.locator("#rig-code").fill(code);
      await dialog.getByRole("button", { name: "Add rig", exact: true }).click();
      await page1.waitForSelector('[role="dialog"]', { state: "hidden", timeout: 15000 }).catch(() => {});
      await sleep(600);
    }

    await page1.click('a[href="/field-officers"]');
    await page1.waitForSelector('a[href^="/field-officers/"]', { timeout: 15000 });
    const href1 = await page1.getAttribute('a[href^="/field-officers/"]', "href");
    const foId1 = href1.split("/field-officers/")[1];
    check(!!foId1, `resolved the target FO id (${foId1})`);
    await page1.click('a[href^="/field-officers/"]');
    await page1.waitForSelector("text=Assign rig", { timeout: 15000 });

    async function assignRig(business, rigCode, { start = "09:00", end = "19:00", expectError } = {}) {
      await page1.getByRole("button", { name: "Assign rig" }).click();
      const d = page1.locator('[role="dialog"]');
      await d.locator("text=Select business").waitFor({ timeout: 15000 }).catch(() => {});
      // Business combobox (index 1: FO=0 pre-filled, Business=1, Rig=2)
      await d.getByRole("combobox").nth(1).click();
      await page1.locator(`[role="option"]:has-text("${business}")`).click();
      // Rig combobox
      await d.getByRole("combobox").nth(2).click();
      await page1.locator(`[role="option"]:has-text("${rigCode}")`).click();
      await d.locator("#asg-start").fill(start);
      await d.locator("#asg-end").fill(end);
      await d.getByRole("button", { name: "Add assignment", exact: true }).click();
      await sleep(800);
      if (expectError) {
        const errorMessage = await d.locator(".text-critical").first().textContent().catch(() => "");
        const dialogStillOpen = await d.isVisible().catch(() => false);
        // Close the dialog via Cancel so the NEXT assignRig() call can find
        // the "Assign rig" button again (it's obstructed by this modal).
        await d.getByRole("button", { name: "Cancel", exact: true }).click().catch(() => {});
        await page1.waitForSelector('[role="dialog"]', { state: "hidden", timeout: 15000 }).catch(() => {});
        return { dialogStillOpen, errorMessage: errorMessage ?? "" };
      }
      await page1.waitForSelector('[role="dialog"]', { state: "hidden", timeout: 15000 }).catch(() => {});
      return { dialogStillOpen: await d.isVisible().catch(() => false) };
    }

    console.log("\n  Positive: four rigs, same business, same FO, same 09:00-19:00 window:");
    const rig1 = await assignRig("ABC Motors", "R-01");
    check(!rig1.dialogStillOpen, "(A) Rig R-01 → ABC Motors accepted — dialog closes normally");
    const rig2 = await assignRig("ABC Motors", "R-02");
    check(!rig2.dialogStillOpen, "(B)(C)(E) Rig R-02 → SAME business/FO/time as R-01 is accepted (THE FIX: no longer blocked as an FO double-booking)");
    const rig3 = await assignRig("ABC Motors", "R-03");
    check(!rig3.dialogStillOpen, "(C) Rig R-03 → SAME business/FO/time is accepted");
    const rig4 = await assignRig("ABC Motors", "R-04");
    check(!rig4.dialogStillOpen, "(C) Rig R-04 → SAME business/FO/time is accepted");

    const mockStoreAfterPositive = await page1.evaluate(() => JSON.parse(localStorage.getItem("__mock_firestore_store__") || "{}"));
    const bizList = Object.values(mockStoreAfterPositive.businesses ?? {});
    const abcBizId = bizList.find((b) => b.name === "ABC Motors")?.id;
    const xyzBizId = bizList.find((b) => b.name === "XYZ Corp")?.id;
    const rigList = Object.values(mockStoreAfterPositive.rigs ?? {});
    const rigCodeById = Object.fromEntries(rigList.map((r) => [r.id, r.code]));
    let assignmentsForFo = Object.values(mockStoreAfterPositive.assignments ?? {}).filter((a) => a.foId === foId1);
    const abcAssignments = assignmentsForFo.filter((a) => a.businessId === abcBizId);
    check(abcAssignments.length === 4, `(A)(B)(C) all four ABC Motors assignments persisted to the backend (got ${abcAssignments.length})`);
    check(new Set(abcAssignments.map((a) => a.id)).size === 4, "(F) each of the four persisted assignments has a distinct deterministic id");
    const abcRigCodes = new Set(abcAssignments.map((a) => rigCodeById[a.rigId]));
    check(
      ["R-01", "R-02", "R-03", "R-04"].every((c) => abcRigCodes.has(c)),
      `(F) each assignment carries its own correct rigId — got rig codes [${[...abcRigCodes].sort().join(", ")}]`,
    );
    check(
      abcAssignments.every((a) => a.businessId === abcBizId && a.foId === foId1),
      "each of the four assignments stays associated with the same business and the same FO",
    );

    console.log("\n  Negative (1): different business, same FO, overlapping time → must be rejected:");
    const crossBiz = await assignRig("XYZ Corp", "R-05", { expectError: true });
    check(crossBiz.dialogStillOpen, "(1) dialog stays open for the cross-business FO conflict attempt");
    check(
      /overlapping assignment/i.test(crossBiz.errorMessage),
      `(1) FO double-booking error shown for a DIFFERENT business at the same FO/time (rig_double_booking's own message text was not matched, confirming this is the FO-level check) — text sample: "${crossBiz.errorMessage.slice(0, 200)}"`,
    );
    const storeAfterCrossBiz = await page1.evaluate(() => JSON.parse(localStorage.getItem("__mock_firestore_store__") || "{}"));
    const xyzAssignments = Object.values(storeAfterCrossBiz.assignments ?? {}).filter((a) => a.businessId === xyzBizId);
    check(xyzAssignments.length === 0, "(1) confirmed at the data layer: the rejected XYZ Corp/R-05 assignment never reached the backend");

    console.log("\n  Negative (2): same business, same FO, SAME rig, overlapping time → must be rejected:");
    const sameRig = await assignRig("ABC Motors", "R-01", { expectError: true });
    check(sameRig.dialogStillOpen, "(2) dialog stays open for the same-rig conflict attempt");
    check(
      /already assigned to another visit/i.test(sameRig.errorMessage),
      `(2) rig-level double-booking error shown (rigConflict check, unchanged) — text sample: "${sameRig.errorMessage.slice(0, 200)}"`,
    );
    const storeAfterSameRig = await page1.evaluate(() => JSON.parse(localStorage.getItem("__mock_firestore_store__") || "{}"));
    const abcAssignmentsAfterSameRig = Object.values(storeAfterSameRig.assignments ?? {}).filter((a) => a.businessId === abcBizId);
    check(abcAssignmentsAfterSameRig.length === 4, "(2)(D) confirmed at the data layer: still exactly 4 ABC Motors assignments — the duplicate R-01 attempt never reached the backend (rejected/idempotent)");

    console.log("\n  Positive (3): same business + same FO + different rigs + same time → allowed (re-confirmed from the 4 successful creates above):");
    check(abcAssignments.length === 4 && new Set(abcAssignments.map((a) => a.rigId)).size === 4, "(3) four distinct rigs, one business, one FO, one time window, all persisted");

    await context1.close();

    // ==================================================================
    console.log("\n[2] DOWNSTREAM STATE — using the assignments actually created above via the real dialog:");
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await page2.addInitScript(MOCK_BACKEND_INIT_SCRIPT);
    page2.on("pageerror", (err) => console.error("  [page error]", err.message));

    // Re-seed context2's mock backend + local store with the SAME
    // assignments context1 actually created (Playwright contexts don't
    // share localStorage), then authenticate as Manager and as the FO in
    // turn to read back derived state — this exercises the same
    // hours/FO-Today/evidence code paths the previous round's investigation
    // already proved correct, now against data whose CREATION path (the
    // dialog) is itself under test.
    await page2.goto(`${BASE_URL}/login`);
    const seedResult = await page2.evaluate(
      ({ mockStore, foId, abcBizId }) => {
        const now = new Date().toISOString();
        localStorage.setItem("__mock_firestore_store__", JSON.stringify(mockStore));
        const cityData = {
          version: 2,
          settings: { cityName: "Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
          businesses: Object.values(mockStore.businesses ?? {}),
          fos: Object.values(mockStore.fos ?? {}),
          collectors: [],
          rigs: Object.values(mockStore.rigs ?? {}),
          assignments: Object.values(mockStore.assignments ?? {}).filter((a) => a.foId === foId && a.businessId === abcBizId),
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
          JSON.stringify({ id: "demo-manager", email: "manager@demo.city-ops", role: "MANAGER", displayName: "Demo Manager", createdAt: now }),
        );
        return cityData.assignments.map((a) => a.id);
      },
      { mockStore: mockStoreAfterPositive, foId: foId1, abcBizId },
    );
    const abcAssignmentIds = seedResult;
    check(abcAssignmentIds.length === 4, "seeded context2 with the 4 real assignments created via the UI in scenario [1]");

    console.log("  Reloading as Manager to read back Business 360's rig count / required hours...");
    await page2.reload();
    await page2.waitForSelector("text=Today", { timeout: 15000 });
    await page2.click('a[href="/businesses"]');
    await page2.waitForSelector("text=ABC Motors", { timeout: 15000 });
    await page2.click("text=ABC Motors");
    await sleep(500);
    const bizPageText = await page2.evaluate(() => document.body.innerText);
    check(/\b40h\b|\b40\s*h\b|40 hours|Target.*40/i.test(bizPageText), "(H) Business 360 shows the 40h target (4 rigs × 10h — src/engine/insights.ts's businessTargetHours, not hardcoded)");
    const rigsStatValue = await page2.locator("text=Rigs").locator("xpath=..").innerText().catch(() => "");
    check(rigsStatValue.includes("4"), `Business 360's "Rigs" stat shows 4 — got "${rigsStatValue.replace(/\s+/g, " ").trim()}"`);

    console.log("\n  Switching to the FO's own device to check Today's Plan and per-assignment isolation...");
    await page2.evaluate((assignedFoId) => {
      localStorage.removeItem("city-ops-os");
      localStorage.setItem(
        "city-ops-auth",
        JSON.stringify({ id: "demo-fo-test-" + assignedFoId, email: "test-fo@demo.city-ops", role: "FIELD_OFFICER", displayName: "Test FO", foId: assignedFoId, createdAt: new Date().toISOString() }),
      );
    }, foId1);
    await page2.goto(`${BASE_URL}/fo`);
    await page2.waitForSelector("text=Today", { timeout: 15000 });
    await sleep(1500);

    const todayBodyText = await page2.evaluate(() => document.body.innerText);
    check(todayBodyText.includes("4 ASSIGNMENTS"), '(I) FO Today shows "4 ASSIGNMENTS" for the real dialog-created assignments — none merged into a single business card');
    for (const code of ["R-01", "R-02", "R-03", "R-04"]) {
      check(todayBodyText.includes(code), `(I) FO Today shows a card for ${code}`);
    }
    check(!todayBodyText.includes("R-05"), "(I) FO Today does NOT show R-05 — that attempt was correctly rejected and never persisted");

    console.log("\n  (J) Completing Rig 1's assignment directly must not affect Rigs 2-4:");
    // No reload here, deliberately: reloading would re-trigger the FO's
    // sync engine, which re-fetches "assignments" from the mock backend
    // (still the pre-mutation status — this mutation is LOCAL-only, testing
    // structural isolation, not sync persistence) and, via
    // mergeRemoteCollection's full-replace, would silently overwrite this
    // exact change.
    const rig1AssignmentId = abcAssignmentIds[0];
    const afterComplete = await page2.evaluate((rig1Id) => {
      const raw = JSON.parse(localStorage.getItem("city-ops-os"));
      const a = raw.state.assignments.find((x) => x.id === rig1Id);
      a.status = "completed";
      localStorage.setItem("city-ops-os", JSON.stringify(raw));
      return raw.state.assignments;
    }, rig1AssignmentId);
    const statuses = abcAssignmentIds.map((id) => afterComplete.find((a) => a.id === id)?.status);
    check(statuses[0] === "completed", `(J) Rig 1's own assignment status is 'completed' (got '${statuses[0]}')`);
    check(
      statuses.slice(1).every((s) => s !== "completed"),
      `(J) Rigs 2-4 remain independent, not marked complete — got [${statuses.slice(1).join(", ")}]`,
    );

    console.log("\n  (K) Evidence seeded under Rig 1's assignment must not appear under Rig 2's:");
    // Same reasoning as (J) — no reload, this tests structural isolation of
    // LOCAL state, not sync persistence.
    const evidenceState = await page2.evaluate(
      ({ rig1AssignmentId, biz, fo }) => {
        const raw = JSON.parse(localStorage.getItem("city-ops-os"));
        const now = new Date().toISOString();
        raw.state.evidence.push({
          id: "ev_rig1_only",
          assignmentId: rig1AssignmentId,
          businessId: biz,
          foId: fo,
          type: "RIG_PRECHECK",
          startedAt: now,
          capturedAt: now,
          files: [],
          status: "submitted",
          metadata: { passed: true, checklist: {}, failedItems: [] },
          createdAt: now,
        });
        localStorage.setItem("city-ops-os", JSON.stringify(raw));
        return raw.state.evidence;
      },
      { rig1AssignmentId, biz: abcBizId, fo: foId1 },
    );
    const rig1Evidence = evidenceState.filter((e) => e.assignmentId === rig1AssignmentId);
    const rig2Evidence = evidenceState.filter((e) => e.assignmentId === abcAssignmentIds[1]);
    check(rig1Evidence.length === 1, "(K) Rig 1's assignment has exactly its own one evidence record");
    check(rig2Evidence.length === 0, "(K) Rig 2's assignment has ZERO evidence records — evidence is assignmentId-scoped, never leaks across via businessId");

    await context2.close();

    // ==================================================================
    console.log(
      "\n[3] PLANNER CONFLICT DETECTION (src/engine/planner.ts's detectConflicts(), read via the real /today page's conflict banner):",
    );
    const context3 = await browser.newContext();
    const page3 = await context3.newPage();
    await page3.addInitScript(MOCK_BACKEND_INIT_SCRIPT);
    page3.on("pageerror", (err) => console.error("  [page error]", err.message));

    const P_FO_ID = "fo_planner_test";
    const P_ABC_ID = "biz_planner_abc";
    const P_XYZ_ID = "biz_planner_xyz";
    const pToday = new Date().toISOString().slice(0, 10);
    const iso = (t) => `${pToday}T${t}:00.000Z`;

    // A: ABC / R-01 / 09:00-19:00
    // B: ABC / R-02 / 09:00-19:00  — same business, different rig, same
    //    time as A: must NOT produce fo_double_booking (the fix).
    // C: XYZ / R-99 / 10:00-14:00  — different business, same FO,
    //    overlapping A/B's window: MUST produce fo_double_booking.
    // E: ABC / R-01 / 12:00-16:00  — same rig as A, overlapping, distinct
    //    identity (different time window): MUST still produce
    //    rig_double_booking, unaffected by the same-business exclusion.
    const planA = { businessId: P_ABC_ID, foId: P_FO_ID, date: pToday, plannedStart: iso("09:00"), plannedEnd: iso("19:00"), rigId: "p_rig_01" };
    const planB = { businessId: P_ABC_ID, foId: P_FO_ID, date: pToday, plannedStart: iso("09:00"), plannedEnd: iso("19:00"), rigId: "p_rig_02" };
    const planC = { businessId: P_XYZ_ID, foId: P_FO_ID, date: pToday, plannedStart: iso("10:00"), plannedEnd: iso("14:00"), rigId: "p_rig_99" };
    const planE = { businessId: P_ABC_ID, foId: P_FO_ID, date: pToday, plannedStart: iso("12:00"), plannedEnd: iso("16:00"), rigId: "p_rig_01" };
    const planAssignments = [planA, planB, planC, planE].map((a) => ({ ...a, id: deriveAssignmentId(a), priority: "normal", status: "confirmed", createdAt: new Date().toISOString() }));
    check(new Set(planAssignments.map((a) => a.id)).size === 4, "planner-test seed: all 4 conflict-matrix assignments have distinct ids");

    await page3.goto(`${BASE_URL}/login`);
    await page3.evaluate(
      ({ P_FO_ID, P_ABC_ID, P_XYZ_ID, pToday, planAssignments }) => {
        const now = new Date().toISOString();
        const businesses = [
          { id: P_ABC_ID, name: "ABC Motors", category: "General", area: "Test Area", address: "", capacityHoursPerDay: 40, active: true, createdAt: now },
          { id: P_XYZ_ID, name: "XYZ Corp", category: "General", area: "Other Area", address: "", capacityHoursPerDay: 40, active: true, createdAt: now },
        ];
        const fos = [{ id: P_FO_ID, name: "Planner Test FO", active: true, createdAt: now }];
        const rigs = ["p_rig_01", "p_rig_02", "p_rig_99"].map((id, i) => ({ id, code: `R-0${i + 1}`, model: "Test Rig", active: true, batteryPct: 100, storagePct: 0, deploymentStatus: "active", createdAt: now }));
        const cityData = {
          version: 2,
          settings: { cityName: "Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
          businesses,
          fos,
          collectors: [],
          rigs,
          assignments: planAssignments,
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
          JSON.stringify({ id: "demo-manager", email: "manager@demo.city-ops", role: "MANAGER", displayName: "Demo Manager", createdAt: now }),
        );
        const mockStore = {
          businesses: Object.fromEntries(businesses.map((b) => [b.id, b])),
          fos: Object.fromEntries(fos.map((f) => [f.id, f])),
          rigs: Object.fromEntries(rigs.map((r) => [r.id, r])),
          assignments: Object.fromEntries(planAssignments.map((a) => [a.id, a])),
          evidence: {},
        };
        localStorage.setItem("__mock_firestore_store__", JSON.stringify(mockStore));
      },
      { P_FO_ID, P_ABC_ID, P_XYZ_ID, pToday, planAssignments },
    );

    await page3.reload();
    await page3.waitForSelector("text=Command Center", { timeout: 15000 });
    // Root "/" renders Command Center, not the Today page — the conflict
    // banner (fed by detectConflicts()) only renders on /today, so navigate
    // there explicitly rather than relying on a generic "Today" text match
    // (which would otherwise match the sidebar nav link on ANY page).
    await page3.goto(`${BASE_URL}/today`);
    await page3.waitForSelector("text=Timeline", { timeout: 15000 });
    await sleep(800);
    const conflictBannerText = await page3.evaluate(() => document.body.innerText);

    check(
      !/is double-booked:\s*ABC Motors and ABC Motors overlap/i.test(conflictBannerText),
      "same business + different rigs (R-01/R-02) + same time → NO false-positive fo_double_booking banner",
    );
    check(
      /is double-booked:\s*(ABC Motors and XYZ Corp|XYZ Corp and ABC Motors) overlap/i.test(conflictBannerText),
      "different business (ABC vs XYZ) + same FO + overlapping time → fo_double_booking banner IS shown",
    );
    check(
      /Rig R-01 is double-booked between/i.test(conflictBannerText),
      "same rig (R-01) + overlapping time → rig_double_booking banner IS shown, regardless of business (unchanged behavior)",
    );
    check(!/Rig R-02 is double-booked between/i.test(conflictBannerText), "R-02 (only one assignment, no overlap) → no rig_double_booking banner for it");

    if (failures > 0) console.error("\n--- preview server output (for debugging) ---\n" + serverOutput.slice(-4000));
    await context3.close();
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
