// Regression test for: src/data/outbox.ts's describeError() leaking raw
// Firebase/Firestore SDK error text into the Manager/FO-facing "Sync
// error" banner for any error code other than "permission-denied" or
// "unavailable".
//
// FOUND during platform audit (Rule 7 / Phase 13: "No Firebase errors
// shown to FOs... No developer diagnostic data in production UI"):
// describeError()'s fallback was `err instanceof Error ? err.message :
// "Sync failed."` — so a Firestore error with any other code (e.g.
// "unauthenticated", "deadline-exceeded", "resource-exhausted", or
// "failed-precondition", which can embed a project-specific Firebase
// console URL) rendered its raw SDK message directly in the FO's own
// sync-error banner (FOExecution.tsx's SyncStatusBanner reads
// useSyncStatus().errorMessage verbatim).
//
// Fix: describeError() now maps every documented code it can to a safe,
// human message, and falls back to a fixed generic string for any other
// CODED Firestore error — never echoing err.message when the error is
// Firestore-shaped. The raw code/message are still logged to the console
// (existing [CITY-OPS-DIAG] lines in firebaseBackend.ts / drainOutbox),
// so no debugging capability was lost — only the rendered banner changed.
//
// This test drives the REAL app (real FO login, real SyncStatusBanner,
// real drainOutbox/describeError) via Playwright against a production
// build, using the window.__CITY_OPS_TEST_BACKEND__ seam (the same one
// used by this repo's other cross-device/sync tests) to make a real write
// reject with attacker-style Firestore error objects.
//
// Run with: npm run test:sync-error-fo-safe-wording

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4192;
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

// A test backend whose putDoc() can be told to reject the NEXT write with
// an arbitrary Firestore-shaped error ({ code, message }), then succeed
// normally afterward — real drainOutbox() code runs against this, exactly
// as it would against the real Firestore SDK's own thrown errors.
async function wireFailingBackend(page) {
  await page.addInitScript(() => {
    window.__CITY_OPS_TEST_NEXT_ERROR__ = null;
    window.__CITY_OPS_TEST_BACKEND__ = {
      async putDoc() {
        const pending = window.__CITY_OPS_TEST_NEXT_ERROR__;
        if (pending) {
          window.__CITY_OPS_TEST_NEXT_ERROR__ = null;
          const err = new Error(pending.message);
          err.code = pending.code;
          throw err;
        }
      },
      async deleteDoc() {},
      subscribeCollection() {
        return () => {};
      },
    };
  });
}

async function seedManagerScenario(page) {
  await page.evaluate(() => {
    const now = new Date().toISOString();
    const business = { id: "biz_err", name: "Sync Error Test Biz", category: "General", area: "Area", address: "", capacityHoursPerDay: 3, active: true, createdAt: now };
    const cityData = {
      version: 2,
      settings: { cityName: "Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
      businesses: [business],
      fos: [],
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
    localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-manager", email: "manager@demo.city-ops", role: "MANAGER", displayName: "Demo Manager", createdAt: now }));
  });
}

// Drives the REAL Business 360 "Edit" form to perform a genuine
// updateBusiness() mutation — the same path any real Manager edit takes —
// so it flows through the actual outbox/drainOutbox()/describeError() code,
// not a synthetic store call.
async function triggerWriteWithError(page, code, rawMessage) {
  await page.evaluate(({ code, rawMessage }) => {
    window.__CITY_OPS_TEST_NEXT_ERROR__ = { code, message: rawMessage };
  }, { code, rawMessage });
  await page.getByRole("button", { name: "Edit" }).click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ timeout: 15000 });
  const nameInput = dialog.locator("#biz-name");
  await nameInput.fill("Sync Error Test Biz " + Date.now());
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await sleep(600);
}

// The Manager surfaces sync errors in the Sidebar's "System Status"
// dialog (src/components/SystemStatusDialog.tsx) — its error-message div
// renders whenever useSyncStatus() reports status "error", independent of
// whether a real Firebase project is configured (the __CITY_OPS_TEST_BACKEND__
// seam alone is enough to make useSyncStatus() report real errors).
async function readSystemStatusErrorText(page) {
  await page.getByRole("button", { name: "System Status" }).click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ timeout: 15000 });
  const text = await dialog.innerText();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden", timeout: 15000 });
  return text;
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

    await wireFailingBackend(page);
    await page.goto(`${BASE_URL}/login`);
    await seedManagerScenario(page);
    await page.goto(`${BASE_URL}/businesses`);
    await page.waitForSelector('a[href^="/businesses/"]', { timeout: 15000 });
    await page.click('a[href^="/businesses/"]');
    await page.waitForSelector('button:has-text("Edit")', { timeout: 15000 });

    console.log("\n[1] A previously-unmapped Firestore error code never leaks its raw message:");
    const DANGEROUS_RAW_MESSAGE =
      "9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/project/internal-city-ops-prod/firestore/indexes?create_composite=SUPER_SECRET_INTERNAL_TOKEN";
    await triggerWriteWithError(page, "failed-precondition", DANGEROUS_RAW_MESSAGE);
    const textAfterFailedPrecondition = await readSystemStatusErrorText(page);
    check(!textAfterFailedPrecondition.includes("console.firebase.google.com"), "the System Status dialog never contains the raw Firebase console URL from the SDK error");
    check(!textAfterFailedPrecondition.includes("SUPER_SECRET_INTERNAL_TOKEN"), "the System Status dialog never contains the raw internal token embedded in the SDK error message");
    check(!textAfterFailedPrecondition.includes("FAILED_PRECONDITION"), "the System Status dialog never contains the raw Firestore error code text");
    check(textAfterFailedPrecondition.includes("Sync failed"), "a safe generic fallback message is still shown for the unmapped code (the error is surfaced, just not verbatim)");

    console.log("\n[2] 'unauthenticated' gets a safe, specific message instead of the raw SDK text:");
    await triggerWriteWithError(page, "unauthenticated", "16 UNAUTHENTICATED: Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.");
    const textAfterUnauthenticated = await readSystemStatusErrorText(page);
    check(textAfterUnauthenticated.includes("Your session has expired"), "the FO/Manager-safe 'session expired' wording is shown for 'unauthenticated'");
    check(!textAfterUnauthenticated.includes("OAuth 2 access token"), "the raw SDK credential-related text never renders");

    console.log("\n[3] 'deadline-exceeded' and 'resource-exhausted' get safe, specific messages:");
    await triggerWriteWithError(page, "deadline-exceeded", "4 DEADLINE_EXCEEDED: Deadline exceeded after 60.0s");
    check((await readSystemStatusErrorText(page)).includes("timed out"), "'deadline-exceeded' renders a safe 'timed out' message");
    await triggerWriteWithError(page, "resource-exhausted", "8 RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Write requests' and limit 'WritesPerMinutePerProject'");
    const textAfterResourceExhausted = await readSystemStatusErrorText(page);
    check(textAfterResourceExhausted.includes("Too many requests"), "'resource-exhausted' renders a safe 'too many requests' message");
    check(!textAfterResourceExhausted.includes("WritesPerMinutePerProject"), "the raw quota-metric name never renders");

    console.log("\n[4] Existing 'permission-denied' / 'unavailable' wording is unchanged (no regression):");
    await triggerWriteWithError(page, "permission-denied", "7 PERMISSION_DENIED: Missing or insufficient permissions.");
    check((await readSystemStatusErrorText(page)).includes("Permission denied"), "'permission-denied' still renders the pre-existing exact wording");
    await triggerWriteWithError(page, "unavailable", "14 UNAVAILABLE: The service is currently unavailable.");
    check((await readSystemStatusErrorText(page)).includes("temporarily unavailable"), "'unavailable' still renders the pre-existing exact wording");

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
