// Regression test: the CITY OPS DIAGNOSTIC panel (FoDiagnosticPanel, see
// src/components/FoDiagnosticPanel.tsx) must NEVER be visible to a Field
// Officer's normal product experience (Today's Plan, Sessions, Issues,
// Profile), but its underlying logic must still be reachable through the
// developer/support opt-in described in src/lib/diagnosticsAccess.ts.
//
// Standalone script (no @playwright/test runner is configured in this repo)
// using the `playwright` package directly against a locally served
// PRODUCTION build (`vite preview`, not `vite dev`) — `import.meta.env.DEV`
// is true under `vite dev`, which would always enable the diagnostics panel
// and defeat the very thing this test checks. `vite preview` serves `dist/`
// exactly like a real deployment, so DEV is false there just as it is in
// production.
//
// Run with: npm run test:fo-diagnostic

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4177;
const BASE_URL = `http://localhost:${PORT}`;
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

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

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

async function assertNoDiagnosticStrings(page, screenLabel) {
  const bodyText = await page.evaluate(() => document.body.innerText);
  for (const needle of DIAGNOSTIC_STRINGS) {
    check(!bodyText.includes(needle), `${screenLabel}: does not contain "${needle}"`);
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
  throw new Error("Dev server did not become ready in time");
}

async function main() {
  console.log("Building production bundle...");
  await new Promise((resolve, reject) => {
    const build = spawn("npm", ["run", "build"], { cwd: process.cwd(), stdio: "inherit" });
    build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build failed with code ${code}`))));
  });

  console.log("Serving production build via `vite preview`...");
  const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
  let serverOutput = "";
  server.stdout.on("data", (d) => (serverOutput += d.toString()));
  server.stderr.on("data", (d) => (serverOutput += d.toString()));

  try {
    await waitForServer();

    const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (err) => console.error("  [page error]", err.message));

    // --- Seed a demo city as Manager, then switch to the Field Officer demo
    // identity, exactly as a real user would through the UI. ---
    console.log("\nSigning in as demo Manager and loading demo city...");
    await page.goto(`${BASE_URL}/login`);
    await page.click("text=Continue as Manager");
    await page.waitForSelector("text=Load Demo City", { timeout: 15000 });
    await page.click("text=Load Demo City");
    await page.waitForURL(/\/(today)?$/, { timeout: 15000 }).catch(() => {});
    await sleep(1000); // let the store finish loading demo data

    console.log("Switching to demo Field Officer identity...");
    await page.evaluate(() => {
      localStorage.removeItem("city-ops-auth");
      window.dispatchEvent(new CustomEvent("city-ops-auth-change"));
    });
    await page.goto(`${BASE_URL}/login`);
    await page.click("text=Continue as Field Officer");
    await page.waitForURL(/\/fo/, { timeout: 15000 });
    await page.waitForSelector("text=Today", { timeout: 15000 });
    await sleep(500);

    console.log("\n[1] FO Today's Plan (default landing screen) — diagnostic panel must be absent:");
    await assertNoDiagnosticStrings(page, "Today's Plan");

    console.log("\n[2] Other FO tabs must also be free of diagnostic output:");
    for (const [tab, label] of [
      ["Sessions", "Sessions tab"],
      ["Issues", "Issues tab"],
      ["Profile", "Profile tab"],
    ]) {
      await page.click(`nav >> text=${tab}`);
      await sleep(300);
      await assertNoDiagnosticStrings(page, label);
    }

    console.log("\n[3] Underlying diagnostic logic must still be reachable via the ?diag=1 opt-in:");
    await page.goto(`${BASE_URL}/fo?diag=1`);
    await page.waitForSelector("text=Today", { timeout: 15000 });
    await sleep(500);
    const diagBodyText = await page.evaluate(() => document.body.innerText);
    check(diagBodyText.includes("CITY OPS DIAGNOSTIC"), "?diag=1: CITY OPS DIAGNOSTIC panel IS shown (opt-in honored)");

    console.log("\n[4] Opt-in persists via localStorage; opting back out (?diag=0) hides it again:");
    await page.goto(`${BASE_URL}/fo?diag=0`);
    await page.waitForSelector("text=Today", { timeout: 15000 });
    await sleep(500);
    await assertNoDiagnosticStrings(page, "Today's Plan after ?diag=0");

    await browser.close();
  } finally {
    server.kill();
    if (failures > 0) console.error("\n--- dev server output (for debugging) ---\n" + serverOutput.slice(-4000));
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
