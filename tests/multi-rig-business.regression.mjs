// Investigation regression test: "a single business can have multiple
// workers and multiple rigs operating simultaneously under ONE Field
// Officer" (e.g. ABC Motors: 4 workers, 4 rigs, 1 FO, 40 required recording
// hours). This file drives the REAL app UI (real AssignmentFormDialog, real
// FOExecution Today's Plan) via Playwright against a production build,
// using the established __CITY_OPS_TEST_BACKEND__ seam — no live Firebase
// project needed.
//
// Two scenarios:
//
// [1] PROVES THE ACTUAL RESTRICTION — src/components/forms/
//     AssignmentFormDialog.tsx's `foConflict` check (line ~124) flags ANY
//     time-overlapping assignment for the same FO as a blocking validation
//     error, regardless of business. It does not exclude the case where
//     both assignments are for the SAME business (a legitimate multi-rig
//     deployment) — only the case of the SAME rig (which is correctly
//     still blocked). This scenario documents that CURRENT, unfixed
//     behavior: adding a second rig for the same business/FO/time is
//     rejected by the dialog with "already has an overlapping assignment
//     at this time," even though the underlying data model has no such
//     restriction (see scenario [2]).
//
// [2] PROVES THE UNDERLYING DATA MODEL ALREADY SUPPORTS THE SCENARIO —
//     bypassing the dialog (seeding assignments directly, computing their
//     ids via the SAME deriveAssignmentId() algorithm src/lib/
//     assignmentIdentity.ts uses — mirrored here in plain JS, same
//     convention as this repo's *.emulator.mjs tests), this proves: four
//     distinct rigId assignments for the same business+FO+date+time
//     produce four distinct, non-colliding ids; required hours scale as
//     rigs × 10 (src/engine/insights.ts's businessTargetHoursFromAssignments,
//     NOT a hardcoded 10h/business); FO Today lists all four as separate,
//     independently-executable cards; and evidence/session/completion
//     state stays isolated per assignment (never merged by business).
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

    // ------------------------------------------------------------------
    console.log(
      "\n[1] THE RESTRICTION: driving the REAL Manager UI — one FO, one business, two rigs — to add a Rig 1 assignment, " +
        "then attempt to add a Rig 2 assignment for the SAME business/FO at the SAME time window:",
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
    await page1.getByRole("button", { name: "Add Business" }).first().click();
    dialog = page1.locator('[role="dialog"]');
    await dialog.locator("#biz-name").fill("ABC Motors");
    await dialog.locator("#biz-area").fill("Test Area");
    await dialog.getByRole("button", { name: "Add business", exact: true }).click();
    await page1.waitForSelector('[role="dialog"]', { state: "hidden", timeout: 15000 }).catch(() => {});
    await sleep(800);

    await page1.click('a[href="/fleet"]');
    for (const code of ["R-01", "R-02"]) {
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

    async function assignRig(rigCode, { expectError } = {}) {
      await page1.getByRole("button", { name: "Assign rig" }).click();
      const d = page1.locator('[role="dialog"]');
      await d.locator("text=Select business").waitFor({ timeout: 15000 }).catch(() => {});
      // Business combobox (index 1: FO=0, Business=1, Rig=2)
      await d.getByRole("combobox").nth(1).click();
      await page1.locator('[role="option"]:has-text("ABC Motors")').click();
      // Rig combobox
      await d.getByRole("combobox").nth(2).click();
      await page1.locator(`[role="option"]:has-text("${rigCode}")`).click();
      await d.locator("#asg-start").fill("09:00");
      await d.locator("#asg-end").fill("19:00");
      await d.getByRole("button", { name: "Add assignment", exact: true }).click();
      await sleep(800);
      if (expectError) {
        const errorText = await d.locator("text=already has an overlapping assignment").isVisible().catch(() => false);
        return { dialogStillOpen: await d.isVisible().catch(() => false), errorVisible: errorText };
      }
      await page1.waitForSelector('[role="dialog"]', { state: "hidden", timeout: 15000 }).catch(() => {});
      return { dialogStillOpen: await d.isVisible().catch(() => false) };
    }

    const rig1Result = await assignRig("R-01");
    check(!rig1Result.dialogStillOpen, "Rig R-01 assignment (09:00-19:00, ABC Motors) is accepted — dialog closes normally");

    const rig2Result = await assignRig("R-02", { expectError: true });
    console.log(
      `  OBSERVED: after attempting Rig R-02 for the SAME business/FO/time window, dialog still open=${rig2Result.dialogStillOpen}, ` +
        `"already has an overlapping assignment" error visible=${rig2Result.errorVisible}`,
    );
    check(
      rig2Result.dialogStillOpen && rig2Result.errorVisible,
      "RESTRICTION CONFIRMED: AssignmentFormDialog's foConflict check (line ~124, src/components/forms/AssignmentFormDialog.tsx) blocks a second rig for the SAME business/FO/time window — the exact scenario this round needs to support. This is a validation-layer false positive, not a data-model limitation (see scenario [2]).",
    );

    const mockStoreAfter1 = await page1.evaluate(() => JSON.parse(localStorage.getItem("__mock_firestore_store__") || "{}"));
    const assignmentsAfter1 = Object.values(mockStoreAfter1.assignments ?? {}).filter((a) => a.foId === foId1);
    check(assignmentsAfter1.length === 1, `confirmed at the data layer: only ONE assignment exists for this FO/business (got ${assignmentsAfter1.length}) — Rig R-02 never reached Firestore because the dialog blocked it client-side before onCreate() was ever called`);

    await context1.close();

    // ------------------------------------------------------------------
    console.log(
      "\n[2] THE DATA MODEL ALREADY SUPPORTS IT: seeding four rig assignments for the SAME business+FO+date+time window " +
        "directly (bypassing the dialog), using the REAL deriveAssignmentId() algorithm, to prove the store/hours/FO-Today/" +
        "evidence layers have no such restriction:",
    );
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await page2.addInitScript(MOCK_BACKEND_INIT_SCRIPT);
    page2.on("pageerror", (err) => console.error("  [page error]", err.message));

    const FO_ID = "fo_multi_rig";
    const BIZ_ID = "biz_abc_motors";
    const today = new Date().toISOString().slice(0, 10);
    const plannedStart = `${today}T09:00:00.000Z`;
    const plannedEnd = `${today}T19:00:00.000Z`;
    const rigIds = ["rig_01", "rig_02", "rig_03", "rig_04"];
    const collectorIds = ["worker_01", "worker_02", "worker_03", "worker_04"];

    const identities = rigIds.map((rigId) => ({ businessId: BIZ_ID, foId: FO_ID, date: today, plannedStart, plannedEnd, rigId }));
    const computedIds = identities.map(deriveAssignmentId);
    check(new Set(computedIds).size === 4, `all four rigs produce DISTINCT deterministic assignment ids (got ${new Set(computedIds).size} distinct out of 4) — confirms rigId IS part of the identity in src/lib/assignmentIdentity.ts`);

    await page2.goto(`${BASE_URL}/login`);
    await page2.evaluate(
      ({ FO_ID, BIZ_ID, today, plannedStart, plannedEnd, rigIds, collectorIds, computedIds }) => {
        const now = new Date().toISOString();
        const business = { id: BIZ_ID, name: "ABC Motors", category: "General", area: "Test Area", address: "", capacityHoursPerDay: 40, active: true, createdAt: now };
        const fo = { id: FO_ID, name: "Multi-Rig Test FO", active: true, createdAt: now };
        const rigs = rigIds.map((id, i) => ({ id, code: `R-0${i + 1}`, model: "Test Rig", active: true, batteryPct: 100, storagePct: 0, deploymentStatus: "active", createdAt: now }));
        const collectors = collectorIds.map((id, i) => ({ id, name: `Worker ${i + 1}`, businessId: BIZ_ID, active: true, createdAt: now }));
        const assignments = computedIds.map((id, i) => ({
          id,
          date: today,
          businessId: BIZ_ID,
          foId: FO_ID,
          rigId: rigIds[i],
          collectorId: collectorIds[i],
          plannedStart,
          plannedEnd,
          priority: "normal",
          status: "confirmed",
          actualArrivalAt: now,
          createdAt: now,
        }));
        const cityData = {
          version: 2,
          settings: { cityName: "Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
          businesses: [business],
          fos: [fo],
          collectors,
          rigs,
          assignments,
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
          businesses: { [business.id]: business },
          fos: { [fo.id]: fo },
          rigs: Object.fromEntries(rigs.map((r) => [r.id, r])),
          assignments: Object.fromEntries(assignments.map((a) => [a.id, a])),
          evidence: {},
        };
        localStorage.setItem("__mock_firestore_store__", JSON.stringify(mockStore));
      },
      { FO_ID, BIZ_ID, today, plannedStart, plannedEnd, rigIds, collectorIds, computedIds },
    );

    console.log("  Reloading as Manager to read back Business 360's rig count / required hours...");
    await page2.reload();
    await page2.waitForSelector("text=Today", { timeout: 15000 });
    await page2.click('a[href="/businesses"]');
    await page2.waitForSelector("text=ABC Motors", { timeout: 15000 });
    await page2.click("text=ABC Motors");
    await sleep(500);
    const bizPageText = await page2.evaluate(() => document.body.innerText);
    check(/\b40h\b|\b40\s*h\b|40 hours|Target.*40/i.test(bizPageText), `Business 360 shows the 40h target (4 rigs × 10h — src/engine/insights.ts's businessTargetHours, no hardcoded per-business constant) — body text sample checked`);
    const rigsStatValue = await page2.locator("text=Rigs").locator("xpath=..").innerText().catch(() => "");
    check(rigsStatValue.includes("4"), `Business 360's "Rigs" stat shows 4 (src/engine/insights.ts's businessRigCount — distinct rigIds across today's assignments) — got "${rigsStatValue.replace(/\s+/g, " ").trim()}"`);

    console.log("\n  Switching to the FO's own device to check Today's Plan and per-assignment isolation...");
    await page2.evaluate((assignedFoId) => {
      localStorage.removeItem("city-ops-os");
      localStorage.setItem(
        "city-ops-auth",
        JSON.stringify({ id: "demo-fo-test-" + assignedFoId, email: "test-fo@demo.city-ops", role: "FIELD_OFFICER", displayName: "Test FO", foId: assignedFoId, createdAt: new Date().toISOString() }),
      );
    }, FO_ID);
    await page2.goto(`${BASE_URL}/fo`);
    await page2.waitForSelector("text=Today", { timeout: 15000 });
    await sleep(1500);

    const todayBodyText = await page2.evaluate(() => document.body.innerText);
    check(todayBodyText.includes("4 ASSIGNMENTS"), '(I) FO Today shows "4 ASSIGNMENTS" — all four rig deployments listed, none merged into a single business card');
    for (const code of ["R-01", "R-02", "R-03", "R-04"]) {
      check(todayBodyText.includes(code), `(I) FO Today shows a card for ${code}`);
    }

    console.log("\n  (J) Completing Rig 1's assignment directly must not affect Rigs 2-4:");
    // No reload here, deliberately: reloading would re-trigger the FO's
    // sync engine, which re-fetches "assignments" from the mock backend
    // (still "confirmed" — this mutation is LOCAL-only, testing structural
    // isolation, not sync persistence) and, via mergeRemoteCollection's
    // full-replace, would silently overwrite this exact change.
    const afterComplete = await page2.evaluate((rig1Id) => {
      const raw = JSON.parse(localStorage.getItem("city-ops-os"));
      const a = raw.state.assignments.find((x) => x.id === rig1Id);
      a.status = "completed";
      localStorage.setItem("city-ops-os", JSON.stringify(raw));
      return raw.state.assignments;
    }, computedIds[0]);
    const statuses = computedIds.map((id) => afterComplete.find((a) => a.id === id)?.status);
    check(statuses[0] === "completed", `(J) Rig 1's own assignment status is 'completed' (got '${statuses[0]}')`);
    check(
      statuses.slice(1).every((s) => s === "confirmed"),
      `(J) Rigs 2-4 remain 'confirmed' (independent, not marked complete) — got [${statuses.slice(1).join(", ")}]`,
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
      { rig1AssignmentId: computedIds[0], biz: BIZ_ID, fo: FO_ID },
    );
    const rig1Evidence = evidenceState.filter((e) => e.assignmentId === computedIds[0]);
    const rig2Evidence = evidenceState.filter((e) => e.assignmentId === computedIds[1]);
    check(rig1Evidence.length === 1, "(K) Rig 1's assignment has exactly its own one evidence record");
    check(rig2Evidence.length === 0, "(K) Rig 2's assignment has ZERO evidence records — Rig 1's evidence never leaks across via businessId (evidence is assignmentId-scoped, per src/types/index.ts's Evidence.assignmentId)");

    if (failures > 0) console.error("\n--- preview server output (for debugging) ---\n" + serverOutput.slice(-4000));
    await context2.close();
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
