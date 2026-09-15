// Regression test for: several icon-only buttons across the Manager and
// Field Officer UI had no accessible name at all (no visible text, no
// aria-label, no title) — a screen reader announces a bare "button" with
// no indication of what it does. Found during the platform accessibility
// audit (Phase 12: "Ensure every icon-only button has an accessible
// name").
//
// Fixed sites:
//   - src/components/layout/MobileNav.tsx: hamburger ("Open menu"),
//     command palette ("Open command palette"), drawer close ("Close menu").
//   - src/components/layout/Topbar.tsx: desktop theme dropdown trigger
//     ("Change theme").
//   - src/pages/FOExecution.tsx: back-chevron from an open assignment
//     ("Back to today's list").
//   - src/pages/BusinessDetail.tsx: icon-only "add collector" submit
//     ("Add collector").
//   - src/pages/CommandCenter.tsx: City Pulse info popover trigger
//     ("Why is this score?").
//
// This test drives the REAL app UI via Playwright against a production
// build and asserts each button is reachable by its accessible name
// (Playwright's getByRole(..., { name }) resolves via the browser's own
// accessible-name computation, so this is a real assertion on what a
// screen reader would announce, not a source-text grep) AND that it still
// performs its original action — proving the labels were added without
// changing behavior.
//
// Run with: npm run test:accessible-icon-buttons

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4193;
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

const BIZ_ID = "biz_a11y";
const FO_ID = "fo_a11y";
const RIG_ID = "rig_a11y";
const ASG_ID = "asg_a11y";

async function seedScenario(page) {
  await page.evaluate(({ BIZ_ID, FO_ID, RIG_ID, ASG_ID }) => {
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const business = { id: BIZ_ID, name: "Accessibility Test Biz", category: "General", area: "Area", address: "", capacityHoursPerDay: 3, active: true, createdAt: now };
    const fo = { id: FO_ID, name: "Accessibility Test FO", active: true, createdAt: now };
    const rig = { id: RIG_ID, code: "R-A11Y", model: "Test Rig", active: true, batteryPct: 100, storagePct: 0, deploymentStatus: "active", createdAt: now };
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
  }, { BIZ_ID, FO_ID, RIG_ID, ASG_ID });
}

async function signInAs(page, role) {
  await page.evaluate((role) => {
    const now = new Date().toISOString();
    if (role === "MANAGER") {
      localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-manager", email: "manager@demo.city-ops", role: "MANAGER", displayName: "Demo Manager", createdAt: now }));
    } else {
      localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-fo-fo_a11y", email: "a11y.fo@demo.city-ops", role: "FIELD_OFFICER", displayName: "Accessibility Test FO", foId: "fo_a11y", createdAt: now }));
    }
  }, role);
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

    console.log("\n[1] Manager desktop: Topbar theme button and CommandCenter info popover have accessible names:");
    const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const desktopPage = await desktopContext.newPage();
    desktopPage.on("pageerror", (err) => console.error("  [page error]", err.message));
    await desktopPage.goto(`${BASE_URL}/login`);
    await seedScenario(desktopPage);
    await signInAs(desktopPage, "MANAGER");
    await desktopPage.goto(`${BASE_URL}/`);
    await desktopPage.waitForSelector("text=City Pulse", { timeout: 15000 });

    const themeButton = desktopPage.getByRole("button", { name: "Change theme" });
    check(await themeButton.isVisible(), "the desktop Topbar theme button is reachable by its accessible name 'Change theme'");
    await themeButton.click();
    check(await desktopPage.getByRole("menuitem", { name: /Light/ }).isVisible(), "clicking it still opens the theme dropdown menu (behavior unchanged)");
    await desktopPage.keyboard.press("Escape");

    const infoButton = desktopPage.getByRole("button", { name: "Why is this score?" });
    check(await infoButton.isVisible(), "the City Pulse info button is reachable by its accessible name 'Why is this score?'");
    await infoButton.click();
    check(await desktopPage.locator("text=/Why is this \\d/").isVisible(), "clicking it still opens the score explanation popover (behavior unchanged)");

    console.log("\n[2] Manager: BusinessDetail 'Add collector' button has an accessible name and still works:");
    await desktopPage.goto(`${BASE_URL}/businesses/${BIZ_ID}`);
    await desktopPage.waitForSelector('button:has-text("Edit")', { timeout: 15000 });
    const addCollectorButton = desktopPage.getByRole("button", { name: "Add collector" });
    check(await addCollectorButton.isVisible(), "the icon-only 'add collector' button is reachable by its accessible name");
    await desktopPage.locator("#collector-name, input[placeholder='Collector name']").fill("Test Collector");
    await addCollectorButton.click();
    await sleep(300);
    check(await desktopPage.locator("text=Test Collector").isVisible(), "clicking it still adds the collector (behavior unchanged)");
    await desktopContext.close();

    console.log("\n[3] Manager mobile: hamburger, command palette, and drawer close buttons all have accessible names:");
    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobilePage = await mobileContext.newPage();
    mobilePage.on("pageerror", (err) => console.error("  [page error]", err.message));
    await mobilePage.goto(`${BASE_URL}/login`);
    await seedScenario(mobilePage);
    await signInAs(mobilePage, "MANAGER");
    await mobilePage.goto(`${BASE_URL}/`);
    const openMenuButton = mobilePage.getByRole("button", { name: "Open menu" });
    await openMenuButton.waitFor({ timeout: 15000 });
    check(await openMenuButton.isVisible(), "the mobile hamburger button is reachable by its accessible name 'Open menu'");
    await openMenuButton.click();
    const closeMenuButton = mobilePage.getByRole("button", { name: "Close menu" });
    check(await closeMenuButton.isVisible(), "the drawer close button is reachable by its accessible name 'Close menu'");
    await closeMenuButton.click();
    check(!(await closeMenuButton.isVisible().catch(() => false)), "clicking it still closes the drawer (behavior unchanged)");

    const paletteButton = mobilePage.getByRole("button", { name: "Open command palette" });
    check(await paletteButton.isVisible(), "the mobile command-palette button is reachable by its accessible name 'Open command palette'");
    await paletteButton.click();
    check(await mobilePage.getByPlaceholder("Search or ask a question…").isVisible(), "clicking it still opens the command palette (behavior unchanged)");
    await mobileContext.close();

    console.log("\n[4] Field Officer: the back-chevron from an open assignment has an accessible name and still works:");
    const foContext = await browser.newContext();
    const foPage = await foContext.newPage();
    foPage.on("pageerror", (err) => console.error("  [page error]", err.message));
    await foPage.goto(`${BASE_URL}/fo`);
    await seedScenario(foPage);
    await signInAs(foPage, "FIELD_OFFICER");
    await foPage.goto(`${BASE_URL}/fo`);
    await foPage.waitForSelector("text=Accessibility Test Biz", { timeout: 15000 });
    await foPage.click("text=Accessibility Test Biz");
    await foPage.waitForSelector("text=Visit", { timeout: 15000 });

    const backButton = foPage.getByRole("button", { name: "Back to today's list" });
    check(await backButton.isVisible(), "the FO back button is reachable by its accessible name 'Back to today's list'");
    await backButton.click();
    check(await foPage.locator("text=/VISIT/").first().isVisible(), "clicking it still returns to Today's list (behavior unchanged)");
    await foContext.close();

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
