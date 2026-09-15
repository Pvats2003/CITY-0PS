// REAL BROWSER click-through of RigDetail's retire flow
// (src/pages/RigDetail.tsx's handleRetire() -> engine/workflows.ts's
// retireRig()). Drives the actual rendered app (production build) with
// Playwright, handling the real native `window.confirm()` dialog (not a
// mocked function) for both Cancel and Confirm paths, and verifies the
// resulting state persists across a full page reload.
//
// Run with: npm run test:rig-retire-flow

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4198;
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

const RIG_ID = "rig_retire";

async function seedScenario(page) {
  await page.evaluate((RIG_ID) => {
    const now = new Date().toISOString();
    const rig = { id: RIG_ID, code: "R-RETIRE", model: "Test Rig", active: true, batteryPct: 90, storagePct: 10, deploymentStatus: "active", createdAt: now };
    const cityData = {
      version: 2,
      settings: { cityName: "Retire Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
      businesses: [], fos: [], collectors: [], rigs: [rig], assignments: [],
      sessions: [], evidence: [], issues: [], qualityReviews: [], correctiveActions: [], rigIncidents: [], repairRecords: [], activity: [], plans: [], reports: [],
    };
    localStorage.setItem("city-ops-os", JSON.stringify({ state: cityData, version: 2 }));
    localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-manager", email: "manager@demo.city-ops", role: "MANAGER", displayName: "Demo Manager", createdAt: now }));
  }, RIG_ID);
}

async function getRig(page, id) {
  return page.evaluate((id) => {
    const raw = JSON.parse(localStorage.getItem("city-ops-os") || "{}");
    return (raw.state?.rigs || []).find((r) => r.id === id) ?? null;
  }, id);
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
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (err) => console.error("  [page error]", err.message));

    await page.goto(`${BASE_URL}/login`);
    await seedScenario(page);
    await page.goto(`${BASE_URL}/fleet/${RIG_ID}`);
    await page.waitForSelector('button:has-text("Retire")', { timeout: 15000 });

    console.log("\n[1] Cancel on the confirm dialog leaves the rig unchanged:");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "Retire" }).click();
    await sleep(400);
    let rig = await getRig(page, RIG_ID);
    check(rig.deploymentStatus === "active", "cancelling the confirm dialog leaves deploymentStatus unchanged ('active')");
    check(rig.active === true, "cancelling the confirm dialog leaves active=true");
    check(await page.getByRole("button", { name: "Retire" }).isVisible(), "the Retire button is still present after cancelling");
    check(await page.getByRole("button", { name: "Report Incident" }).isVisible(), "Report Incident is still available after cancelling (rig isn't retired)");

    console.log("\n[2] Confirm on the dialog actually retires the rig:");
    let dialogMessage = "";
    page.once("dialog", (dialog) => { dialogMessage = dialog.message(); dialog.accept(); });
    await page.getByRole("button", { name: "Retire" }).click();
    await sleep(400);
    check(dialogMessage.includes("R-RETIRE"), `the confirm dialog names the specific rig code (got: "${dialogMessage}")`);
    rig = await getRig(page, RIG_ID);
    check(rig.deploymentStatus === "retired", "confirming sets deploymentStatus to 'retired' on the real record");
    check(rig.active === false, "confirming sets active=false");
    check(!!rig.retiredAt, "confirming stamps retiredAt");
    check(!(await page.getByRole("button", { name: "Retire" }).isVisible().catch(() => false)), "the Retire button disappears once the rig is retired (can't retire twice)");
    check(!(await page.getByRole("button", { name: "Report Incident" }).isVisible().catch(() => false)), "Report Incident also disappears once retired");
    check(await page.locator("text=Retired").first().isVisible(), "the deployment status label now reads 'Retired'");

    const activity = await page.evaluate(() => (JSON.parse(localStorage.getItem("city-ops-os") || "{}").state?.activity || []));
    check(activity.some((e) => e.type === "rig_retired" && e.rigId === RIG_ID), "a real 'rig_retired' activity event was logged");

    console.log("\n[3] The retired state persists across a full page reload:");
    await page.reload();
    await page.waitForSelector("text=Retired", { timeout: 15000 });
    rig = await getRig(page, RIG_ID);
    check(rig.deploymentStatus === "retired", "deploymentStatus is still 'retired' after reload (read from persisted localStorage, not in-memory state)");
    check(!(await page.getByRole("button", { name: "Retire" }).isVisible().catch(() => false)), "the Retire button remains absent after reload");

    console.log("\n[4] Navigating to a nonexistent rig id redirects to Fleet, rather than crashing:");
    await page.goto(`${BASE_URL}/fleet/does_not_exist`);
    await sleep(400);
    check(page.url().endsWith("/fleet"), `navigating to a stale/nonexistent rig id redirects to /fleet (got ${page.url()})`);

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
