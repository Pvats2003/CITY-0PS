// Regression test for the second deep audit pass's Section 10 ("Resolve
// button concurrency"): rapid double-click on BusinessDataQuality.tsx's
// "Resolve with Google" button (GoogleResolveBlock's handleResolve()).
//
// handleResolve() is: onStateChange({loading:true}) -> await resolver.
// resolveBusinessLocation(...) -> onStateChange({loading:false, result}).
// The button itself only renders when `state` is falsy (see
// GoogleResolveBlock's `if (!state) return <Button .../>`), and the FIRST
// line of handleResolve() synchronously sets `state` to a truthy value
// BEFORE the resolver call ever awaits anything — so by the time any
// `await` yields control back to the event loop, React already has a
// state update queued that will replace the button with a loading
// indicator on the very next render. This test proves whether a real,
// physical double-click (two native click events dispatched back-to-back,
// via Playwright's dblclick()) can still slip a second resolveBusinessLocation()
// call through that window against a resolver whose response is
// deliberately delayed (400ms) to give any real race the widest possible
// opportunity to manifest.
//
// Never calls Google or a real Firebase Function — uses the same
// window.__CITY_OPS_TEST_LOCATION_RESOLVER__ seam as
// tests/f53-location-resolver.regression.mjs.
//
// Run with: npm run test:f53-resolve-google-double-click

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import ExcelJS from "exceljs";

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
  }).then(
    () =>
      new Promise((resolve) => {
        const fuser = spawn("fuser", ["-k", `${PORT}/tcp`]);
        fuser.on("exit", () => resolve());
        fuser.on("error", () => resolve());
        setTimeout(resolve, 2000);
      }),
  );
}

const HEADERS = [
  "Business Code", "Business Name", "Contact Phone", "Data Captain", "City", "Category",
  "Suggested Category", "Address", "Maps Link", "Latitude", "Longitude", "Contact Name",
  "Workers Declared", "Workers Photographed", "Hard Tasks", "Outcome", "Status", "Risk Score",
  "Submitted At", "DC Code",
];

async function buildSyntheticXlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(HEADERS);
  for (const r of rows) ws.addRow(HEADERS.map((h) => r[h] ?? ""));
  return wb.xlsx.writeBuffer();
}

function emptyCityData(overrides = {}) {
  return {
    version: 2,
    settings: { cityName: "Double-Click Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
    businesses: [], fos: [], collectors: [], rigs: [], assignments: [], sessions: [], evidence: [], issues: [],
    qualityReviews: [], correctiveActions: [], rigIncidents: [], repairRecords: [], activity: [], plans: [], reports: [],
    ...overrides,
  };
}

const RESOLVER_DELAY_MS = 400;

async function installDelayedFakeResolver(page) {
  await page.addInitScript(
    ({ delayMs }) => {
      window.__CITY_OPS_TEST_LOCATION_CALLS__ = [];
      window.__CITY_OPS_TEST_LOCATION_RESOLVER__ = {
        async resolveBusinessLocation(input) {
          window.__CITY_OPS_TEST_LOCATION_CALLS__.push(input);
          await new Promise((r) => setTimeout(r, delayMs));
          return {
            status: "READY_FOR_REVIEW",
            candidate: {
              source: "google_geocoding",
              requestedQuery: `${input.businessName}, Rajampet, India`,
              lat: 14.222222,
              lng: 79.333333,
              formattedAddress: "Main Road, Rajampet, Andhra Pradesh 516115, India",
              placeId: "fake_place_id_dblclick",
              resultType: "establishment",
              apiStatus: "OK",
              requestedAt: new Date().toISOString(),
            },
          };
        },
      };
    },
    { delayMs: RESOLVER_DELAY_MS },
  );
}

async function seedManager(page, cityData) {
  await page.goto(`${BASE_URL}/login`);
  await page.evaluate(
    ({ cityData }) => {
      const now = new Date().toISOString();
      localStorage.setItem("city-ops-os", JSON.stringify({ state: cityData, version: 2 }));
      localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-manager", email: "manager@demo.city-ops", role: "MANAGER", displayName: "Demo Manager", createdAt: now }));
    },
    { cityData },
  );
}

async function getResolverCalls(page) {
  return page.evaluate(() => window.__CITY_OPS_TEST_LOCATION_CALLS__ ?? []);
}

async function main() {
  console.log("\nBuilding production bundle...");
  await new Promise((resolve, reject) => {
    const build = spawn("npm", ["run", "build"], { cwd: process.cwd(), stdio: "inherit" });
    build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build failed with code ${code}`))));
  });

  console.log("Serving production build via `vite preview`...");
  const vite = spawn(VITE_BIN, ["preview", "--port", String(PORT), "--strictPort"], { stdio: "pipe" });
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });

  try {
    await waitForServer();

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error("  [pageerror]", e.message));
    await installDelayedFakeResolver(page);
    await seedManager(page, emptyCityData());

    await page.goto(`${BASE_URL}/settings?tab=data`);
    await page.waitForSelector('[data-testid="biz-import-button"]');
    const xlsx = await buildSyntheticXlsx([{ "Business Code": "F53-DBL", "Business Name": "Double Click Biz", Category: "Automotive Services" }]);
    await page.setInputFiles('[data-testid="biz-import-file-input"]', {
      name: "dblclick.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from(xlsx),
    });
    await page.waitForSelector('[data-testid="biz-import-count-total"]');
    await page.locator('[data-testid="biz-import-tab-quality"]').click();
    await page.waitForSelector('[data-testid="biz-dq-panel"]');

    const row = page.locator('[data-testid="biz-dq-location-row"]');
    check((await row.count()) === 1, "the missing-location row for the synthetic business is present");
    const resolveButton = row.locator('[data-testid="biz-dq-location-resolve-google"]');
    check((await resolveButton.count()) === 1, "a 'Resolve with Google' button is offered");

    console.log(`\n[double-click] Rapidly double-clicking 'Resolve with Google' (resolver delayed ${RESOLVER_DELAY_MS}ms to maximize any real race window):`);
    // Playwright's dblclick() dispatches two genuine, back-to-back native
    // click events on the SAME element reference — the closest thing to a
    // real fast double-click a script can produce, and a strictly tighter
    // window than two separate .click() calls with any code in between.
    await resolveButton.dblclick({ force: true }).catch(() => {
      // If the element is already gone by the second click (because the
      // FIRST click's synchronous state update already unmounted the
      // button), Playwright's dblclick() throws instead of silently
      // no-op'ing the second click — that outcome is itself the answer
      // (the race is not reproducible), not a test infrastructure failure.
    });

    await sleep(RESOLVER_DELAY_MS + 500);
    const calls = await getResolverCalls(page);
    if (calls.length === 1) {
      check(true, "[UNCONFIRMED -> closed] exactly ONE resolveBusinessLocation() call resulted from the double-click — React's synchronous state update (button -> loading indicator) closed the race before a second native click could reach the resolver");
    } else {
      check(calls.length === 1, `[CONFIRMED] the double-click produced ${calls.length} resolveBusinessLocation() calls instead of 1 — a real, reproducible duplicate-request race`);
    }

    // Whichever happened, the end state must still be exactly one visible
    // candidate — never two stacked cards, never a broken render.
    await page.waitForSelector('[data-testid="biz-dq-location-google-candidate"]');
    const candidateCount = await row.locator('[data-testid="biz-dq-location-google-candidate"]').count();
    check(candidateCount === 1, `exactly one candidate card is rendered regardless of call count (got ${candidateCount})`);

    await ctx.close();

    console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
  } finally {
    await browser.close();
    await killAndWait(vite);
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
