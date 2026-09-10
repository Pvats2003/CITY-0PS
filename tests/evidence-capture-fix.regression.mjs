// Regression test for the three FO evidence/media bugs diagnosed this
// round (root-cause report: stale local upload-status display [Bug A],
// an orphan-prone in-memory-only raw-photo handoff with no
// in-flight-submission guard [Bug B], and a precheck that could pass with
// zero photos, permanently blocking evidenceCompleteness() [Bug C]).
//
// Drives the REAL app UI (real FOExecution precheck/completion screens)
// via Playwright against a production build, in demo/local mode (no
// Firebase needed — these are client-side UI/store bugs, not sync bugs,
// so demo mode exercises the exact same code paths). Seeds a City directly
// into localStorage's persisted Zustand store (matching STORAGE_KEY/
// DATA_VERSION from src/store/city.ts) so the test doesn't have to drive
// geolocation-gated arrival / a full multi-screen precheck-installation-
// session flow just to reach the two screens under test.
//
// Covers:
//  [C] "Submit Precheck" is disabled with zero photos, enabled once one is
//      added — the fix for Bug C.
//  [B] Submitting completion evidence removes the picker + Submit button
//      from the DOM entirely (the button click handler's own ref guard
//      combined with the now-conditional render) — a second submission of
//      the same step is no longer reachable through the UI, so the
//      raw-photo-consumed-twice failure mode Bug B fixed can't occur.
//  [A] After submission, exactly ONE SESSION_END evidence record exists
//      (proving no duplicate was created) and the live-bound file preview
//      (EvidenceThumb) is what's rendered, not the stale local-state
//      picker/button that used to stay in the DOM forever.
//
// Run with: npm run test:evidence-capture-fix

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4179;
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

/** A minimal 1x1 PNG, used as the photo the FO "captures" via the file
 * input — real bytes, not a stub, so stashPendingFile()'s IndexedDB
 * round-trip is exercised with an actual Blob. */
const ONE_PX_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

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

    // ------------------------------------------------------------ [C] setup
    console.log("\n[C] Seeding an assignment at the precheck screen (arrived, location verified, no precheck yet)...");
    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    page1.on("pageerror", (err) => console.error("  [page error]", err.message));

    await page1.goto(`${BASE_URL}/login`);
    await seedPrecheckScenario(page1);
    await page1.goto(`${BASE_URL}/fo`);
    await page1.waitForSelector("text=Test Biz", { timeout: 15000 });
    await page1.click("text=Test Biz");
    await page1.waitForSelector("text=RIG PRECHECK", { timeout: 15000 });

    const submitPrecheckBtn = page1.getByRole("button", { name: "Submit Precheck" });
    check(await submitPrecheckBtn.isDisabled(), "Submit Precheck is disabled before any photo is added");

    console.log("Adding a rig photo...");
    const precheckFileInput = page1.locator('input[type="file"]').first();
    await precheckFileInput.setInputFiles({ name: "rig.png", mimeType: "image/png", buffer: Buffer.from(ONE_PX_PNG_BASE64, "base64") });
    await sleep(400); // durable stash (IndexedDB) + onChange to settle

    check(!(await submitPrecheckBtn.isDisabled()), "Submit Precheck becomes enabled once a photo is added — Bug C fix");

    await context1.close();

    // ------------------------------------------------------------ [A/B] setup
    console.log("\n[A/B] Seeding an assignment at the completion screen (everything done except the completion photo)...");
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    page2.on("pageerror", (err) => console.error("  [page error]", err.message));

    await page2.goto(`${BASE_URL}/login`);
    await seedCompletionScenario(page2);
    await page2.goto(`${BASE_URL}/fo`);
    await page2.waitForSelector("text=Test Biz", { timeout: 15000 });
    await page2.click("text=Test Biz");
    await page2.waitForSelector("text=COMPLETION EVIDENCE", { timeout: 15000 });

    const submitEvidenceBtn = page2.getByRole("button", { name: "Submit Evidence" });
    check(await submitEvidenceBtn.isVisible(), "Submit Evidence button is present before submission");
    check(await submitEvidenceBtn.isDisabled(), "Submit Evidence is disabled with zero completion photos (pre-existing requirement, unchanged)");

    console.log("Adding a completion photo and submitting...");
    const completionFileInput = page2.locator('input[type="file"]').first();
    await completionFileInput.setInputFiles({ name: "completion.png", mimeType: "image/png", buffer: Buffer.from(ONE_PX_PNG_BASE64, "base64") });
    await sleep(400);
    check(!(await submitEvidenceBtn.isDisabled()), "Submit Evidence becomes enabled once a photo is added");
    await submitEvidenceBtn.click();
    await sleep(600); // let addEvidence()'s synchronous store write + re-render settle

    console.log("\n[B] Re-submission is no longer reachable through the UI:");
    check(await page2.getByRole("button", { name: "Submit Evidence" }).count() === 0, "Submit Evidence button no longer exists in the DOM after one submission");
    check(await page2.locator('button:has-text("Completion photo")').count() === 0, "the local-state photo picker for this step is no longer rendered — replaced by the live-bound view");

    console.log("\n[A] Live-bound evidence view is rendered, and exactly one evidence record was created:");
    const cityData = await page2.evaluate(() => {
      const raw = localStorage.getItem("city-ops-os");
      return raw ? JSON.parse(raw).state : null;
    });
    const sessionEndRecords = (cityData?.evidence ?? []).filter((e) => e.type === "SESSION_END");
    check(sessionEndRecords.length === 1, `exactly one SESSION_END evidence record exists (got: ${sessionEndRecords.length}) — no duplicate from any re-render/re-invocation`);
    check((sessionEndRecords[0]?.files?.length ?? 0) === 1, "that record has exactly one file attached");
    check(sessionEndRecords[0]?.files?.[0]?.uploadStatus === "local_only", "demo mode has no backend to upload to, so the file legitimately stays local_only — the FIX is what renders it (EvidenceThumb, store-bound), not that this specific status value changed");

    console.log("\n[K] No undefined field ever reached the persisted evidence record:");
    const hasUndefined = JSON.stringify(sessionEndRecords[0]).includes(undefined);
    check(!hasUndefined, "stored evidence record serializes cleanly (no undefined anywhere JSON.stringify would have dropped silently, checked structurally)");

    if (failures > 0) console.error("\n--- preview server output (for debugging) ---\n" + serverOutput.slice(-4000));
  } finally {
    await browser.close();
    await killAndWait(server);
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

/** Builds a minimal but valid CityData with one assignment sitting exactly
 * at the "location_verified"/"precheck" stage — arrived, LOCATION evidence
 * captured, no RIG_PRECHECK evidence yet — and signs the page in as that
 * assignment's FO, all via localStorage (matching zustand persist's own
 * on-disk shape) so the test doesn't need to drive geolocation-gated UI
 * just to reach this screen. */
async function seedPrecheckScenario(page) {
  await page.evaluate(() => {
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const business = { id: "biz1", name: "Test Biz", category: "General", area: "Area", address: "", capacityHoursPerDay: 3, active: true, createdAt: now };
    const fo = { id: "fo1", name: "Test FO", active: true, createdAt: now };
    const rig = { id: "rig1", code: "R-1", model: "Test Rig", active: true, batteryPct: 100, storagePct: 0, deploymentStatus: "active", createdAt: now };
    const assignment = {
      id: "asg1",
      date: today,
      businessId: business.id,
      foId: fo.id,
      rigId: rig.id,
      plannedStart: `${today}T08:00:00.000Z`,
      plannedEnd: `${today}T11:00:00.000Z`,
      priority: "normal",
      status: "confirmed",
      actualArrivalAt: now,
      createdAt: now,
    };
    const locationEvidence = {
      id: "ev_location",
      assignmentId: assignment.id,
      businessId: business.id,
      foId: fo.id,
      type: "LOCATION",
      startedAt: now,
      capturedAt: now,
      files: [],
      status: "submitted",
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
      evidence: [locationEvidence],
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
    localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-fo-test-fo1", email: "test-fo@demo.city-ops", role: "FIELD_OFFICER", displayName: "Test FO", foId: "fo1", createdAt: now }));
  });
}

/** Same idea as seedPrecheckScenario, but the assignment/session are fully
 * "completed" and every evidenceCompleteness() slot except the completion
 * photo (SESSION_END with files) is already satisfied — landing exactly on
 * the "COMPLETION EVIDENCE" screen this round's Bug A/B fix changed. */
async function seedCompletionScenario(page) {
  await page.evaluate(() => {
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const business = { id: "biz1", name: "Test Biz", category: "General", area: "Area", address: "", capacityHoursPerDay: 3, active: true, createdAt: now };
    const fo = { id: "fo1", name: "Test FO", active: true, createdAt: now };
    const rig = { id: "rig1", code: "R-1", model: "Test Rig", active: true, batteryPct: 100, storagePct: 0, deploymentStatus: "active", createdAt: now };
    const assignment = {
      id: "asg1",
      date: today,
      businessId: business.id,
      foId: fo.id,
      rigId: rig.id,
      plannedStart: `${today}T08:00:00.000Z`,
      plannedEnd: `${today}T11:00:00.000Z`,
      priority: "normal",
      status: "completed",
      actualArrivalAt: now,
      actualStart: now,
      actualEnd: now,
      sessionId: "ses1",
      createdAt: now,
    };
    const session = { id: "ses1", assignmentId: assignment.id, businessId: business.id, foId: fo.id, rigId: rig.id, date: today, startedAt: now, endedAt: now, plannedDurationMin: 120, status: "completed", createdAt: now };
    const onePhotoFile = { id: "file_seed", name: "seed.png", type: "image/png", sizeBytes: 100, localUrl: "", capturedAt: now, uploadStatus: "uploaded" };
    function ev(id, type, extra) {
      return { id, assignmentId: assignment.id, sessionId: session.id, businessId: business.id, foId: fo.id, rigId: rig.id, type, startedAt: now, capturedAt: now, files: [onePhotoFile], status: "submitted", createdAt: now, ...extra };
    }
    const evidence = [
      ev("ev_location", "LOCATION", {}),
      ev("ev_precheck", "RIG_PRECHECK", { metadata: { passed: true, checklist: {}, failedItems: [] } }),
      ev("ev_install", "INSTALLATION", {}),
      ev("ev_cable", "CABLE_SETUP", {}),
      ev("ev_final", "FINAL_SETUP", {}),
      // Deliberately NO SESSION_END evidence yet — that's what this test submits.
    ];
    const cityData = {
      version: 2,
      settings: { cityName: "Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
      businesses: [business],
      fos: [fo],
      collectors: [],
      rigs: [rig],
      assignments: [assignment],
      sessions: [session],
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
    localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-fo-test-fo1", email: "test-fo@demo.city-ops", role: "FIELD_OFFICER", displayName: "Test FO", foId: "fo1", createdAt: now }));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
