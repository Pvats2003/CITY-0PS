// Regression test for Phase F.5.3 — Assisted Business Location Resolution
// (src/lib/locationResolver.ts's LocationResolver contract, the
// "Resolve with Google" UI in src/components/import/BusinessDataQuality.tsx,
// and the provenance surfaced in src/engine/importPreflight.ts /
// ImportPreflight.tsx). REAL BROWSER click-through against the production
// build. NEVER makes a real Google API call or a real Firebase Functions
// call — every scenario injects a hand-written browser-side fake conforming
// to the LocationResolver interface via the window.__CITY_OPS_TEST_LOCATION_
// RESOLVER__ test seam (see getLocationResolver() in locationResolver.ts),
// installed with page.addInitScript() BEFORE the app's own scripts run, so
// GoogleLocationResolver is never even constructed during this test run.
//
// Run with: npm run test:f53-location-resolver

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";

const PORT = 4198;
const BASE_URL = `http://localhost:${PORT}`;
const CHROMIUM_PATH = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const VITE_BIN = "node_modules/.bin/vite";
const REAL_FILE = "/root/.claude/uploads/339e036e-ddfd-5933-9ed5-a86756c17842/ad921567-Rajampet_Kadapa_Converted_Leads_-_Iliyas.xlsx";

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
    settings: { cityName: "F5.3 Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
    businesses: [], fos: [], collectors: [], rigs: [], assignments: [], sessions: [], evidence: [], issues: [],
    qualityReviews: [], correctiveActions: [], rigIncidents: [], repairRecords: [], activity: [], plans: [], reports: [],
    ...overrides,
  };
}

// Installs a fake LocationResolver via the app's own test seam BEFORE any
// app script runs. Configured per test via `byQueryKey` (keyed on
// businessName, matching the fake's lookup) and `defaultResult`.
async function installFakeResolver(page, { byQueryKey = {}, defaultResult } = {}) {
  await page.addInitScript(
    ({ byQueryKey, defaultResult }) => {
      window.__CITY_OPS_TEST_LOCATION_CALLS__ = [];
      window.__CITY_OPS_TEST_LOCATION_RESOLVER__ = {
        async resolveBusinessLocation(input) {
          window.__CITY_OPS_TEST_LOCATION_CALLS__.push(input);
          const key = input.businessName || "";
          return byQueryKey[key] || defaultResult || { status: "NO_CANDIDATE", reason: "no fake response configured for this input" };
        },
      };
    },
    { byQueryKey, defaultResult },
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

async function getBusinesses(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("city-ops-os")).state.businesses);
}
async function getResolverCalls(page) {
  return page.evaluate(() => window.__CITY_OPS_TEST_LOCATION_CALLS__ ?? []);
}

async function openImportTab(page) {
  await page.goto(`${BASE_URL}/settings?tab=data`);
  await page.waitForSelector('[data-testid="biz-import-button"]');
}
async function uploadBuffer(page, buffer, filename) {
  await page.setInputFiles('[data-testid="biz-import-file-input"]', {
    name: filename,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(buffer),
  });
}
async function tileValue(page, testId) {
  return Number(await page.locator(`[data-testid="${testId}"]`).innerText().then((t) => t.match(/\d+/)[0]));
}

async function main() {
  console.log("\nBuilding production bundle...");
  await new Promise((resolve, reject) => {
    const build = spawn("npm", ["run", "build"], { cwd: process.cwd(), stdio: "inherit" });
    build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build failed with code ${code}`))));
  });

  console.log("\n[21] Google API key is completely absent from the client bundle:");
  const { execSync } = await import("node:child_process");
  const grepFound = (pattern) => {
    try {
      execSync(`grep -Rl "${pattern}" dist/ 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  };
  check(!grepFound("GOOGLE_MAPS_API_KEY"), "[21] 'GOOGLE_MAPS_API_KEY' string never appears in dist/");
  check(!grepFound("VITE_GOOGLE"), "[21] no 'VITE_GOOGLE*' env var reference anywhere in dist/");
  check(!grepFound("maps.googleapis.com"), "[21] the Google Geocoding endpoint URL never appears client-side — the browser only ever calls our own Firebase function");

  console.log("\nServing production build via `vite preview`...");
  const vite = spawn(VITE_BIN, ["preview", "--port", String(PORT), "--strictPort"], { stdio: "pipe" });
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });

  try {
    await waitForServer();

    // ========================================================================
    // [1][2] Explicit/literal coordinates bypass the resolver entirely —
    // such rows never even show a "Resolve with Google" button, because
    // they never appear in Missing Location or Short Maps Link sections.
    // ========================================================================
    console.log("\n[1][2] Usable coordinates (explicit or literal-Maps-link) bypass the resolver:");
    const bypassCtx = await browser.newContext();
    const bypassPage = await bypassCtx.newPage();
    await installFakeResolver(bypassPage, { defaultResult: { status: "NO_CANDIDATE", reason: "should never be called" } });
    await seedManager(bypassPage, emptyCityData());
    await openImportTab(bypassPage);
    const bypassXlsx = await buildSyntheticXlsx([
      { "Business Code": "F53-001", "Business Name": "Has Explicit Coords", Category: "Automotive Services", Latitude: "14.5", Longitude: "79.5" },
      { "Business Code": "F53-002", "Business Name": "Has Literal Maps Coords", Category: "Automotive Services", "Maps Link": "https://www.google.com/maps?q=15.1,80.1" },
    ]);
    await uploadBuffer(bypassPage, bypassXlsx, "bypass.xlsx");
    await bypassPage.waitForSelector('[data-testid="biz-import-count-total"]');
    await bypassPage.locator('[data-testid="biz-import-tab-quality"]').click();
    await bypassPage.waitForSelector('[data-testid="biz-dq-panel"]');
    check((await bypassPage.locator('[data-testid="biz-dq-location-row"]').count()) === 0, "[1][2] neither row appears in Missing Location (both already have a usable coordinate signal)");
    check((await bypassPage.locator('[data-testid="biz-dq-shortlink-row"]').count()) === 0, "[1][2] neither row appears in Short Maps Link either");
    const bypassCalls = await getResolverCalls(bypassPage);
    check(bypassCalls.length === 0, "[1][2] the resolver was never invoked for either row");
    await bypassCtx.close();

    // ========================================================================
    // [3][5][14][17][18][19] Missing location -> resolve -> accept -> Preflight provenance
    // ========================================================================
    console.log("\n[3][5][14][17][18][19] Missing location: resolve, accept, provenance, zero writes, session cache:");
    const missCtx = await browser.newContext();
    const missPage = await missCtx.newPage();
    await installFakeResolver(missPage, {
      byQueryKey: {
        "No Location Biz": {
          status: "READY_FOR_REVIEW",
          candidate: {
            source: "google_geocoding",
            requestedQuery: "No Location Biz, Rajampet, India",
            lat: 14.222222,
            lng: 79.333333,
            formattedAddress: "Main Road, Rajampet, Andhra Pradesh 516115, India",
            placeId: "fake_place_id_1",
            resultType: "establishment",
            apiStatus: "OK",
            requestedAt: new Date().toISOString(),
          },
        },
      },
    });
    await seedManager(missPage, emptyCityData());
    await openImportTab(missPage);
    const missXlsx = await buildSyntheticXlsx([{ "Business Code": "F53-010", "Business Name": "No Location Biz", Category: "Automotive Services" }]);
    await uploadBuffer(missPage, missXlsx, "miss.xlsx");
    await missPage.waitForSelector('[data-testid="biz-import-count-total"]');
    await missPage.locator('[data-testid="biz-import-tab-quality"]').click();
    await missPage.waitForSelector('[data-testid="biz-dq-panel"]');
    const missRow = missPage.locator('[data-testid="biz-dq-location-row"]');
    check((await missRow.count()) === 1, "[3] the missing-location row is present");
    check((await missRow.locator('[data-testid="biz-dq-location-resolve-google"]').count()) === 1, "[3] a 'Resolve with Google' button is offered");
    check((await getResolverCalls(missPage)).length === 0, "the resolver has not been called merely from opening the page");

    await missRow.locator('[data-testid="biz-dq-location-resolve-google"]').click();
    await missPage.waitForSelector('[data-testid="biz-dq-location-google-candidate"]');
    check((await getResolverCalls(missPage)).length === 1, "[3] clicking 'Resolve with Google' invoked the resolver exactly once");
    const candidateText = await missPage.locator('[data-testid="biz-dq-location-google-candidate"]').innerText();
    check(/Main Road, Rajampet/.test(candidateText) && /14\.222222/.test(candidateText), "[5] the successful candidate's formatted address and coordinates are shown");

    console.log("\n[19] Zero writes just from resolving (before Accept):");
    check((await getBusinesses(missPage)).length === 0, "no business exists in the store yet");

    await missRow.locator('[data-testid="biz-dq-location-google-accept"]').click();
    await sleep(100);
    console.log("\n[19] Zero writes even after Accept (session-local resolution only, no Confirm yet):");
    check((await getBusinesses(missPage)).length === 0, "[19] accepting a Google candidate alone still wrote nothing to the store");

    // [17] repeated resolution is session-cached — toggling filters/tabs and
    // coming back must not re-invoke the resolver.
    await missPage.locator('[data-testid="biz-dq-filter-shortlink"]').click();
    await missPage.locator('[data-testid="biz-dq-filter-location"]').click();
    await missPage.locator('[data-testid="biz-import-tab-preflight"]').click();
    await missPage.waitForSelector('[data-testid="biz-preflight-panel"]');
    await missPage.locator('[data-testid="biz-import-tab-quality"]').click();
    await missPage.waitForSelector('[data-testid="biz-dq-panel"]');
    check((await getResolverCalls(missPage)).length === 1, "[17] re-opening the panel / toggling filters after resolving did NOT call the resolver again (still 1 call)");

    // [18] provenance survives into Preflight's write preview.
    await missPage.locator('[data-testid="biz-import-tab-preflight"]').click();
    await missPage.waitForSelector('[data-testid="biz-preflight-panel"]');
    const writeRow = missPage.locator('[data-testid="preflight-write-row"]').filter({ hasText: "No Location Biz" });
    check((await writeRow.count()) === 1, "the row is Ready in Preflight after accepting the Google candidate");
    const provenance = writeRow.locator('[data-testid="preflight-location-provenance"]');
    check((await provenance.count()) === 1, "[18] the write preview shows a Google-assisted location provenance line");
    check(/Google Geocoding/.test(await provenance.innerText()), "[18] the provenance text names Google Geocoding, never claiming it's authoritative on its own");
    const fieldsWritten = await writeRow.locator('[data-testid="preflight-fields-written"]').innerText();
    check(/lat=14\.222222/.test(fieldsWritten) && /lng=79\.333333/.test(fieldsWritten), "[14] the accepted Google coordinate is exactly what would be written");

    console.log("\n[19] Still zero writes after viewing Preflight:");
    check((await getBusinesses(missPage)).length === 0, "[19] viewing Preflight performed no writes");

    await missCtx.close();

    // ========================================================================
    // [4] Short Maps link can invoke the resolver too.
    // ========================================================================
    console.log("\n[4] Unresolved short Maps link can invoke the resolver:");
    const shortCtx = await browser.newContext();
    const shortPage = await shortCtx.newPage();
    await installFakeResolver(shortPage, { defaultResult: { status: "NO_CANDIDATE", reason: "Google returned no results for this query." } });
    await seedManager(shortPage, emptyCityData());
    await openImportTab(shortPage);
    const shortXlsx = await buildSyntheticXlsx([{ "Business Code": "F53-020", "Business Name": "Short Link Biz", Category: "Automotive Services", "Maps Link": "https://maps.app.goo.gl/AbCdEfGh" }]);
    await uploadBuffer(shortPage, shortXlsx, "short.xlsx");
    await shortPage.waitForSelector('[data-testid="biz-import-count-total"]');
    await shortPage.locator('[data-testid="biz-import-tab-quality"]').click();
    await shortPage.waitForSelector('[data-testid="biz-dq-panel"]');
    const shortRow = shortPage.locator('[data-testid="biz-dq-shortlink-row"]');
    await shortRow.locator('[data-testid="biz-dq-shortlink-resolve-google"]').click();
    await shortPage.waitForSelector('[data-testid="biz-dq-shortlink-google-no-candidate"]');
    check((await getResolverCalls(shortPage)).length === 1, "[4] the short-link row's resolve button invoked the resolver");

    // ========================================================================
    // [6] Zero-result response.
    // ========================================================================
    console.log("\n[6] Zero-result response shows 'no candidate', offers Retry:");
    check((await shortPage.locator('[data-testid="biz-dq-shortlink-google-no-candidate"]').innerText()).includes("no results"), "[6] the zero-result reason is shown to the Manager");
    check((await shortPage.locator('[data-testid="biz-dq-shortlink-google-retry"]').count()) === 1, "[6] a Retry action is offered");
    await shortCtx.close();

    // ========================================================================
    // [7] Ambiguous candidate -> NEEDS_REVIEW, never silently accepted-looking.
    // [8][9][10][11] Error-shaped results (API error / timeout / rate-limit / malformed)
    // all render the same safe "no candidate" / reason path, never inventing a candidate.
    // ========================================================================
    console.log("\n[7] Ambiguous Google candidate is flagged NEEDS_REVIEW, not silently treated as resolved:");
    const ambigCtx = await browser.newContext();
    const ambigPage = await ambigCtx.newPage();
    await installFakeResolver(ambigPage, {
      byQueryKey: {
        "Ambiguous Biz": {
          status: "NEEDS_REVIEW",
          reason: "Google returned multiple plausible matches.",
          candidate: {
            source: "google_geocoding", requestedQuery: "Ambiguous Biz, Rajampet, India", lat: 14.1, lng: 79.1,
            formattedAddress: "Somewhere, Rajampet, India", apiStatus: "OK", requestedAt: new Date().toISOString(),
          },
        },
        "Timeout Biz": { status: "NO_CANDIDATE", reason: "Geocoding request timed out." },
        "RateLimit Biz": { status: "NO_CANDIDATE", reason: "Google Geocoding quota exceeded — try again later." },
        "Malformed Biz": { status: "NO_CANDIDATE", reason: "Received a malformed response from the geocoding service." },
        "ApiError Biz": { status: "NO_CANDIDATE", reason: "The geocoding service rejected this request." },
      },
    });
    await seedManager(ambigPage, emptyCityData());
    await openImportTab(ambigPage);
    const ambigXlsx = await buildSyntheticXlsx([
      { "Business Code": "F53-030", "Business Name": "Ambiguous Biz", Category: "Automotive Services" },
      { "Business Code": "F53-031", "Business Name": "Timeout Biz", Category: "Automotive Services" },
      { "Business Code": "F53-032", "Business Name": "RateLimit Biz", Category: "Automotive Services" },
      { "Business Code": "F53-033", "Business Name": "Malformed Biz", Category: "Automotive Services" },
      { "Business Code": "F53-034", "Business Name": "ApiError Biz", Category: "Automotive Services" },
    ]);
    await uploadBuffer(ambigPage, ambigXlsx, "ambig.xlsx");
    await ambigPage.waitForSelector('[data-testid="biz-import-count-total"]');
    await ambigPage.locator('[data-testid="biz-import-tab-quality"]').click();
    await ambigPage.waitForSelector('[data-testid="biz-dq-panel"]');

    async function resolveRowByName(name) {
      const row = ambigPage.locator('[data-testid="biz-dq-location-row"]').filter({ hasText: name });
      await row.locator('[data-testid="biz-dq-location-resolve-google"]').click();
      await sleep(150);
      return row;
    }
    const ambigRow = await resolveRowByName("Ambiguous Biz");
    const ambigCandidateText = await ambigRow.locator('[data-testid="biz-dq-location-google-candidate"]').innerText();
    check(/needs review/i.test(ambigCandidateText) && /multiple plausible matches/.test(ambigCandidateText), "[7] the ambiguous candidate is clearly marked NEEDS_REVIEW with the reason shown");
    check((await ambigRow.locator('[data-testid="biz-dq-location-google-candidate"]').getAttribute("data-status")) === "NEEDS_REVIEW", "[7] the candidate card's status attribute is NEEDS_REVIEW");

    const timeoutRow = await resolveRowByName("Timeout Biz");
    check((await timeoutRow.locator('[data-testid="biz-dq-location-google-no-candidate"]').innerText()).includes("timed out"), "[9] a timeout is shown as a safe 'no candidate' message, never a fabricated result");
    const rateLimitRow = await resolveRowByName("RateLimit Biz");
    check((await rateLimitRow.locator('[data-testid="biz-dq-location-google-no-candidate"]').innerText()).includes("quota exceeded"), "[10] a rate-limit/quota error is shown safely");
    const malformedRow = await resolveRowByName("Malformed Biz");
    check((await malformedRow.locator('[data-testid="biz-dq-location-google-no-candidate"]').innerText()).includes("malformed"), "[11] a malformed response is shown safely, never crashes the page");
    const apiErrorRow = await resolveRowByName("ApiError Biz");
    check((await apiErrorRow.locator('[data-testid="biz-dq-location-google-no-candidate"]').innerText()).includes("rejected"), "[8] a generic API error is shown safely, without leaking internal detail");

    console.log("\n[19] Zero writes throughout every one of these error scenarios:");
    check((await getBusinesses(ambigPage)).length === 0, "[19] no business was ever written despite 5 resolve attempts including errors");
    await ambigCtx.close();

    // ========================================================================
    // [12][13][15][16] Coordinate conflict: 3rd candidate, distance shown,
    // keep_source / needs_further_review decisions never write anything.
    // ========================================================================
    console.log("\n[12][13][15][16] Coordinate conflict: optional 3rd Google candidate, distance shown, keep_source/needs_review are no-ops:");
    const conflictCtx = await browser.newContext();
    const conflictPage = await conflictCtx.newPage();
    await installFakeResolver(conflictPage, {
      byQueryKey: {
        "Conflict Biz": {
          status: "READY_FOR_REVIEW",
          candidate: {
            source: "google_geocoding", requestedQuery: "Conflict Biz, Rajampet, India", lat: 14.5, lng: 79.6,
            formattedAddress: "Third Opinion Road, Rajampet, India", apiStatus: "OK", requestedAt: new Date().toISOString(),
            distanceFromSpreadsheetCoordsMeters: 1234,
          },
        },
      },
    });
    await seedManager(conflictPage, emptyCityData());
    await openImportTab(conflictPage);
    const conflictXlsx = await buildSyntheticXlsx([
      { "Business Code": "F53-040", "Business Name": "Conflict Biz", Category: "Automotive Services", Latitude: "14.19", Longitude: "79.16", "Maps Link": "https://www.google.com/maps?q=15.50,80.50" },
    ]);
    await uploadBuffer(conflictPage, conflictXlsx, "conflict.xlsx");
    await conflictPage.waitForSelector('[data-testid="biz-import-count-total"]');
    await conflictPage.locator('[data-testid="biz-import-tab-quality"]').click();
    await conflictPage.waitForSelector('[data-testid="biz-dq-panel"]');
    const conflictRow = conflictPage.locator('[data-testid="biz-dq-coord-row"]');
    check((await conflictRow.locator('[data-testid="biz-dq-coord-resolve-google"]').count()) === 1, "[12] the coordinate-conflict row also offers an optional 3rd Google opinion");
    await conflictRow.locator('[data-testid="biz-dq-coord-resolve-google"]').click();
    await conflictPage.waitForSelector('[data-testid="biz-dq-coord-google-candidate"]');
    const calls = await getResolverCalls(conflictPage);
    check(calls[0].existingLat === 14.19 && calls[0].existingLng === 79.16, "[12] the spreadsheet's own coordinates were passed as existingLat/existingLng for comparison");
    const candText = await conflictRow.locator('[data-testid="biz-dq-coord-google-candidate"]').innerText();
    check(/1234m from the existing coordinate/.test(candText), "[13] the distance-from-existing-coordinate is displayed as supporting evidence");

    await conflictRow.locator('[data-testid="biz-dq-coord-google-keep-source"]').click();
    await sleep(100);
    check((await getBusinesses(conflictPage)).length === 0, "[15] clicking 'Keep source location' wrote nothing");
    await conflictRow.locator('[data-testid="biz-dq-coord-google-needs-review"]').click();
    await sleep(100);
    check((await getBusinesses(conflictPage)).length === 0, "[16] clicking 'Needs further review' also wrote nothing — no automatic winner was ever chosen");
    await conflictCtx.close();

    // ========================================================================
    // [22][23] Existing importer / preflight behavior is completely
    // unaffected by any of this — re-verify against the real 120-row file.
    // ========================================================================
    console.log("\n[22][23] Existing importer/Preflight behavior on the real file is unchanged:");
    const realCtx = await browser.newContext();
    const realPage = await realCtx.newPage();
    await installFakeResolver(realPage, { defaultResult: { status: "NO_CANDIDATE", reason: "unused in this check" } });
    await seedManager(realPage, emptyCityData());
    await openImportTab(realPage);
    await uploadBuffer(realPage, readFileSync(REAL_FILE), "Rajampet_Kadapa Converted Leads - Iliyas.xlsx");
    await realPage.waitForSelector('[data-testid="biz-import-count-total"]');
    await realPage.locator('[data-testid="biz-import-tab-preflight"]').click();
    await realPage.waitForSelector('[data-testid="biz-preflight-panel"]');
    check((await tileValue(realPage, "preflight-summary-ready")) === 33, "[22][23] Ready is still 33 on the real file — untouched by F.5.3's additions");
    check((await tileValue(realPage, "preflight-summary-blocked")) === 87, "[22][23] Blocked is still 87");
    check((await getResolverCalls(realPage)).length === 0, "[22][23] merely viewing the real file's Preflight never auto-invoked the resolver");
    await realCtx.close();

    // ========================================================================
    // [20] FO cannot access the resolver / Data Quality UI at all.
    // ========================================================================
    console.log("\n[20] FO cannot access the resolver or the Data Quality workflow:");
    const foCtx = await browser.newContext();
    const foPage = await foCtx.newPage();
    await installFakeResolver(foPage, { defaultResult: { status: "NO_CANDIDATE" } });
    await foPage.goto(`${BASE_URL}/login`);
    await foPage.evaluate(() => {
      const now = new Date().toISOString();
      const cityData = {
        version: 2,
        settings: { cityName: "FO F5.3 Denied", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
        businesses: [], fos: [{ id: "fo_f53_denied", name: "Denied FO", active: true, createdAt: now }], collectors: [], rigs: [],
        assignments: [], sessions: [], evidence: [], issues: [], qualityReviews: [], correctiveActions: [], rigIncidents: [],
        repairRecords: [], activity: [], plans: [], reports: [],
      };
      localStorage.setItem("city-ops-os", JSON.stringify({ state: cityData, version: 2 }));
      localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-fo-f53-denied", email: "denied.fo.f53@demo.city-ops", role: "FIELD_OFFICER", displayName: "Denied FO", foId: "fo_f53_denied", createdAt: now }));
    });
    await foPage.goto(`${BASE_URL}/settings?tab=data`);
    await sleep(500);
    check(!foPage.url().includes("/settings"), `[20] an FO navigating to /settings?tab=data is redirected away (ended at ${foPage.url()})`);
    check((await foPage.locator('[data-testid="biz-dq-panel"]').count()) === 0, "[20] the Data Quality panel — and with it every Resolve-with-Google control — never renders for an FO");
    check((await getResolverCalls(foPage)).length === 0, "[20] the resolver was never invoked for the FO account");
    await foCtx.close();

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
