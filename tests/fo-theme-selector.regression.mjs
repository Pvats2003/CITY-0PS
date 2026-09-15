// Regression test for: Field Officer has no in-app theme control.
//
// GAP FOUND during platform audit: the app's theme mechanism
// (src/lib/theme.ts's useApplyTheme(), called once above <Routes> in
// App.tsx) is correctly shared infrastructure for both roles, and
// `settings` (including `theme`) is intentionally device-local — excluded
// from Firestore sync by src/data/backend.ts's CollectionName type. But the
// only theme <Select> control in the whole app lived in Settings.tsx, a
// Manager-only route. The Field Officer had NO way to choose light/dark
// theme, unlike the Manager.
//
// FIX: FOExecution.tsx's ProfileTab now renders the same Select-based theme
// control the Manager already uses in Settings.tsx, bound to the same
// `updateSettings` action and the same `settings.theme` field — no new
// theme system, no duplicated logic.
//
// This test drives the REAL app UI (real FO login, real Profile tab, real
// Select control) via Playwright against a production build, and proves:
//   1. The FO Profile tab renders a Theme selector.
//   2. Selecting "Light" actually removes the `dark` class from
//      document.documentElement (the same mechanism useApplyTheme() drives).
//   3. Selecting "Dark" re-applies it.
//   4. The choice persists in the device-local `city-ops-os` localStorage
//      key across a full page reload.
//   5. It's the same shared `settings.theme` field the Manager's own
//      Settings page reads/writes — not a second, disconnected FO-only
//      theme system.
//
// Run with: npm run test:fo-theme-selector

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4191;
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

async function seedFoScenario(page) {
  await page.evaluate(() => {
    const now = new Date().toISOString();
    const fo = { id: "fo_theme", name: "Theme Test FO", active: true, createdAt: now };
    const cityData = {
      version: 2,
      settings: { cityName: "Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
      businesses: [],
      fos: [fo],
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
    };
    localStorage.setItem("city-ops-os", JSON.stringify({ state: cityData, version: 2 }));
    localStorage.setItem(
      "city-ops-auth",
      JSON.stringify({ id: "demo-fo-fo_theme", email: "theme.test.fo@demo.city-ops", role: "FIELD_OFFICER", displayName: fo.name, foId: fo.id, createdAt: now }),
    );
  });
}

async function readSettings(page) {
  return page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("city-ops-os") || "{}").state?.settings ?? null;
    } catch {
      return null;
    }
  });
}

async function isDarkApplied(page) {
  return page.evaluate(() => document.documentElement.classList.contains("dark"));
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

    console.log("\n[1] FO logs in, opens Profile tab, and a Theme selector is present:");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (err) => console.error("  [page error]", err.message));

    await page.goto(`${BASE_URL}/fo`);
    await seedFoScenario(page);
    await page.goto(`${BASE_URL}/fo`);
    await page.waitForSelector('button:has-text("Profile")', { timeout: 15000 });
    await page.click('button:has-text("Profile")');
    await page.waitForSelector("text=Signed in as", { timeout: 15000 });

    check(await isDarkApplied(page), "(setup) page starts in dark theme, matching seeded settings.theme='dark'");
    const themeCombobox = page.getByRole("combobox");
    check(await themeCombobox.isVisible(), "the FO Profile tab renders a theme selector (previously: no theme control existed for FOs at all)");

    console.log("\n[2] Selecting 'Light' actually applies light theme:");
    await themeCombobox.click();
    await page.locator('[role="option"]:has-text("Light")').click();
    await sleep(300);
    check(!(await isDarkApplied(page)), "selecting 'Light' removes the 'dark' class from <html> — the real useApplyTheme() mechanism reacted to the FO's choice");
    const settingsAfterLight = await readSettings(page);
    check(settingsAfterLight?.theme === "light", `the shared settings.theme field was updated to 'light' (got '${settingsAfterLight?.theme}')`);

    console.log("\n[3] Selecting 'Dark' re-applies dark theme:");
    await themeCombobox.click();
    await page.locator('[role="option"]:has-text("Dark")').click();
    await sleep(300);
    check(await isDarkApplied(page), "selecting 'Dark' re-applies the 'dark' class");
    const settingsAfterDark = await readSettings(page);
    check(settingsAfterDark?.theme === "dark", `settings.theme was updated back to 'dark' (got '${settingsAfterDark?.theme}')`);

    console.log("\n[4] The choice persists across a full page reload:");
    await themeCombobox.click();
    await page.locator('[role="option"]:has-text("Light")').click();
    await sleep(300);
    await page.reload();
    await sleep(500);
    check(!(await isDarkApplied(page)), "after reload, the app boots directly into the persisted 'light' theme — no flash back to dark");
    const settingsAfterReload = await readSettings(page);
    check(settingsAfterReload?.theme === "light", "settings.theme in localStorage still reads 'light' after reload");

    console.log("\n[5] It's the same shared settings field the Manager's Settings page uses (no duplicate FO-only theme system):");
    // Log back in as Manager on the same device/localStorage and confirm
    // Settings.tsx reflects the FO's own theme choice — proving there is
    // exactly one settings.theme field, not two independent ones.
    await page.evaluate(() => {
      const now = new Date().toISOString();
      localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-manager", email: "manager@demo.city-ops", role: "MANAGER", displayName: "Demo Manager", createdAt: now }));
    });
    await page.goto(`${BASE_URL}/settings`);
    await page.waitForSelector("text=Theme", { timeout: 15000 });
    const managerThemeCombobox = page.getByRole("combobox").first();
    const managerThemeText = await managerThemeCombobox.textContent();
    check((managerThemeText ?? "").toLowerCase().includes("light"), `the Manager's own Settings page shows the theme the FO just set ('${managerThemeText}') — one shared device-local settings.theme field, not a duplicated theme system`);

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
