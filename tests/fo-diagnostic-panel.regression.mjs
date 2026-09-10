// Regression test: the CITY OPS DIAGNOSTIC panel (FoDiagnosticPanel, see
// src/components/FoDiagnosticPanel.tsx) must NEVER be reachable by a real
// Field Officer in a production deployment — not by default, not via a URL
// query param, not via a localStorage flag, on any FO screen. It must
// still be available to a developer running `npm run dev` locally, per the
// contract in src/lib/diagnosticsAccess.ts (isDiagnosticsEnabled() ===
// import.meta.env.DEV, full stop — no runtime opt-in of any kind).
//
// Standalone script (no @playwright/test runner is configured in this repo)
// using the `playwright` package directly. Runs two server modes:
//  - `vite preview` (serves the built `dist/`) to prove the PRODUCTION
//    contract: import.meta.env.DEV is false there, exactly as in a real
//    deployment.
//  - `vite dev` to prove the LOCAL DEVELOPMENT contract still works.
//
// Run with: npm run test:fo-diagnostic

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4177;
const BASE_URL = `http://localhost:${PORT}`;
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
// The local vite binary directly — NOT `npx vite`, whose wrapper process can
// leave an orphaned child holding the port after the parent is killed.
const VITE_BIN = "node_modules/.bin/vite";

const DIAGNOSTIC_STRINGS = [
  "CITY OPS DIAGNOSTIC",
  "BUILD SHA",
  "BUILD TIME",
  "FIREBASE PROJECT",
  "AUTH UID",
  "PROFILE PATH",
  "PROFILE EXISTS",
  "PROFILE DOC ID",
  "PROFILE KEYS",
  "UID === DOC ID",
  "FOS SYNCED",
  "FOS COUNT",
  "MATCHED FO",
  "CURRENT SCREEN",
  "SYNC_ERROR",
  "SNAPSHOT_COUNT",
  "LATEST_SNAPSHOT",
];

// The opt-in mechanism this test proves is now GONE (a prior, rejected
// design used this URL param + localStorage key to let anyone reveal the
// panel in production — see requirements B/C this test guards against).
const LEGACY_STORAGE_KEY = "city-ops-diagnostics-enabled";

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

async function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
}

async function assertNoDiagnosticStrings(page, screenLabel) {
  const text = await bodyText(page);
  for (const needle of DIAGNOSTIC_STRINGS) {
    check(!text.includes(needle), `${screenLabel}: does not contain "${needle}"`);
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

async function loginAsDemoManagerAndLoadCity(page) {
  await page.goto(`${BASE_URL}/login`);
  await page.click("text=Continue as Manager");
  await page.waitForSelector("text=Load Demo City", { timeout: 15000 });
  await page.click("text=Load Demo City");
  await page.waitForURL(/\/(today)?$/, { timeout: 15000 }).catch(() => {});
  await sleep(1000); // let the store finish loading demo data
}

async function switchToDemoFieldOfficer(page) {
  await page.evaluate(() => {
    localStorage.removeItem("city-ops-auth");
    window.dispatchEvent(new CustomEvent("city-ops-auth-change"));
  });
  await page.goto(`${BASE_URL}/login`);
  await page.click("text=Continue as Field Officer");
  await page.waitForURL(/\/fo/, { timeout: 15000 });
  await page.waitForSelector("text=Today", { timeout: 15000 });
  await sleep(500);
}

async function runProductionSuite() {
  console.log("Building production bundle...");
  await new Promise((resolve, reject) => {
    const build = spawn("npm", ["run", "build"], { cwd: process.cwd(), stdio: "inherit" });
    build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build failed with code ${code}`))));
  });

  console.log("Serving production build via `vite preview`...");
  const server = spawn(VITE_BIN, ["preview", "--port", String(PORT), "--strictPort"], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
  let serverOutput = "";
  server.stdout.on("data", (d) => (serverOutput += d.toString()));
  server.stderr.on("data", (d) => (serverOutput += d.toString()));

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  try {
    await waitForServer();
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (err) => console.error("  [page error]", err.message));

    console.log("\nSigning in as demo Manager and loading demo city...");
    await loginAsDemoManagerAndLoadCity(page);
    console.log("Switching to demo Field Officer identity...");
    await switchToDemoFieldOfficer(page);

    console.log("\n[A] Production FO Today's Plan (default) — diagnostic panel must be absent:");
    await assertNoDiagnosticStrings(page, "Today's Plan");

    console.log("\n[D] Every other normal FO tab must also be free of diagnostic output:");
    for (const [tab, label] of [
      ["Sessions", "Sessions tab"],
      ["Issues", "Issues tab"],
      ["Profile", "Profile tab"],
    ]) {
      await page.click(`nav >> text=${tab}`);
      await sleep(300);
      await assertNoDiagnosticStrings(page, label);
    }

    console.log('\n[B] Production FO "/fo?diag=1" must STILL show no diagnostic panel (no runtime opt-in exists):');
    await page.goto(`${BASE_URL}/fo?diag=1`);
    await page.waitForSelector("text=Today", { timeout: 15000 });
    await sleep(500);
    await assertNoDiagnosticStrings(page, "/fo?diag=1");

    console.log("\n[C] A pre-existing (legacy) localStorage diagnostic flag must NOT enable the panel:");
    await page.evaluate((key) => localStorage.setItem(key, "1"), LEGACY_STORAGE_KEY);
    await page.reload();
    await page.waitForSelector("text=Today", { timeout: 15000 });
    await sleep(500);
    await assertNoDiagnosticStrings(page, "Today's Plan with legacy localStorage flag set");
    // Also prove refresh/navigation with the flag still set never exposes it.
    await page.click('nav >> text=Sessions');
    await sleep(300);
    await assertNoDiagnosticStrings(page, "Sessions tab with legacy localStorage flag set");
    await page.evaluate((key) => localStorage.removeItem(key), LEGACY_STORAGE_KEY);

    if (failures > 0) console.error("\n--- preview server output (for debugging) ---\n" + serverOutput.slice(-4000));
  } finally {
    await browser.close();
    await killAndWait(server);
  }
}

async function runDevSuite() {
  console.log("\nStarting `vite dev` server...");
  const server = spawn(VITE_BIN, ["--port", String(PORT), "--strictPort"], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
  let serverOutput = "";
  server.stdout.on("data", (d) => (serverOutput += d.toString()));
  server.stderr.on("data", (d) => (serverOutput += d.toString()));

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  try {
    await waitForServer();
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (err) => console.error("  [page error]", err.message));

    console.log("\nSigning in as demo Manager and loading demo city (dev mode)...");
    await loginAsDemoManagerAndLoadCity(page);
    console.log("Switching to demo Field Officer identity...");
    await switchToDemoFieldOfficer(page);

    console.log("\n[E] Local development (`npm run dev`) — diagnostics remain available by default, no opt-in needed:");
    const text = await bodyText(page);
    check(text.includes("CITY OPS DIAGNOSTIC"), "vite dev, FO Today's Plan: CITY OPS DIAGNOSTIC panel IS shown");

    if (failures > 0) console.error("\n--- dev server output (for debugging) ---\n" + serverOutput.slice(-4000));
  } finally {
    await browser.close();
    await killAndWait(server);
  }
}

function killAndWait(child) {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill();
    // Fallback in case the process is already gone / kill is a no-op.
    setTimeout(resolve, 3000);
  }).then(() => {
    // Belt-and-suspenders: make sure nothing is still bound to PORT before
    // the next phase tries to claim it (a `vite` child can outlive its
    // immediate parent in some process-tree shapes).
    return new Promise((resolve) => {
      const fuser = spawn("fuser", ["-k", `${PORT}/tcp`]);
      fuser.on("exit", () => resolve());
      fuser.on("error", () => resolve());
      setTimeout(resolve, 2000);
    });
  });
}

async function main() {
  await runProductionSuite();
  await runDevSuite();

  // [F] An authorized Manager/admin-only diagnostic mechanism was NOT
  // implemented in this change (the dev-only design was chosen instead, per
  // the task's own "prefer development-only diagnostics" option) — there is
  // no such surface to test. If one is added later, this suite must gain a
  // case proving a FIELD_OFFICER-role session is refused it while a
  // MANAGER-role session is allowed it.

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
