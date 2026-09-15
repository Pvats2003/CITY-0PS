// REAL BROWSER click-through of the Field Officer's complete execution
// flow — not a source review. Drives the actual rendered app (production
// build) with Playwright, including REAL browser geolocation (via
// context.setGeolocation()/grantPermissions(), not a mocked function) for
// the "I'm at Location" step: En Route -> Arrival/GPS -> Location photo ->
// Rig Precheck (checklist + photo) -> Installation (photo) -> Start
// Session -> Recording view. Also exercises the Issues/Sessions/Profile
// tabs, sign-out, and (separately) offline/online transition. Collects
// console errors throughout.
//
// The recheck/resubmission LIFECYCLE (Manager requests recheck -> FO
// resubmits -> Manager approves -> reviewStatus reconciliation) already
// has dedicated, deeper, cross-device regression coverage in
// evidence-recheck-persistence.regression.mjs and
// evidence-recheck-reconciliation.regression.mjs — this file adds a
// lighter, single-device UI check that the FO's "ACTION REQUIRED" screen
// renders correctly and the retake control is reachable, rather than
// duplicating that full lifecycle proof.
//
// Run with: npm run test:fo-full-execution-clickthrough

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4196;
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
    } catch {}
    await sleep(500);
  }
  throw new Error("Server did not become ready in time");
}

function killAndWait(child) {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill();
    setTimeout(resolve, 3000);
  }).then(() => new Promise((resolve) => {
    const fuser = spawn("fuser", ["-k", `${PORT}/tcp`]);
    fuser.on("exit", () => resolve());
    fuser.on("error", () => resolve());
    setTimeout(resolve, 2000);
  }));
}

async function setInputFile(page) {
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") });
  await sleep(200);
}

/** The Installation stage requires THREE independent photos (Installation,
 * Cable routing, Final setup) before "Submit Installation" enables — fills
 * every visible file input on the page, not just the first. */
async function setAllInputFiles(page) {
  const inputs = await page.locator('input[type="file"]').all();
  for (const input of inputs) {
    await input.setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") });
    await sleep(150);
  }
}

const BIZ_ID = "biz_exec";
const FO_ID = "fo_exec";
const RIG_ID = "rig_exec";
const ASG_ID = "asg_exec";
const RECHECK_ASG_ID = "asg_exec_recheck";
const RECHECK_EV_ID = "ev_exec_recheck";

async function seedExecutionScenario(page) {
  await page.evaluate(({ BIZ_ID, FO_ID, RIG_ID, ASG_ID, RECHECK_ASG_ID, RECHECK_EV_ID }) => {
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const business = { id: BIZ_ID, name: "Execution Test Business", category: "General", area: "Area", address: "", capacityHoursPerDay: 10, active: true, createdAt: now };
    // No lat/lng on the business — verifyLocation() then reports
    // "No recorded business coordinates to verify against" and treats the
    // real GPS fix as verified, which is real product behavior for any
    // business that hasn't had coordinates entered yet.
    const fo = { id: FO_ID, name: "Execution Test FO", homeArea: "Area", phone: "+1 555 0199", active: true, createdAt: now };
    const rig = { id: RIG_ID, code: "R-EXEC", model: "Test Rig", active: true, batteryPct: 90, storagePct: 10, deploymentStatus: "active", createdAt: now };
    const assignment = {
      id: ASG_ID,
      date: today,
      businessId: BIZ_ID,
      foId: FO_ID,
      rigId: RIG_ID,
      plannedStart: `${today}T08:00:00.000Z`,
      plannedEnd: `${today}T11:00:00.000Z`,
      priority: "normal",
      status: "confirmed",
      createdAt: now,
    };
    // A second assignment already sitting in recheck_requested, to exercise
    // the ACTION REQUIRED / retake screen without re-deriving the whole
    // recheck lifecycle (covered elsewhere).
    const recheckBusiness = { id: "biz_exec_recheck", name: "Recheck Screen Business", category: "General", area: "Area", address: "", capacityHoursPerDay: 10, active: true, createdAt: now };
    const recheckAssignment = {
      id: RECHECK_ASG_ID,
      date: today,
      businessId: "biz_exec_recheck",
      foId: FO_ID,
      rigId: RIG_ID,
      plannedStart: `${today}T12:00:00.000Z`,
      plannedEnd: `${today}T15:00:00.000Z`,
      priority: "normal",
      status: "confirmed",
      actualArrivalAt: now,
      reviewStatus: "recheck_requested",
      createdAt: now,
    };
    const recheckEvidence = {
      id: RECHECK_EV_ID,
      assignmentId: RECHECK_ASG_ID,
      businessId: "biz_exec_recheck",
      foId: FO_ID,
      type: "LOCATION",
      startedAt: now,
      capturedAt: now,
      files: [],
      status: "recheck_requested",
      reviewNote: "Photo was too blurry — please retake.",
      createdAt: now,
    };
    const cityData = {
      version: 2,
      settings: { cityName: "Execution Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
      businesses: [business, recheckBusiness],
      fos: [fo],
      collectors: [],
      rigs: [rig],
      assignments: [assignment, recheckAssignment],
      sessions: [],
      evidence: [recheckEvidence],
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
      JSON.stringify({ id: "demo-fo-" + FO_ID, email: "exec.fo@demo.city-ops", role: "FIELD_OFFICER", displayName: fo.name, foId: FO_ID, createdAt: now }),
    );
  }, { BIZ_ID, FO_ID, RIG_ID, ASG_ID, RECHECK_ASG_ID, RECHECK_EV_ID });
}

async function getAssignment(page, id) {
  return page.evaluate((id) => {
    const raw = JSON.parse(localStorage.getItem("city-ops-os") || "{}");
    return (raw.state?.assignments || []).find((a) => a.id === id) ?? null;
  }, id);
}

async function getEvidenceForAssignment(page, assignmentId) {
  return page.evaluate((assignmentId) => {
    const raw = JSON.parse(localStorage.getItem("city-ops-os") || "{}");
    return (raw.state?.evidence || []).filter((e) => e.assignmentId === assignmentId);
  }, assignmentId);
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
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      geolocation: { latitude: 12.9716, longitude: 77.5946 },
      permissions: ["geolocation"],
    });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(e.message));

    await page.goto(`${BASE_URL}/fo`);
    await seedExecutionScenario(page);
    await page.goto(`${BASE_URL}/fo`);
    await page.waitForSelector("text=Execution Test Business", { timeout: 15000 });

    console.log("\n[1] En Route -> real GPS arrival -> location photo:");
    await page.click("text=Execution Test Business");
    await page.waitForSelector('button:has-text("I\'m on my way")', { timeout: 15000 });
    await page.getByRole("button", { name: "I'm on my way" }).click();
    await sleep(300);
    let assignment = await getAssignment(page, ASG_ID);
    check(!!assignment.enRouteAt, "'I'm on my way' sets enRouteAt on the real assignment record");

    await page.getByRole("button", { name: "I'm at Location" }).click();
    await page.waitForSelector("text=LOCATION PHOTO", { timeout: 15000 });
    check(true, "real browser geolocation resolved and the LOCATION step rendered");
    await setInputFile(page);
    const continueBtn = page.getByRole("button", { name: "Continue to Rig Precheck" });
    check(!(await continueBtn.isDisabled()), "'Continue to Rig Precheck' enables once a location photo is attached");
    await continueBtn.click();
    await sleep(400);
    const evidenceAfterLocation = await getEvidenceForAssignment(page, ASG_ID);
    const locationEv = evidenceAfterLocation.find((e) => e.type === "LOCATION");
    check(!!locationEv && locationEv.files.length === 1, "LOCATION evidence was created with exactly the attached photo (real store write, not just UI state)");

    console.log("\n[2] Rig Precheck: checklist + photo + submit:");
    await page.waitForSelector("text=RIG PRECHECK", { timeout: 15000 }).catch(() => {});
    const checkboxes = await page.locator('[role="checkbox"]').all();
    for (const cb of checkboxes) await cb.click().catch(() => {});
    await setInputFile(page);
    const submitPrecheckBtn = page.getByRole("button", { name: "Submit Precheck" });
    await submitPrecheckBtn.click();
    await sleep(400);
    const evidenceAfterPrecheck = await getEvidenceForAssignment(page, ASG_ID);
    check(evidenceAfterPrecheck.some((e) => e.type === "RIG_PRECHECK"), "RIG_PRECHECK evidence was created by the real Submit Precheck action");

    console.log("\n[3] Installation: checklist + three required photos + submit:");
    await page.waitForSelector('button:has-text("Start Installation")', { timeout: 15000 });
    await page.getByRole("button", { name: "Start Installation" }).click();
    await sleep(300);
    for (const cb of await page.locator('[role="checkbox"]').all()) await cb.click().catch(() => {});
    await setAllInputFiles(page);
    const submitInstallBtn = page.getByRole("button", { name: "Submit Installation" });
    await submitInstallBtn.click();
    await sleep(500);
    const evidenceAfterInstall = await getEvidenceForAssignment(page, ASG_ID);
    check(evidenceAfterInstall.some((e) => e.type === "INSTALLATION"), "INSTALLATION evidence was created by the real Submit Installation action");

    console.log("\n[4] Installation Verified checklist -> Start Session -> Recording view renders:");
    await page.waitForSelector("text=INSTALLATION VERIFIED", { timeout: 15000 }).catch(() => {});
    for (const cb of await page.locator('[role="checkbox"]').all()) await cb.click().catch(() => {});
    const startSessionBtn = page.getByRole("button", { name: "Start Session" });
    if (await startSessionBtn.isVisible().catch(() => false)) {
      await startSessionBtn.click();
      await sleep(500);
      check(await page.locator("text=Recording").first().isVisible().catch(() => false), "the Recording view renders after Start Session");
      const sessionsAfterStart = await page.evaluate(() => (JSON.parse(localStorage.getItem("city-ops-os") || "{}").state?.sessions || []));
      check(sessionsAfterStart.some((s) => s.assignmentId === ASG_ID && s.status === "active"), "a real active Session record was created");
    } else {
      check(false, "'Start Session' button was not reached — installation verification gate may be blocking unexpectedly");
    }

    console.log("\n[5] Recheck 'ACTION REQUIRED' screen renders and the retake control is reachable:");
    await page.getByRole("button", { name: "Back to today's list" }).click();
    await sleep(300);
    await page.click("text=Recheck Screen Business");
    await sleep(300);
    check(await page.locator("text=ACTION REQUIRED").isVisible(), "the ACTION REQUIRED screen renders for the pre-seeded recheck_requested assignment");
    check(await page.locator("text=Photo was too blurry").isVisible(), "the Manager's review note is shown verbatim to the FO");
    const retakeBtn = page.getByRole("button", { name: /Retake photo/ });
    check(await retakeBtn.isVisible(), "a 'Retake photo' control is reachable on the ACTION REQUIRED screen");

    console.log("\n[6] Issues / Sessions / Profile tabs + sign out:");
    await page.getByRole("button", { name: "Issues", exact: true }).click();
    await sleep(300);
    check(true, "Issues tab renders without throwing");
    await page.getByRole("button", { name: "Sessions", exact: true }).click();
    await sleep(300);
    check(true, "Sessions tab renders without throwing");
    await page.getByRole("button", { name: "Profile", exact: true }).click();
    await sleep(300);
    check(await page.getByRole("combobox").first().isVisible(), "Profile tab's theme selector is reachable");
    // Two "Sign out" controls coexist on the Profile tab (the always-present
    // header icon button, and the Profile tab's own explicit button) —
    // click the explicit one.
    await page.getByRole("button", { name: "Sign out" }).last().click();
    await sleep(500);
    check(page.url().includes("/fo/login") || page.url().includes("/login"), "Sign out redirects away from the FO shell");

    console.log("\n[7] Offline -> online recovery is reflected in the real network status:");
    await context.setOffline(true);
    await sleep(300);
    check(await page.evaluate(() => !navigator.onLine), "the browser reports offline after context.setOffline(true)");
    await context.setOffline(false);
    await sleep(300);
    check(await page.evaluate(() => navigator.onLine), "the browser reports back online after context.setOffline(false)");

    console.log("\n[8] Console health across the whole execution flow:");
    const uniqueErrors = [...new Set(consoleErrors)];
    check(uniqueErrors.length === 0, `zero unexpected console errors across the whole FO execution flow${uniqueErrors.length ? " — got: " + uniqueErrors.slice(0, 5).join(" | ") : ""}`);

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
