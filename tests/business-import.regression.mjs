// Regression test for Phase F — Business Lead Import
// (src/engine/businessImport.ts, src/lib/xlsxParse.ts, the "Import
// Businesses" flow in src/pages/Settings.tsx). REAL BROWSER click-through
// against the production build, using the actual uploaded lead spreadsheet
// (Rajampet_Kadapa Converted Leads - Iliyas.xlsx, 120 rows) for the primary
// scenario, plus small synthetic .xlsx fixtures (built in this file with
// exceljs) for edge cases the real file doesn't happen to contain.
//
// Run with: npm run test:business-import

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync, existsSync } from "node:fs";
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
  "Business Code",
  "Business Name",
  "Contact Phone",
  "Data Captain",
  "City",
  "Category",
  "Suggested Category",
  "Address",
  "Maps Link",
  "Latitude",
  "Longitude",
  "Contact Name",
  "Workers Declared",
  "Workers Photographed",
  "Hard Tasks",
  "Outcome",
  "Status",
  "Risk Score",
  "Submitted At",
  "DC Code",
];

/** Builds a small synthetic lead spreadsheet in memory, same header shape as
 * the real file, for scenarios the real file doesn't happen to exercise. */
async function buildSyntheticXlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(HEADERS);
  for (const r of rows) {
    ws.addRow(HEADERS.map((h) => r[h] ?? ""));
  }
  return wb.xlsx.writeBuffer();
}

function emptyCityData(overrides = {}) {
  return {
    version: 2,
    settings: { cityName: "Import Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
    businesses: [],
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
    ...overrides,
  };
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

// Mirrors src/lib/googleMaps.ts's resolveBusinessCoordinates() precedence
// (lat/lng first, then a literal-coordinate parse of googleMapsUrl) so the
// test can independently predict which businesses City Coverage will plot,
// without importing the TS module into this plain-Node test runner.
function hasResolvableCoordinate(b) {
  if (b.lat != null && b.lng != null) return true;
  if (!b.googleMapsUrl) return false;
  return /[?&]q=-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?/.test(b.googleMapsUrl) || /@-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/.test(b.googleMapsUrl);
}

async function getBusinesses(page) {
  return page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("city-ops-os"));
    return raw.state.businesses;
  });
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

async function main() {
  // ==========================================================================
  console.log("[static] Business Lead Import source never reads a spreadsheet-only operational field (comments that merely name them, to document what's deliberately NOT used, don't count):");
  const sourceFiles = ["src/engine/businessImport.ts", "src/lib/xlsxParse.ts", "src/pages/Settings.tsx"];
  const FORBIDDEN_IDENTIFIERS = ["riskScore", "workersDeclared", "workersPhotographed", "dataCaptain", "dcCode", "submittedAt", "suggestedCategory", "outcome", "hardTasks"];
  function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }
  for (const file of sourceFiles) {
    const codeOnly = stripComments(readFileSync(file, "utf8"));
    for (const identifier of FORBIDDEN_IDENTIFIERS) {
      const re = new RegExp(`\\b${identifier}\\b`);
      check(!re.test(codeOnly), `[18][13] ${file}'s actual code (comments excluded) never reads a "${identifier}" field`);
    }
  }
  check(existsSync(REAL_FILE), `[16] the real source spreadsheet is present at ${REAL_FILE}`);

  console.log("\nBuilding production bundle...");
  await new Promise((resolve, reject) => {
    const build = spawn("npm", ["run", "build"], { cwd: process.cwd(), stdio: "inherit" });
    build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build failed with code ${code}`))));
  });

  console.log("Serving production build via `vite preview`...");
  const vite = spawn(VITE_BIN, ["preview", "--port", String(PORT), "--strictPort"], { stdio: "pipe" });
  let viteOutput = "";
  vite.stdout.on("data", (d) => (viteOutput += d));
  vite.stderr.on("data", (d) => (viteOutput += d));

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });

  try {
    await waitForServer();

    // ========================================================================
    // Section 1: the real 120-row spreadsheet — preview correctness, zero
    // writes before confirm, confirm creates records, re-import idempotency.
    // ========================================================================
    const ctx1 = await browser.newContext();
    const page1 = await ctx1.newPage();
    await seedManager(page1, emptyCityData());
    await openImportTab(page1);

    console.log("\n[1][16] Real 120-row spreadsheet parses:");
    const before = await getBusinesses(page1);
    check(before.length === 0, "starting business count is 0");

    await uploadBuffer(page1, readFileSync(REAL_FILE), "Rajampet_Kadapa Converted Leads - Iliyas.xlsx");
    await page1.waitForSelector('[data-testid="biz-import-count-total"]');
    const total1 = Number(await page1.locator('[data-testid="biz-import-count-total"]').innerText());
    check(total1 === 120, `[16] rows detected === 120 (got ${total1})`);

    const ready1 = Number(await page1.locator('[data-testid="biz-import-count-ready"]').innerText());
    const update1 = Number(await page1.locator('[data-testid="biz-import-count-update"]').innerText());
    const dup1 = Number(await page1.locator('[data-testid="biz-import-count-duplicate"]').innerText());
    const review1 = Number(await page1.locator('[data-testid="biz-import-count-review"]').innerText());
    const invalid1 = Number(await page1.locator('[data-testid="biz-import-count-invalid"]').innerText());
    check(ready1 + update1 + dup1 + review1 + invalid1 === 120, `[8] every row is bucketed exactly once (ready ${ready1} + update ${update1} + duplicate ${dup1} + review ${review1} + invalid ${invalid1} === 120)`);
    check(invalid1 === 0, "[3] the real file has no genuinely invalid rows (no garbage coordinates, every row has a Business Code and Business Name)");
    check(ready1 > 0, "[3] at least some real rows are ready to import as-is");
    check(review1 > 0, "[18] at least some real rows are flagged for review (this file has many rows with Category = \"NA\")");
    check(update1 === 0, "on a first import, nothing is an update yet (city started with zero businesses)");

    console.log("\n[13][12] Preview performs zero writes:");
    const afterPreview = await getBusinesses(page1);
    check(afterPreview.length === 0, "opening the preview alone created zero businesses");

    console.log("\n[14] Cancelling the import performs zero writes:");
    await page1.getByRole("button", { name: "Cancel" }).last().click();
    await page1.waitForSelector('[data-testid="biz-import-count-total"]', { state: "detached" });
    const afterCancel = await getBusinesses(page1);
    check(afterCancel.length === 0, "cancel left the business count at 0");

    console.log("\n[15] Confirmed import creates the expected records:");
    await uploadBuffer(page1, readFileSync(REAL_FILE), "Rajampet_Kadapa Converted Leads - Iliyas.xlsx");
    await page1.waitForSelector('[data-testid="biz-import-count-total"]');
    const readyBeforeConfirm = Number(await page1.locator('[data-testid="biz-import-count-ready"]').innerText());
    await page1.locator('[data-testid="biz-import-confirm"]').click();
    await page1.waitForSelector('[data-testid="biz-import-result"]');
    const afterConfirm = await getBusinesses(page1);
    check(afterConfirm.length === readyBeforeConfirm, `confirmed import created exactly ${readyBeforeConfirm} businesses (got ${afterConfirm.length})`);

    console.log("\n[10][20] Deterministic ids, and worker counts are never mapped to capacity:");
    check(
      afterConfirm.every((b) => b.id.startsWith("biz_import_")),
      "every imported business has a deterministic biz_import_ id",
    );
    check(
      afterConfirm.every((b) => b.capacityHoursPerDay === 3),
      "every imported business gets the existing-convention default capacityHoursPerDay (3), never derived from Workers Declared/Photographed",
    );
    check(
      afterConfirm.every((b) => b.active === true),
      "every imported business defaults to active, matching the existing manual-creation convention",
    );

    console.log("\n[16] Re-import (idempotency) on the SAME real file:");
    await uploadBuffer(page1, readFileSync(REAL_FILE), "Rajampet_Kadapa Converted Leads - Iliyas.xlsx");
    await page1.waitForSelector('[data-testid="biz-import-count-total"]');
    const ready2 = Number(await page1.locator('[data-testid="biz-import-count-ready"]').innerText());
    const update2 = Number(await page1.locator('[data-testid="biz-import-count-update"]').innerText());
    check(ready2 === 0, `[16] re-importing the identical file finds zero NEW businesses (got ${ready2})`);
    check(update2 === readyBeforeConfirm, `[16] every previously-created business is now recognized as an update (${update2} === ${readyBeforeConfirm})`);
    await page1.locator('[data-testid="biz-import-confirm"]').click();
    await page1.waitForSelector('[data-testid="biz-import-result"]');
    const afterReimport = await getBusinesses(page1);
    check(afterReimport.length === afterConfirm.length, "[16] re-import does not change the total business count — no duplicates created");

    console.log("\n[21] City Coverage consumes imported businesses through the normal data flow:");
    await page1.goto(`${BASE_URL}/city-coverage`);
    await page1.waitForSelector('h1:has-text("City Coverage")');
    const businessesWithCoords = afterReimport.filter(hasResolvableCoordinate).length;
    const markerCount = await page1.locator('[data-testid="city-coverage-business-marker"]').count();
    check(markerCount === businessesWithCoords, `[21] City Coverage renders exactly one marker per imported business that carries coordinates (${markerCount} markers for ${businessesWithCoords} coordinate-bearing businesses)`);
    // In THIS real file, the rows clean enough to import outright (a real
    // Category, no duplicate/mismatch flag) happen to be almost exactly the
    // same rows that also carry a resolvable coordinate — most of the 74
    // rows whose only location signal is an unparseable maps.app.goo.gl
    // short link were independently held back for review (missing
    // Category), not created without coordinates. The "stay unplotted,
    // never geocoded" behavior for a coordinate-less CREATED business is
    // verified directly below with a dedicated synthetic fixture instead of
    // assumed from this file's particular mix.

    await ctx1.close();

    // ========================================================================
    // Section 2: synthetic fixtures for edge cases
    // ========================================================================
    console.log("\n[4][5][6] Coordinate validation — valid, invalid, and Maps URL parsing (q= and @ forms):");
    const coordCtx = await browser.newContext();
    const coordPage = await coordCtx.newPage();
    await seedManager(coordPage, emptyCityData());
    await openImportTab(coordPage);
    const coordXlsx = await buildSyntheticXlsx([
      { "Business Code": "SYN-001", "Business Name": "Valid Coords Biz", Category: "Automotive Services", Latitude: "14.19", Longitude: "79.16" },
      { "Business Code": "SYN-002", "Business Name": "Invalid Coords Biz", Category: "Automotive Services", Latitude: "999", Longitude: "79.16" },
      { "Business Code": "SYN-003", "Business Name": "Maps Q Form Biz", Category: "Automotive Services", "Maps Link": "https://www.google.com/maps?q=14.20,79.17" },
      { "Business Code": "SYN-004", "Business Name": "Maps At Form Biz", Category: "Automotive Services", "Maps Link": "https://www.google.com/maps/place/Somewhere/@14.21,79.18,17z" },
      { "Business Code": "SYN-005", "Business Name": "No Location Biz", Category: "Automotive Services" },
    ]);
    await uploadBuffer(coordPage, coordXlsx, "coords.xlsx");
    await coordPage.waitForSelector('[data-testid="biz-import-count-total"]');
    const coordRows = await coordPage.locator('[data-testid="biz-import-row"]').all();
    const coordDecisions = {};
    for (const row of coordRows) {
      const text = await row.innerText();
      const decision = await row.getAttribute("data-decision");
      coordDecisions[text.split("·")[0].trim()] = decision;
    }
    check(coordDecisions["Valid Coords Biz"] === "create", "[4] valid in-range coordinates -> row is ready to create");
    check(coordDecisions["Invalid Coords Biz"] === "invalid", "[4] out-of-range latitude (999) -> row rejected as invalid");
    check(coordDecisions["Maps Q Form Biz"] === "create", "[5] a Maps Link using the ?q=lat,lng form is accepted");
    check(coordDecisions["Maps At Form Biz"] === "create", "[6] a Maps Link using the @lat,lng,zoom form is accepted");
    check(coordDecisions["No Location Biz"] === "create", "a business with no coordinate signal at all is still created (just without a map marker)");
    await coordPage.locator('[data-testid="biz-import-confirm"]').click();
    await coordPage.waitForSelector('[data-testid="biz-import-result"]');
    const coordBusinesses = await getBusinesses(coordPage);
    const noLocationBiz = coordBusinesses.find((b) => b.name === "No Location Biz");
    check(!!noLocationBiz && noLocationBiz.lat == null && noLocationBiz.lng == null, "the coordinate-less business was created with no lat/lng — never geocoded, never fabricated");
    await coordPage.goto(`${BASE_URL}/city-coverage`);
    await coordPage.waitForSelector('h1:has-text("City Coverage")');
    const coordMarkerCount = await coordPage.locator('[data-testid="city-coverage-business-marker"]').count();
    const coordWithCoords = coordBusinesses.filter(hasResolvableCoordinate).length;
    check(coordMarkerCount === coordWithCoords && coordWithCoords < coordBusinesses.length, `[7][21] the coordinate-less business stays unplotted on the map (${coordMarkerCount} markers for ${coordWithCoords}/${coordBusinesses.length} businesses with coordinates) — never geocoded`);
    await coordCtx.close();

    console.log("\n[7] Mismatched Latitude/Longitude vs Maps Link coordinates are flagged, never silently resolved:");
    const mismatchCtx = await browser.newContext();
    const mismatchPage = await mismatchCtx.newPage();
    await seedManager(mismatchPage, emptyCityData());
    await openImportTab(mismatchPage);
    const mismatchXlsx = await buildSyntheticXlsx([
      { "Business Code": "SYN-010", "Business Name": "Mismatch Biz", Category: "Automotive Services", Latitude: "14.19", Longitude: "79.16", "Maps Link": "https://www.google.com/maps?q=15.50,80.50" },
    ]);
    await uploadBuffer(mismatchPage, mismatchXlsx, "mismatch.xlsx");
    await mismatchPage.waitForSelector('[data-testid="biz-import-count-total"]');
    const mismatchReview = Number(await mismatchPage.locator('[data-testid="biz-import-count-review"]').innerText());
    check(mismatchReview === 1, "[7] a Latitude/Longitude vs Maps Link mismatch beyond tolerance is flagged as needing review");
    const mismatchRowText = await mismatchPage.locator('[data-testid="biz-import-row"]').innerText();
    check(/disagree/i.test(mismatchRowText), "[7] the flagged reason explicitly explains the disagreement rather than silently picking a source");
    await mismatchCtx.close();

    console.log("\n[8][9] Duplicate Business Code within one file, and duplicate rows don't create duplicate businesses:");
    const dupCtx = await browser.newContext();
    const dupPage = await dupCtx.newPage();
    await seedManager(dupPage, emptyCityData());
    await openImportTab(dupPage);
    const dupCodeXlsx = await buildSyntheticXlsx([
      { "Business Code": "SYN-020", "Business Name": "First Of Pair", Category: "Automotive Services" },
      { "Business Code": "SYN-020", "Business Name": "Second Of Pair", Category: "Automotive Services" },
    ]);
    await uploadBuffer(dupPage, dupCodeXlsx, "dupcode.xlsx");
    await dupPage.waitForSelector('[data-testid="biz-import-count-total"]');
    const dupCodeCount = Number(await dupPage.locator('[data-testid="biz-import-count-duplicate"]').innerText());
    check(dupCodeCount === 2, `[8] a Business Code repeated on two rows flags both rows as duplicates (got ${dupCodeCount})`);
    const dupCodeReady = Number(await dupPage.locator('[data-testid="biz-import-count-ready"]').innerText());
    check(dupCodeReady === 0, "[8] neither half of a duplicate-code pair is auto-created");
    await dupPage.getByRole("button", { name: "Cancel" }).last().click();
    await dupCtx.close();

    console.log("\n[11] Existing businesses are updated only on importer-owned fields — Manager edits to capacity/active/notes survive re-import:");
    const updateCtx = await browser.newContext();
    const updatePage = await updateCtx.newPage();
    const existingBiz = {
      id: "biz_import_syn-030",
      name: "Old Name Before Import",
      category: "Old Category",
      area: "Old Area",
      address: "Old Address",
      active: false,
      capacityHoursPerDay: 9,
      notes: "Manager's own note — must survive re-import",
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    await seedManager(updatePage, emptyCityData({ businesses: [existingBiz] }));
    await openImportTab(updatePage);
    const updateXlsx = await buildSyntheticXlsx([{ "Business Code": "SYN-030", "Business Name": "New Name From Spreadsheet", Category: "Metal Fabrication", City: "Rajampet", Address: "New Address" }]);
    await uploadBuffer(updatePage, updateXlsx, "update.xlsx");
    await updatePage.waitForSelector('[data-testid="biz-import-count-total"]');
    const updateCount = Number(await updatePage.locator('[data-testid="biz-import-count-update"]').innerText());
    check(updateCount === 1, "[11] a row matching an existing deterministic id is recognized as an update, not a create");
    await updatePage.locator('[data-testid="biz-import-confirm"]').click();
    await updatePage.waitForSelector('[data-testid="biz-import-result"]');
    const [updatedBiz] = await getBusinesses(updatePage);
    check(updatedBiz.name === "New Name From Spreadsheet", "[11] importer-owned field (name) was updated from the spreadsheet");
    check(updatedBiz.category === "Metal Fabrication", "[11] importer-owned field (category) was updated from the spreadsheet");
    check(updatedBiz.active === false, "[11] Manager-owned field (active=false) was NOT reverted by the re-import");
    check(updatedBiz.capacityHoursPerDay === 9, "[11] Manager-owned field (capacityHoursPerDay=9) was NOT reverted by the re-import");
    check(updatedBiz.notes === "Manager's own note — must survive re-import", "[11] Manager-owned field (notes) was NOT touched by the re-import");
    check(updatedBiz.createdAt === "2024-01-01T00:00:00.000Z", "[11] createdAt was not reset by the re-import");
    await updateCtx.close();

    console.log("\n[18][19][20] Spreadsheet-only Outcome/Risk Score/worker counts never become operational status or capacity:");
    const statusCtx = await browser.newContext();
    const statusPage = await statusCtx.newPage();
    await seedManager(statusPage, emptyCityData());
    await openImportTab(statusPage);
    const statusXlsx = await buildSyntheticXlsx([
      {
        "Business Code": "SYN-040",
        "Business Name": "Status Fields Biz",
        Category: "Automotive Services",
        Outcome: "declined",
        Status: "verification_pending",
        "Risk Score": "95",
        "Workers Declared": "40",
        "Workers Photographed": "40",
      },
    ]);
    await uploadBuffer(statusPage, statusXlsx, "status.xlsx");
    await statusPage.waitForSelector('[data-testid="biz-import-count-total"]');
    await statusPage.locator('[data-testid="biz-import-confirm"]').click();
    await statusPage.waitForSelector('[data-testid="biz-import-result"]');
    const [statusBiz] = await getBusinesses(statusPage);
    check(statusBiz.capacityHoursPerDay === 3, "[20] Workers Declared=40/Workers Photographed=40 did NOT change capacityHoursPerDay from its default");
    check(statusBiz.active === true, "[18] Outcome=\"declined\" did NOT set active=false — no fabricated status translation");
    check(!("outcome" in statusBiz) && !("riskScore" in statusBiz) && !("status" in statusBiz) && !("verificationStatus" in statusBiz), "[18][19] no Outcome/Status/Risk Score field was ever written onto the Business record");
    await statusCtx.close();

    console.log("\n[28][29][30] Empty file and malformed file are handled without a crash:");
    const errCtx = await browser.newContext();
    const errPage = await errCtx.newPage();
    await seedManager(errPage, emptyCityData());
    await openImportTab(errPage);
    const emptyXlsx = await buildSyntheticXlsx([]);
    await uploadBuffer(errPage, emptyXlsx, "empty.xlsx");
    await errPage.waitForSelector('[data-testid="biz-import-error"]');
    check(true, "[29] an empty spreadsheet (headers only, no data rows) shows an error rather than a blank/crashed preview");
    await uploadBuffer(errPage, Buffer.from("this is not a real xlsx file"), "malformed.xlsx");
    await errPage.waitForSelector('[data-testid="biz-import-error"]');
    check(true, "[30] a malformed (non-spreadsheet) file shows an error rather than crashing the page");
    const errBusinesses = await getBusinesses(errPage);
    check(errBusinesses.length === 0, "no businesses were created from either failed parse");
    await errCtx.close();

    console.log("\n[28] A row missing a required field (Business Name) is rejected, the rest of the file still imports:");
    const partialCtx = await browser.newContext();
    const partialPage = await partialCtx.newPage();
    await seedManager(partialPage, emptyCityData());
    await openImportTab(partialPage);
    const partialXlsx = await buildSyntheticXlsx([
      { "Business Code": "SYN-050", "Business Name": "Has A Name", Category: "Automotive Services" },
      { "Business Code": "SYN-051", "Business Name": "", Category: "Automotive Services" },
    ]);
    await uploadBuffer(partialPage, partialXlsx, "partial.xlsx");
    await partialPage.waitForSelector('[data-testid="biz-import-count-total"]');
    const partialReady = Number(await partialPage.locator('[data-testid="biz-import-count-ready"]').innerText());
    const partialInvalid = Number(await partialPage.locator('[data-testid="biz-import-count-invalid"]').innerText());
    check(partialReady === 1, "[28] the well-formed row is still ready to import");
    check(partialInvalid === 1, "[28] the row missing Business Name is rejected as invalid, not silently dropped or crashed on");
    await partialCtx.close();

    // ========================================================================
    // Section 3: security — Manager-only, FO cannot see or reach the feature
    // ========================================================================
    console.log("\n[22][23][24] Manager-only: an FO account cannot reach Settings, the import UI, or City Coverage:");
    const foCtx = await browser.newContext();
    const foPage = await foCtx.newPage();
    await foPage.goto(`${BASE_URL}/login`);
    await foPage.evaluate(() => {
      const now = new Date().toISOString();
      const cityData = {
        version: 2,
        settings: { cityName: "FO Denied City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
        businesses: [],
        fos: [{ id: "fo_import_denied", name: "Denied FO", active: true, createdAt: now }],
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
      localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-fo-import-denied", email: "denied.fo@demo.city-ops", role: "FIELD_OFFICER", displayName: "Denied FO", foId: "fo_import_denied", createdAt: now }));
    });
    await foPage.goto(`${BASE_URL}/settings?tab=data`);
    await sleep(500);
    check(!foPage.url().includes("/settings"), `[22][24] an FO navigating to /settings?tab=data is redirected away (ended at ${foPage.url()})`);
    const importButtonVisibleToFo = await foPage.locator('[data-testid="biz-import-button"]').count();
    check(importButtonVisibleToFo === 0, "[22] the Import Businesses control never renders for an FO");
    await foPage.goto(`${BASE_URL}/city-coverage`);
    await sleep(500);
    check(!foPage.url().includes("/city-coverage"), `[23] an FO navigating to /city-coverage is redirected away (ended at ${foPage.url()})`);
    await foCtx.close();

    // ========================================================================
    // Section 4: mobile + theme
    // ========================================================================
    console.log("\n[25][26][27] Light mode, dark mode, and mobile layout:");
    const themeCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const themePage = await themeCtx.newPage();
    await seedManager(themePage, emptyCityData({ settings: { cityName: "Import Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "light", onboarded: true } }));
    await openImportTab(themePage);
    const themeXlsx = await buildSyntheticXlsx([{ "Business Code": "SYN-060", "Business Name": "Mobile Theme Biz", Category: "Automotive Services" }]);
    await uploadBuffer(themePage, themeXlsx, "theme.xlsx");
    await themePage.waitForSelector('[data-testid="biz-import-count-total"]');
    const noOverflowLight = await themePage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    check(noOverflowLight, "[27] the import preview dialog fits within a 390px mobile viewport with no horizontal overflow");
    check(!(await themePage.evaluate(() => document.documentElement.classList.contains("dark"))), "[25] light mode renders (no 'dark' class) when the city's theme setting is light");
    await themePage.evaluate(() => document.documentElement.classList.add("dark"));
    await sleep(200);
    check(await themePage.locator('[data-testid="biz-import-row"]').first().isVisible(), "[26] the import preview row list is still visible after switching to dark mode");
    await themeCtx.close();

    console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
  } finally {
    await browser.close();
    await killAndWait(vite);
    if (failures > 0) console.error(viteOutput.slice(-4000));
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
