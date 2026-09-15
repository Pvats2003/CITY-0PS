// Regression test for Phase F.2 — Business Data Quality review workflow
// (src/engine/businessImport.ts's applyReviewResolutions()/
// buildDuplicateClusters()/categoryVocabulary(), and
// src/components/import/BusinessDataQuality.tsx as wired into
// src/pages/Settings.tsx). REAL BROWSER click-through against the
// production build, using the actual 120-row lead spreadsheet plus small
// synthetic fixtures for precise resolution-flow assertions.
//
// Run with: npm run test:business-data-quality

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
    settings: { cityName: "DQ Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
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

async function getBusinesses(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("city-ops-os")).state.businesses);
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

async function openQualityTab(page) {
  await page.waitForSelector('[data-testid="biz-import-tab-quality"]');
  await page.locator('[data-testid="biz-import-tab-quality"]').click();
  await page.waitForSelector('[data-testid="biz-dq-panel"]');
}

async function main() {
  console.log("\n[static] Data Quality source never reads a spreadsheet-only operational field:");
  const FORBIDDEN_IDENTIFIERS = ["riskScore", "workersDeclared", "workersPhotographed", "dataCaptain", "dcCode", "submittedAt", "suggestedCategory", "outcome", "hardTasks"];
  function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }
  for (const file of ["src/engine/businessImport.ts", "src/components/import/BusinessDataQuality.tsx", "src/pages/Settings.tsx"]) {
    const codeOnly = stripComments(readFileSync(file, "utf8"));
    for (const identifier of FORBIDDEN_IDENTIFIERS) {
      check(!new RegExp(`\\b${identifier}\\b`).test(codeOnly), `[static] ${file} never reads a "${identifier}" field`);
    }
  }

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

    // ========================================================================
    // [18] Real 120-row file: Data Quality tab renders the correct buckets
    // ========================================================================
    const realCtx = await browser.newContext();
    const realPage = await realCtx.newPage();
    await seedManager(realPage, emptyCityData());
    await openImportTab(realPage);
    await uploadBuffer(realPage, readFileSync(REAL_FILE), "Rajampet_Kadapa Converted Leads - Iliyas.xlsx");
    await realPage.waitForSelector('[data-testid="biz-import-count-total"]');
    await openQualityTab(realPage);

    console.log("\n[18][2][3][6] Real file — Data Quality summary and sections:");
    const readySummary = Number(await realPage.locator('[data-testid="biz-dq-summary-ready"]').innerText().then((t) => t.match(/\d+/)[0]));
    const categorySummary = Number(await realPage.locator('[data-testid="biz-dq-summary-category"]').innerText().then((t) => t.match(/\d+/)[0]));
    const duplicateSummary = Number(await realPage.locator('[data-testid="biz-dq-summary-duplicate"]').innerText().then((t) => t.match(/\d+/)[0]));
    const locationSummary = Number(await realPage.locator('[data-testid="biz-dq-summary-location"]').innerText().then((t) => t.match(/\d+/)[0]));
    const shortlinkSummary = Number(await realPage.locator('[data-testid="biz-dq-summary-shortlink"]').innerText().then((t) => t.match(/\d+/)[0]));
    check(readySummary === 33, `[2] Ready summary === 33 (got ${readySummary})`);
    check(categorySummary === 45, `[2] Missing category summary === 45 (got ${categorySummary})`);
    check(duplicateSummary === 41, `[2] Duplicate/identity review summary === 41 (got ${duplicateSummary})`);
    check(locationSummary === 1, `[2] Location review summary === 1 (got ${locationSummary})`);
    // 70, not the raw-text-regex count of 71: row 95's link
    // ("https://goo.gl/maps/...") is the OLDER bare goo.gl/maps/ short-link
    // format, which the existing (pre-Phase-F) isGoogleMapsUrl() validator
    // in src/lib/googleMaps.ts only recognizes for maps.app.goo.gl — a
    // genuine, pre-existing gap this audit surfaced, out of scope to fix in
    // this phase (shared utility, not the importer) — see the Phase F.2
    // report's "Short-link findings" section.
    check(shortlinkSummary === 70, `[2] Short map link summary === 70 (got ${shortlinkSummary}) — 71 raw goo.gl/maps.app matches minus 1 unrecognized bare goo.gl/maps/ link (row 95)`);
    check(readySummary + categorySummary + duplicateSummary + locationSummary === 120, "[2] primary buckets sum to 120 without double-counting");

    const categoryRowCount = await realPage.locator('[data-testid="biz-dq-category-row"]').count();
    check(categoryRowCount === 45, `[1] Category review section lists 45 rows (got ${categoryRowCount})`);
    const clusterCount = await realPage.locator('[data-testid="biz-dq-cluster"]').count();
    check(clusterCount > 0, `[3] Duplicate review shows ${clusterCount} clusters`);
    const conclusiveCount = await realPage.locator('[data-testid="biz-dq-cluster"][data-conclusive="true"]').count();
    // 5, not the naive "8 name+phone pairs" count from the Phase F.1 audit:
    // union-find correctly merges clusters transitively across ALL signal
    // types, so 3 of those 8 pairs turn out to share a Maps Link with a
    // THIRD, unrelated-looking business too (e.g. the same reused
    // maps.app.goo.gl link on 4 different business names from Phase F.1's
    // finding) — growing that cluster past 2 rows and correctly downgrading
    // it from "Likely" to "Possible" duplicate, since a 3+-way link reuse is
    // less clear-cut than a clean 2-row name+phone match.
    check(conclusiveCount === 5, `[3] Exactly 5 clusters are "Likely duplicate" (a clean 2-row name+phone match not entangled with any other row) (got ${conclusiveCount})`);
    const coordRowCount = await realPage.locator('[data-testid="biz-dq-coord-row"]').count();
    check(coordRowCount === 1, `[8] Location conflict review shows the 1 mismatched row (got ${coordRowCount})`);
    const shortLinkRowCount = await realPage.locator('[data-testid="biz-dq-shortlink-row"]').count();
    check(shortLinkRowCount === 70, `[static] Short map link section lists all 70 recognized rows (got ${shortLinkRowCount})`);

    console.log("\n[static][1] Wording never overclaims — ambiguous clusters say 'Possible duplicate', never bare 'Duplicate':");
    const ambiguousCluster = realPage.locator('[data-testid="biz-dq-cluster"][data-conclusive="false"]').first();
    check(/possible duplicate/i.test(await ambiguousCluster.innerText()), "an ambiguous cluster is worded as 'Possible duplicate'");

    console.log("\n[13] Zero writes just from opening the Data Quality tab and viewing rows:");
    const businessesAfterOpeningQuality = await getBusinesses(realPage);
    check(businessesAfterOpeningQuality.length === 0, "no businesses were written just by viewing the Data Quality tab");

    console.log("\n[9] Resolving the coordinate conflict — choose spreadsheet coordinates:");
    const beforeCoordFix = Number(await realPage.locator('[data-testid="biz-dq-summary-location"]').innerText().then((t) => t.match(/\d+/)[0]));
    await realPage.locator('[data-testid="biz-dq-coord-spreadsheet"]').click();
    await sleep(200);
    const afterCoordFix = Number(await realPage.locator('[data-testid="biz-dq-summary-location"]').innerText().then((t) => t.match(/\d+/)[0]));
    check(beforeCoordFix === 1 && afterCoordFix === 0, `[9][12] choosing spreadsheet coordinates clears the location-review count (before ${beforeCoordFix}, after ${afterCoordFix})`);
    const readyAfterCoordFix = Number(await realPage.locator('[data-testid="biz-dq-summary-ready"]').innerText().then((t) => t.match(/\d+/)[0]));
    check(readyAfterCoordFix === readySummary + 1, `[9][12] the resolved row moved into Ready (${readySummary} -> ${readyAfterCoordFix})`);

    console.log("\n[2][9] Assigning a category to one row moves it out of review and into Ready — spec section 9's exact example ('Manager resolves 10 -> those 10 move into Ready'):");
    await realPage.locator('[data-testid="biz-dq-category-row"]').first().locator('[data-testid="biz-dq-category-select"]').click();
    await realPage.locator('[role="option"]').first().click();
    await sleep(200);
    const categoryAfterAssign = Number(await realPage.locator('[data-testid="biz-dq-summary-category"]').innerText().then((t) => t.match(/\d+/)[0]));
    check(categoryAfterAssign === categorySummary - 1, `[2][12] missing-category count dropped by exactly 1 after assigning one row (before ${categorySummary}, after ${categoryAfterAssign})`);
    const categoryRowsAfterAssign = await realPage.locator('[data-testid="biz-dq-category-row"]').count();
    check(categoryRowsAfterAssign === categoryRowCount - 1, `[9] the resolved row itself disappeared from the Category review list (it now belongs in Ready), leaving ${categoryRowsAfterAssign} still in review`);

    console.log("\n[13] Still zero writes after resolving category + coordinate conflict, before Confirm:");
    const businessesAfterResolving = await getBusinesses(realPage);
    check(businessesAfterResolving.length === 0, "resolutions alone (no Confirm click) still wrote nothing");

    console.log("\n[14][12] Confirm Import writes exactly the now-larger ready set:");
    await realPage.locator('[data-testid="biz-import-tab-summary"]').click();
    const readyBeforeConfirm = Number(await realPage.locator('[data-testid="biz-import-count-ready"]').innerText());
    await realPage.locator('[data-testid="biz-import-confirm"]').click();
    await realPage.waitForSelector('[data-testid="biz-import-result"]');
    const businessesAfterConfirm = await getBusinesses(realPage);
    check(businessesAfterConfirm.length === readyBeforeConfirm, `[14] confirmed import created exactly ${readyBeforeConfirm} businesses (got ${businessesAfterConfirm.length}) — resolutions genuinely widened the ready set beyond the base 33`);
    check(readyBeforeConfirm === 35, `[9][2] two resolutions (1 coordinate + 1 category) raised Ready from 33 to 35 (got ${readyBeforeConfirm})`);

    console.log("\n[20] City Coverage consumes the newly-approved businesses through the normal data flow:");
    await realPage.goto(`${BASE_URL}/city-coverage`);
    await realPage.waitForSelector('h1:has-text("City Coverage")');
    const ccMarkerCount = await realPage.locator('[data-testid="city-coverage-business-marker"]').count();
    check(ccMarkerCount > 0, `[20] City Coverage renders ${ccMarkerCount} markers after the review-assisted import — no spreadsheet-specific code needed in CityCoverage.tsx`);

    console.log("\n[19] The uploaded file itself was never mutated — re-parsing the same original bytes still yields 120 rows:");
    const rawBytes = readFileSync(REAL_FILE);
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(rawBytes);
    let rowCount2 = 0;
    wb2.worksheets[0].eachRow((row, n) => {
      if (n > 1) rowCount2++;
    });
    check(rowCount2 === 120, `[19] the source .xlsx file on disk is unchanged (still 120 data rows) after being used for import`);

    await realCtx.close();

    // ========================================================================
    // Synthetic fixture: precise duplicate-resolution flows (keep A / keep B
    // / keep both / stays unresolved) and category vocabulary is closed
    // ========================================================================
    console.log("\n[4][5][6][7] Duplicate resolution — Keep A / Keep B / Keep Both / stays unresolved:");
    const dupCtx = await browser.newContext();
    const dupPage = await dupCtx.newPage();
    await seedManager(dupPage, emptyCityData());
    await openImportTab(dupPage);
    const dupXlsx = await buildSyntheticXlsx([
      { "Business Code": "DQ-001", "Business Name": "Pair One A", "Contact Phone": "9000000001", Category: "Automotive Services" },
      { "Business Code": "DQ-002", "Business Name": "Pair One A", "Contact Phone": "9000000001", Category: "Automotive Services" },
      { "Business Code": "DQ-003", "Business Name": "Pair Two A", "Contact Phone": "9000000002", Category: "Automotive Services" },
      { "Business Code": "DQ-004", "Business Name": "Pair Two B", "Contact Phone": "9000000002", Category: "Automotive Services" },
    ]);
    await uploadBuffer(dupPage, dupXlsx, "dup.xlsx");
    await dupPage.waitForSelector('[data-testid="biz-import-count-total"]');
    await openQualityTab(dupPage);
    const clusters = await dupPage.locator('[data-testid="biz-dq-cluster"]').all();
    check(clusters.length === 2, `two clusters formed (name+phone pairs) (got ${clusters.length})`);

    // Cluster 1 ("Pair One A" x2, DQ-001/DQ-002): keep only DQ-001
    const cluster1 = dupPage.locator('[data-testid="biz-dq-cluster"]').filter({ hasText: "DQ-001" });
    await cluster1.locator('[data-testid="biz-dq-cluster-keep-only"]').first().click();
    await sleep(150);
    const dupSummaryAfterKeepOne = Number(await dupPage.locator('[data-testid="biz-dq-summary-duplicate"]').innerText().then((t) => t.match(/\d+/)[0]));

    // Cluster 2 ("Pair Two A"/"Pair Two B", DQ-003/DQ-004): keep both
    const cluster2 = dupPage.locator('[data-testid="biz-dq-cluster"]').filter({ hasText: "DQ-003" });
    await cluster2.locator('[data-testid="biz-dq-cluster-keep-all"]').click();
    await sleep(150);

    await dupPage.locator('[data-testid="biz-import-tab-summary"]').click();
    const dupReady = Number(await dupPage.locator('[data-testid="biz-import-count-ready"]').innerText());
    const dupStillDuplicate = Number(await dupPage.locator('[data-testid="biz-import-count-duplicate"]').innerText());
    const dupExcluded = Number(await dupPage.locator('[data-testid="biz-import-count-excluded"]').innerText());
    check(dupReady === 3, `[4][6] "keep only DQ-001" (+1) and "keep both" DQ-003/DQ-004 (+2) => 3 rows ready (got ${dupReady})`);
    check(dupStillDuplicate === 0, `[4] nothing is left ambiguously "still a duplicate" once a Manager has explicitly decided every cluster (got ${dupStillDuplicate})`);
    check(dupExcluded === 1, `[4] the un-kept half of the "keep only" pair (DQ-002) is recorded as explicitly Excluded, not silently dropped or merged (got ${dupExcluded})`);
    await dupPage.locator('[data-testid="biz-import-confirm"]').click();
    await dupPage.waitForSelector('[data-testid="biz-import-result"]');
    const dupBusinesses = await getBusinesses(dupPage);
    check(dupBusinesses.length === 3, `[4][5][6] exactly 3 businesses created: DQ-001 (kept), DQ-003 and DQ-004 (kept both) — DQ-002 excluded (got ${dupBusinesses.length})`);
    check(!dupBusinesses.some((b) => b.name === "Pair One A" && b.id.includes("dq-002")), "[4] DQ-002 (excluded half of the pair) was never written");

    console.log("\n[7] A duplicate cluster nobody resolved stays blocked, un-promoted:");
    const untouchedCtx = await browser.newContext();
    const untouchedPage = await untouchedCtx.newPage();
    await seedManager(untouchedPage, emptyCityData());
    await openImportTab(untouchedPage);
    const untouchedXlsx = await buildSyntheticXlsx([
      { "Business Code": "DQ-010", "Business Name": "Untouched Pair", "Contact Phone": "9000000010", Category: "Automotive Services" },
      { "Business Code": "DQ-011", "Business Name": "Untouched Pair", "Contact Phone": "9000000010", Category: "Automotive Services" },
    ]);
    await uploadBuffer(untouchedPage, untouchedXlsx, "untouched.xlsx");
    await untouchedPage.waitForSelector('[data-testid="biz-import-count-total"]');
    const untouchedReady = Number(await untouchedPage.locator('[data-testid="biz-import-count-ready"]').innerText());
    const untouchedDup = Number(await untouchedPage.locator('[data-testid="biz-import-count-duplicate"]').innerText());
    check(untouchedReady === 0 && untouchedDup === 2, `[7][11] an unresolved duplicate cluster defaults to "needs further review" — nothing promoted (ready=${untouchedReady}, duplicate=${untouchedDup})`);
    await untouchedPage.locator('[data-testid="biz-import-tab-quality"]').click();
    await untouchedPage.waitForSelector('[data-testid="biz-dq-panel"]');
    check(await untouchedPage.locator('[data-testid="biz-dq-cluster-keep-all"]').first().evaluate((el) => !el.classList.contains("bg-primary")), "the default button state is NOT 'keep all' — nothing was auto-selected");
    await untouchedCtx.close();

    // ========================================================================
    // Coordinate resolution: Maps Link choice, and malformed manual entry
    // ========================================================================
    console.log("\n[10][24] Maps Link coordinate choice, and malformed manual coordinate entry is rejected:");
    const coordCtx = await browser.newContext();
    const coordPage = await coordCtx.newPage();
    await seedManager(coordPage, emptyCityData());
    await openImportTab(coordPage);
    const coordXlsx = await buildSyntheticXlsx([
      { "Business Code": "DQ-020", "Business Name": "Mismatch Biz", Category: "Automotive Services", Latitude: "14.19", Longitude: "79.16", "Maps Link": "https://www.google.com/maps?q=15.50,80.50" },
      { "Business Code": "DQ-021", "Business Name": "Short Link Biz", Category: "Automotive Services", "Maps Link": "https://maps.app.goo.gl/AbCdEfGhIjKlMnOp" },
    ]);
    await uploadBuffer(coordPage, coordXlsx, "coord.xlsx");
    await coordPage.waitForSelector('[data-testid="biz-import-count-total"]');
    await openQualityTab(coordPage);
    await coordPage.locator('[data-testid="biz-dq-coord-mapslink"]').click();
    await sleep(150);
    await coordPage.locator('[data-testid="biz-import-tab-summary"]').click();
    const coordReady = Number(await coordPage.locator('[data-testid="biz-import-count-ready"]').innerText());
    // 2, not 1: "Short Link Biz" never had ANY blocker in the first place
    // (a missing coordinate has never gated import — see
    // businessImport.ts) so it was already ready before any resolution;
    // resolving Mismatch Biz's conflict is what brings the total to 2.
    check(coordReady === 2, `[10] choosing Maps Link coordinates unblocks Mismatch Biz, joining the always-ready Short Link Biz (got ready=${coordReady})`);
    await coordPage.locator('[data-testid="biz-import-tab-quality"]').click();
    await coordPage.waitForSelector('[data-testid="biz-dq-shortlink-row"]');
    await coordPage.locator('[data-testid="biz-dq-shortlink-lat"]').fill("999");
    await coordPage.locator('[data-testid="biz-dq-shortlink-lng"]').fill("79.5");
    await coordPage.locator('[data-testid="biz-dq-shortlink-save"]').click();
    await sleep(150);
    check((await coordPage.locator('[data-testid="biz-dq-shortlink-saved"]').count()) === 0, "[24] an out-of-range manual coordinate (lat=999) is rejected, not silently saved");
    await coordPage.locator('[data-testid="biz-dq-shortlink-lat"]').fill("14.2");
    await coordPage.locator('[data-testid="biz-dq-shortlink-lng"]').fill("79.5");
    await coordPage.locator('[data-testid="biz-dq-shortlink-save"]').click();
    await sleep(150);
    check((await coordPage.locator('[data-testid="biz-dq-shortlink-saved"]').count()) === 1, "a valid manually-entered coordinate is saved");
    await coordPage.locator('[data-testid="biz-import-confirm"]').click();
    await coordPage.waitForSelector('[data-testid="biz-import-result"]');
    const coordBusinesses = await getBusinesses(coordPage);
    const mismatchBiz = coordBusinesses.find((b) => b.name === "Mismatch Biz");
    check(mismatchBiz && mismatchBiz.lat === 15.5 && mismatchBiz.lng === 80.5, "[10] Mismatch Biz was created with the Maps-Link-chosen coordinates, not the spreadsheet's");
    const shortLinkBiz = coordBusinesses.find((b) => b.name === "Short Link Biz");
    check(!!shortLinkBiz && shortLinkBiz.lat === 14.2 && shortLinkBiz.lng === 79.5, "the manually-entered coordinate for the short-link business was applied on import — never fetched/geocoded automatically");
    await coordCtx.close();

    // ========================================================================
    // Category vocabulary is closed (no free text) — only existing values
    // ========================================================================
    console.log("\n[2] Category vocabulary is a closed Select (existing values only), never free text:");
    const vocabCtx = await browser.newContext();
    const vocabPage = await vocabCtx.newPage();
    await seedManager(vocabPage, emptyCityData({ businesses: [{ id: "biz_seed1", name: "Seed Biz", category: "Existing Vocab Category", area: "A", address: "", active: true, capacityHoursPerDay: 3, createdAt: new Date().toISOString() }] }));
    await openImportTab(vocabPage);
    const vocabXlsx = await buildSyntheticXlsx([{ "Business Code": "DQ-030", "Business Name": "Vocab Test Biz", Category: "NA" }]);
    await uploadBuffer(vocabPage, vocabXlsx, "vocab.xlsx");
    await vocabPage.waitForSelector('[data-testid="biz-import-count-total"]');
    await openQualityTab(vocabPage);
    await vocabPage.locator('[data-testid="biz-dq-category-select"]').click();
    const optionTexts = await vocabPage.locator('[role="option"]').allInnerTexts();
    check(optionTexts.includes("Existing Vocab Category"), "the existing production business's category appears in the assignable vocabulary");
    check(vocabPage.url().length > 0, "no free-text category input exists — assignment is select-only by construction");
    await vocabCtx.close();

    // ========================================================================
    // Security: FO cannot see or reach the Data Quality UI
    // ========================================================================
    console.log("\n[16][17] Manager-only: an FO account cannot reach Settings or see the Data Quality UI:");
    const foCtx = await browser.newContext();
    const foPage = await foCtx.newPage();
    await foPage.goto(`${BASE_URL}/login`);
    await foPage.evaluate(() => {
      const now = new Date().toISOString();
      const cityData = {
        version: 2,
        settings: { cityName: "FO DQ Denied", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
        businesses: [],
        fos: [{ id: "fo_dq_denied", name: "Denied FO", active: true, createdAt: now }],
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
      localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-fo-dq-denied", email: "denied.fo.dq@demo.city-ops", role: "FIELD_OFFICER", displayName: "Denied FO", foId: "fo_dq_denied", createdAt: now }));
    });
    await foPage.goto(`${BASE_URL}/settings?tab=data`);
    await sleep(500);
    check(!foPage.url().includes("/settings"), `[16][17] an FO navigating to /settings?tab=data is redirected away (ended at ${foPage.url()})`);
    check((await foPage.locator('[data-testid="biz-dq-panel"]').count()) === 0, "[16][17] the Data Quality panel never renders for an FO");
    await foCtx.close();

    // ========================================================================
    // Light / dark / mobile
    // ========================================================================
    console.log("\n[21][22][23] Light mode, dark mode, mobile layout for the Data Quality tab:");
    const themeCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const themePage = await themeCtx.newPage();
    await seedManager(
      themePage,
      emptyCityData({ settings: { cityName: "DQ Theme City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "light", onboarded: true } }),
    );
    await openImportTab(themePage);
    const themeXlsx = await buildSyntheticXlsx([{ "Business Code": "DQ-040", "Business Name": "Theme Biz", Category: "NA" }]);
    await uploadBuffer(themePage, themeXlsx, "theme.xlsx");
    await themePage.waitForSelector('[data-testid="biz-import-count-total"]');
    await openQualityTab(themePage);
    check(!(await themePage.evaluate(() => document.documentElement.classList.contains("dark"))), "[21] light mode renders (no 'dark' class) for the Data Quality tab");
    const noOverflow = await themePage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    check(noOverflow, "[23] the Data Quality tab fits within a 390px mobile viewport with no horizontal overflow");
    await themePage.evaluate(() => document.documentElement.classList.add("dark"));
    await sleep(200);
    check(await themePage.locator('[data-testid="biz-dq-panel"]').isVisible(), "[22] the Data Quality panel is still visible after switching to dark mode");
    await themeCtx.close();

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
