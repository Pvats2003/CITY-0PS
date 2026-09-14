// Regression test for: after an FO submits replacement evidence for a
// Manager's recheck request and the Manager approves the replacement, the
// FO's screen stays stuck on "RESUBMITTED — waiting on your Manager to
// review the new evidence." forever.
//
// ROOT CAUSE (traced, not assumed): src/engine/workflows.ts's
// reviewEvidence() (called by every per-evidence-item Approve/Reject/
// Request Recheck button in EvidenceReviewDialog.tsx) only ever calls
// updateEvidence() — it never touches Assignment.reviewStatus. The ONLY
// function that writes Assignment.reviewStatus is reviewAssignment(),
// which the per-item Approve/Reject buttons never call (only the per-item
// "Request Recheck" flow calls both, which is how reviewStatus gets SET to
// "recheck_requested" in the first place). src/engine/execution.ts's
// deriveExecutionStage() — the sole source of truth FOExecution.tsx reads
// — short-circuits entirely on `assignment.reviewStatus === "recheck_requested"`
// before ever looking at the (already-correct) evidence-level state, so
// nothing ever clears that flag once every flagged item is resolved. This
// is a persistence/state-transition bug, not a UI reactivity bug: the
// store's live Zustand subscription already re-renders FOExecution.tsx
// correctly on any assignment change — the write it needed just never
// happened.
//
// THE FIX: workflows.ts's reviewEvidence() now calls the new
// recalculateAssignmentReviewStatus(assignmentId) after every decision.
// It is a no-op unless the assignment is currently "recheck_requested",
// and only clears it (back to "pending", never "approved" — that stays a
// separate, deliberate Manager action) once EVERY evidence lineage ever
// flagged recheck_requested has a latest record (walking replacesEvidenceId
// chains) that is "approved" — preserving the invariant that approving one
// evidence item must never clear the gate while another flagged item is
// still unresolved. Reuses the existing store/updateAssignment()/outbox
// persistence path unchanged — no bypass, no direct Firestore writes.
//
// Drives the REAL app UI (real FOExecution recheck-retake screen, real
// EvidenceReviewDialog Approve button) via Playwright against a production
// build, in demo/local mode (pure client-side store/derivation logic under
// test — no backend needed to prove it, and no backend means no reload-
// induced resync to account for when switching between Manager and FO
// views of the SAME local store).
//
// Run with: npm run test:evidence-recheck-reconciliation

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4188;
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

const ONE_PX_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function makeManagerAuth() {
  const now = new Date().toISOString();
  return { id: "demo-manager", email: "manager@demo.city-ops", role: "MANAGER", displayName: "Demo Manager", createdAt: now };
}
function makeFoAuth(foId) {
  const now = new Date().toISOString();
  return { id: "demo-fo-test-" + foId, email: "test-fo@demo.city-ops", role: "FIELD_OFFICER", displayName: "Test FO", foId, createdAt: now };
}

async function getLocalCityData(page) {
  return page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("city-ops-os") || "{}").state ?? null;
    } catch {
      return null;
    }
  });
}

async function switchAuth(page, auth) {
  await page.evaluate((a) => localStorage.setItem("city-ops-auth", JSON.stringify(a)), auth);
}

/** Seeds a business/FO/rig + one assignment (already arrived) with the
 * given evidence records + assignment-level reviewStatus. Setup only —
 * mirrors this repo's established "seed the state just before the part
 * under test" convention (see evidence-capture-fix.regression.mjs). */
async function seedScenario(page, { assignmentId, evidence, reviewStatus }) {
  await page.goto(`${BASE_URL}/login`);
  await page.evaluate(
    ({ assignmentId, evidence, reviewStatus, managerAuth }) => {
      const now = new Date().toISOString();
      const today = now.slice(0, 10);
      const business = { id: "biz_recheck", name: "Recheck Test Biz", category: "General", area: "Area", address: "", capacityHoursPerDay: 3, active: true, createdAt: now };
      const fo = { id: "fo_recheck", name: "Recheck Test FO", active: true, createdAt: now };
      const rig = { id: "rig_recheck", code: "R-RC", model: "Test Rig", active: true, batteryPct: 100, storagePct: 0, deploymentStatus: "active", createdAt: now };
      const assignment = {
        id: assignmentId,
        date: today,
        businessId: business.id,
        foId: fo.id,
        rigId: rig.id,
        plannedStart: `${today}T08:00:00.000Z`,
        plannedEnd: `${today}T11:00:00.000Z`,
        priority: "normal",
        status: "confirmed",
        actualArrivalAt: now,
        reviewStatus,
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
      localStorage.setItem("city-ops-auth", JSON.stringify(managerAuth));
    },
    { assignmentId, evidence, reviewStatus, managerAuth: makeManagerAuth() },
  );
}

const ONE_PX_PNG_DATA_URI = "data:image/png;base64," + ONE_PX_PNG_BASE64;

function onePxFile(id) {
  return { id, name: `${id}.png`, type: "image/png", sizeBytes: 100, localUrl: ONE_PX_PNG_DATA_URI, capturedAt: new Date().toISOString(), uploadStatus: "local_only" };
}

/** Finds the Approve/Request Recheck/Reject button-group for the SPECIFIC
 * evidence record whose photo has this file id — multiple evidence cards
 * can share the same type label ("RIG PRECHECK" for both an original and
 * its replacement), so targeting by role/name alone is ambiguous; each
 * record's own distinctly-named thumbnail disambiguates its card. */
function evidenceCardByFileId(page, fileId) {
  return page.locator(`img[alt="${fileId}.png"]`).locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
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
    console.log("\n[Scenario 1] Full resubmission lifecycle: flag -> FO retakes -> Manager approves replacement -> FO unblocked:");
    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    page1.on("pageerror", (err) => console.error("  [page error]", err.message));

    const now1 = new Date().toISOString();
    await seedScenario(page1, {
      assignmentId: "asg_s1",
      reviewStatus: "recheck_requested",
      evidence: [
        {
          id: "ev_orig_s1",
          assignmentId: "asg_s1",
          businessId: "biz_recheck",
          foId: "fo_recheck",
          rigId: "rig_recheck",
          type: "RIG_PRECHECK",
          startedAt: now1,
          capturedAt: now1,
          files: [onePxFile("f_orig_s1")],
          status: "recheck_requested",
          reviewNote: "Photo too blurry — retake in better light",
          metadata: { passed: true, checklist: {}, failedItems: [] },
          createdAt: now1,
        },
      ],
    });

    console.log("  As FO: confirm ACTION REQUIRED shows, then retake through the real recheck screen:");
    await switchAuth(page1, makeFoAuth("fo_recheck"));
    await page1.goto(`${BASE_URL}/fo`);
    await page1.waitForSelector("text=Recheck Test Biz", { timeout: 15000 });
    await page1.click("text=Recheck Test Biz");
    await page1.waitForSelector("text=ACTION REQUIRED", { timeout: 15000 });
    check(await page1.locator("text=ACTION REQUIRED").isVisible(), "(setup) FO sees ACTION REQUIRED for the flagged RIG_PRECHECK item — unchanged pre-existing behavior");

    await page1.locator('input[type="file"]').first().setInputFiles({ name: "retake.png", mimeType: "image/png", buffer: Buffer.from(ONE_PX_PNG_BASE64, "base64") });
    await sleep(600); // durable stash + captureStepEvidence()'s synchronous store write

    await page1.waitForSelector("text=RESUBMITTED", { timeout: 15000 });
    check(await page1.locator("text=RESUBMITTED").isVisible(), "(setup, EXISTING behavior, unaffected by this fix) FO sees RESUBMITTED once their own retake is submitted");

    const afterResubmit = await getLocalCityData(page1);
    const replacement = afterResubmit.evidence.find((e) => e.replacesEvidenceId === "ev_orig_s1");
    check(!!replacement, "a replacement evidence record was created with replacesEvidenceId pointing at the original");
    check(replacement?.status === "submitted", `the replacement's own status is 'submitted', not yet reviewed (got '${replacement?.status}')`);
    check(afterResubmit.assignments[0].reviewStatus === "recheck_requested", "assignment.reviewStatus is STILL 'recheck_requested' immediately after the FO's resubmission — correct, nothing should clear it before the Manager reviews");

    console.log("  As Manager: confirm the original shows 'Superseded', then approve the replacement (THE FIX under test):");
    await switchAuth(page1, makeManagerAuth());
    await page1.goto(`${BASE_URL}/field-officers`);
    await page1.waitForSelector('a[href^="/field-officers/"]', { timeout: 15000 });
    await page1.click('a[href^="/field-officers/"]');
    await page1.waitForSelector('button[title="Review evidence"]', { timeout: 15000 });
    await page1.click('button[title="Review evidence"]');
    await page1.waitForSelector("text=Evidence records", { timeout: 15000 });

    check(await page1.locator("text=Superseded by a later resubmission").isVisible(), "(9) the ORIGINAL evidence is surfaced as superseded, and is still present (kept for history, not deleted)");

    const approveButtons = page1.getByRole("button", { name: "Approve" });
    check((await approveButtons.count()) >= 1, "an Approve button is available for the (unreviewed) replacement evidence");
    await approveButtons.first().click();
    await sleep(500);

    const afterApprove = await getLocalCityData(page1);
    const replacementAfter = afterApprove.evidence.find((e) => e.id === replacement.id);
    check(replacementAfter?.status === "approved", `the replacement evidence's own status is now 'approved' (got '${replacementAfter?.status}')`);
    check(afterApprove.assignments[0].reviewStatus === "pending", `THE FIX: assignment.reviewStatus was recalculated to 'pending' once the only flagged lineage's latest record was approved (got '${afterApprove.assignments[0].reviewStatus}')`);
    const origAfter = afterApprove.evidence.find((e) => e.id === "ev_orig_s1");
    check(origAfter?.status === "recheck_requested", "(9) the ORIGINAL evidence record's own status field is untouched (still 'recheck_requested', exactly as it was set) — history is preserved, not rewritten");

    console.log("  As FO: confirm RESUBMITTED is gone:");
    await switchAuth(page1, makeFoAuth("fo_recheck"));
    await page1.goto(`${BASE_URL}/fo`);
    await page1.waitForSelector("text=Recheck Test Biz", { timeout: 15000 });
    await page1.click("text=Recheck Test Biz");
    await sleep(500);
    check(!(await page1.locator("text=RESUBMITTED").isVisible().catch(() => false)), "THE FIX CONFIRMED: FO no longer shows RESUBMITTED after the Manager approves the replacement");
    check(!(await page1.locator("text=ACTION REQUIRED").isVisible().catch(() => false)), "FO is also not stuck showing ACTION REQUIRED — the gate is fully released, not swapped for a different stuck state");

    await context1.close();

    // ==================================================================
    console.log("\n[Scenario 2] TWO flagged items; approving only ONE replacement must NOT clear the assignment gate:");
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    page2.on("pageerror", (err) => console.error("  [page error]", err.message));

    const now2 = new Date().toISOString();
    await seedScenario(page2, {
      assignmentId: "asg_s2",
      reviewStatus: "recheck_requested",
      evidence: [
        {
          id: "ev_precheck_s2",
          assignmentId: "asg_s2",
          businessId: "biz_recheck",
          foId: "fo_recheck",
          rigId: "rig_recheck",
          type: "RIG_PRECHECK",
          startedAt: now2,
          capturedAt: now2,
          files: [onePxFile("f_precheck_s2")],
          status: "recheck_requested",
          reviewNote: "Retake needed",
          metadata: { passed: true, checklist: {}, failedItems: [] },
          createdAt: now2,
        },
        {
          id: "ev_install_s2",
          assignmentId: "asg_s2",
          businessId: "biz_recheck",
          foId: "fo_recheck",
          rigId: "rig_recheck",
          type: "INSTALLATION",
          startedAt: now2,
          capturedAt: now2,
          files: [onePxFile("f_install_s2")],
          status: "recheck_requested",
          reviewNote: "Retake needed — different, still-unresolved item",
          createdAt: now2,
        },
        // Only the RIG_PRECHECK item has already been resubmitted —
        // INSTALLATION's flagged item has no replacement at all yet.
        {
          id: "ev_precheck_replacement_s2",
          assignmentId: "asg_s2",
          businessId: "biz_recheck",
          foId: "fo_recheck",
          rigId: "rig_recheck",
          type: "RIG_PRECHECK",
          startedAt: now2,
          capturedAt: now2,
          files: [onePxFile("f_precheck_replacement_s2")],
          status: "submitted",
          replacesEvidenceId: "ev_precheck_s2",
          metadata: { passed: true, checklist: {}, failedItems: [] },
          createdAt: now2,
        },
      ],
    });

    await page2.goto(`${BASE_URL}/field-officers`);
    await page2.waitForSelector('a[href^="/field-officers/"]', { timeout: 15000 });
    await page2.click('a[href^="/field-officers/"]');
    await page2.waitForSelector('button[title="Review evidence"]', { timeout: 15000 });
    await page2.click('button[title="Review evidence"]');
    await page2.waitForSelector("text=Evidence records", { timeout: 15000 });

    // Approve ONLY the RIG_PRECHECK replacement's own card — three evidence
    // records exist here (the two originals plus this one replacement),
    // more than one showing a "RIG PRECHECK" label, so the specific card is
    // targeted by its own distinctly-named photo, not by button order.
    await evidenceCardByFileId(page2, "f_precheck_replacement_s2").getByRole("button", { name: "Approve" }).click();
    await sleep(500);

    const afterPartialApprove = await getLocalCityData(page2);
    const asg2 = afterPartialApprove.assignments.find((a) => a.id === "asg_s2");
    check(
      asg2.reviewStatus === "recheck_requested",
      `THE INVARIANT HOLDS: assignment.reviewStatus is STILL 'recheck_requested' — the INSTALLATION item's flag was never resolved, so approving the RIG_PRECHECK replacement alone must not release the gate (got '${asg2.reviewStatus}')`,
    );
    const precheckReplacementAfter = afterPartialApprove.evidence.find((e) => e.id === "ev_precheck_replacement_s2");
    check(precheckReplacementAfter?.status === "approved", "the RIG_PRECHECK replacement itself IS approved — only the assignment-level gate correctly stays closed");

    await switchAuth(page2, makeFoAuth("fo_recheck"));
    await page2.goto(`${BASE_URL}/fo`);
    await page2.waitForSelector("text=Recheck Test Biz", { timeout: 15000 });
    await page2.click("text=Recheck Test Biz");
    await sleep(500);
    check(await page2.locator("text=ACTION REQUIRED").isVisible(), "FO correctly still sees ACTION REQUIRED — the still-unresolved INSTALLATION item is the one blocking, and remains visible for retake");
    check(await page2.locator("text=INSTALLATION").isVisible(), "the specific still-outstanding item (INSTALLATION) is the one shown, not the already-resolved RIG_PRECHECK one");

    await context2.close();

    // ==================================================================
    console.log("\n[Scenario 3] Persistence: the recalculated state survives a fresh page load (not just in-memory):");
    const context3 = await browser.newContext();
    const page3 = await context3.newPage();
    page3.on("pageerror", (err) => console.error("  [page error]", err.message));

    const now3 = new Date().toISOString();
    await seedScenario(page3, {
      assignmentId: "asg_s3",
      reviewStatus: "recheck_requested",
      evidence: [
        {
          id: "ev_orig_s3",
          assignmentId: "asg_s3",
          businessId: "biz_recheck",
          foId: "fo_recheck",
          rigId: "rig_recheck",
          type: "RIG_PRECHECK",
          startedAt: now3,
          capturedAt: now3,
          files: [onePxFile("f_orig_s3")],
          status: "recheck_requested",
          metadata: { passed: true, checklist: {}, failedItems: [] },
          createdAt: now3,
        },
        {
          id: "ev_replacement_s3",
          assignmentId: "asg_s3",
          businessId: "biz_recheck",
          foId: "fo_recheck",
          rigId: "rig_recheck",
          type: "RIG_PRECHECK",
          startedAt: now3,
          capturedAt: now3,
          files: [onePxFile("f_replacement_s3")],
          status: "submitted",
          replacesEvidenceId: "ev_orig_s3",
          metadata: { passed: true, checklist: {}, failedItems: [] },
          createdAt: now3,
        },
      ],
    });

    await page3.goto(`${BASE_URL}/field-officers`);
    await page3.waitForSelector('a[href^="/field-officers/"]', { timeout: 15000 });
    await page3.click('a[href^="/field-officers/"]');
    await page3.waitForSelector('button[title="Review evidence"]', { timeout: 15000 });
    await page3.click('button[title="Review evidence"]');
    await page3.waitForSelector("text=Evidence records", { timeout: 15000 });
    await page3.getByRole("button", { name: "Approve" }).first().click();
    await sleep(500);

    const beforeReload = await getLocalCityData(page3);
    check(beforeReload.assignments[0].reviewStatus === "pending", "reviewStatus is 'pending' in the live store immediately after approval");

    console.log("  Reloading the page — a fresh load must derive the SAME state from persisted storage, not in-memory-only:");
    await page3.reload();
    await page3.waitForSelector("text=Command Center", { timeout: 15000 });
    const afterReload = await getLocalCityData(page3);
    check(afterReload.assignments[0].reviewStatus === "pending", `the persisted (localStorage) assignment record itself carries 'pending' — a fresh load derives the identical state, not a stale in-memory value (got '${afterReload.assignments[0].reviewStatus}')`);
    check(afterReload.evidence.find((e) => e.id === "ev_replacement_s3")?.status === "approved", "the approved replacement's status also survives the reload");

    await switchAuth(page3, makeFoAuth("fo_recheck"));
    await page3.goto(`${BASE_URL}/fo`);
    await page3.waitForSelector("text=Recheck Test Biz", { timeout: 15000 });
    await page3.click("text=Recheck Test Biz");
    await sleep(500);
    check(!(await page3.locator("text=RESUBMITTED").isVisible().catch(() => false)), "after a fresh load, the FO still does not see RESUBMITTED — the fix is durable, not a one-time in-memory effect");

    await context3.close();

    // ==================================================================
    console.log("\n[Scenario 4] Existing Approve / Request Recheck / Reject still work; no regression to the evidence photo lightbox:");
    const context4 = await browser.newContext();
    const page4 = await context4.newPage();
    page4.on("pageerror", (err) => console.error("  [page error]", err.message));

    const now4 = new Date().toISOString();
    await seedScenario(page4, {
      assignmentId: "asg_s4",
      reviewStatus: "pending",
      evidence: [
        {
          id: "ev_a_s4",
          assignmentId: "asg_s4",
          businessId: "biz_recheck",
          foId: "fo_recheck",
          rigId: "rig_recheck",
          type: "LOCATION",
          startedAt: now4,
          capturedAt: now4,
          files: [onePxFile("f_a_s4")],
          status: "submitted",
          metadata: { verified: true, message: "Within range" },
          createdAt: now4,
        },
        {
          id: "ev_b_s4",
          assignmentId: "asg_s4",
          businessId: "biz_recheck",
          foId: "fo_recheck",
          rigId: "rig_recheck",
          type: "RIG_PRECHECK",
          startedAt: now4,
          capturedAt: now4,
          files: [onePxFile("f_b_s4")],
          status: "submitted",
          metadata: { passed: true, checklist: {}, failedItems: [] },
          createdAt: now4,
        },
      ],
    });

    await page4.goto(`${BASE_URL}/field-officers`);
    await page4.waitForSelector('a[href^="/field-officers/"]', { timeout: 15000 });
    await page4.click('a[href^="/field-officers/"]');
    await page4.waitForSelector('button[title="Review evidence"]', { timeout: 15000 });
    await page4.click('button[title="Review evidence"]');
    await page4.waitForSelector("text=Evidence records", { timeout: 15000 });

    check((await page4.getByRole("button", { name: "Approve" }).count()) >= 2, "Approve is still available per evidence record");
    check((await page4.getByRole("button", { name: "Request Recheck" }).count()) >= 2, "Request Recheck is still available per evidence record");
    check((await page4.getByRole("button", { name: "Reject" }).count()) >= 2, "Reject is still available per evidence record");

    console.log("  Lightbox regression check: clicking a thumbnail still opens the full-size viewer:");
    const thumbButtons = page4.locator('button[aria-label^="View "]');
    check((await thumbButtons.count()) >= 1, "evidence photo thumbnails are still rendered as clickable lightbox triggers");
    await thumbButtons.first().click();
    await sleep(300);
    check(await page4.getByRole("button", { name: "Close photo viewer" }).isVisible(), "the lightbox still opens with its close button — unaffected by this round's change");
    await page4.getByRole("button", { name: "Close photo viewer" }).click();
    await sleep(300);

    console.log("  Reject still works:");
    await page4.getByRole("button", { name: "Reject" }).first().click();
    await sleep(400);
    const afterReject = await getLocalCityData(page4);
    check(afterReject.evidence.some((e) => e.status === "rejected"), "clicking Reject still marks the targeted evidence record 'rejected'");

    console.log("  Request Recheck still works (and still sets assignment.reviewStatus, as before):");
    await page4.getByRole("button", { name: "Request Recheck" }).first().click();
    await page4.waitForSelector("text=Request recheck —", { timeout: 15000 });
    await page4.getByRole("button", { name: "Send Recheck Request" }).click();
    await sleep(400);
    const afterRecheckRequest = await getLocalCityData(page4);
    check(afterRecheckRequest.assignments[0].reviewStatus === "recheck_requested", `Request Recheck still flips assignment.reviewStatus to 'recheck_requested' (got '${afterRecheckRequest.assignments[0].reviewStatus}')`);

    await context4.close();

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
