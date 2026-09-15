// Regression test for Phase F.5 — Business Data Quality Completion workflow
// (Review Queue UX filters/sort, the inline duplicate+category/coordinate
// resolution fix in src/components/import/BusinessDataQuality.tsx, the new
// Missing Location manual-entry section, and the new read-only
// src/components/import/ImportReconciliation.tsx). REAL BROWSER
// click-through against the production build, using the actual 120-row
// lead spreadsheet plus small synthetic fixtures.
//
// Run with: npm run test:f5-data-quality-completion

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

// The exact 33 approved Business Codes from the F.4 preflight extraction —
// used to simulate "these are already in the Business Master" for the
// re-import / reconciliation fixtures below.
const APPROVED_CODES = [
  "RAJ-B-000548", "RAJ-B-000661", "RAJ-B-000663", "RAJ-B-000741", "RAJ-B-000743",
  "RAJ-B-000745", "RAJ-B-000834", "RAJ-B-000844", "RAJ-B-000861", "RAJ-B-000865",
  "RAJ-B-000866", "RAJ-B-000957", "RAJ-B-000966", "RAJ-B-001052", "RAJ-B-001058",
  "RAJ-B-001060", "RAJ-B-001068", "RAJ-B-001140", "RAJ-B-001146", "RAJ-B-001165",
  "RAJ-B-001174", "RAJ-B-001191", "RAJ-B-001195", "RAJ-B-001197", "RAJ-B-001235",
  "RAJ-B-001382", "RAJ-B-001384", "RAJ-B-001391", "RAJ-B-001394", "RAJ-B-001396",
  "RAJ-B-001970", "RAJ-B-001974", "RAJ-B-002090",
];

// Mirrors deterministicBusinessImportId() in src/engine/businessImport.ts exactly.
function deterministicId(code) {
  const slug = code.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `biz_import_${slug || "unknown"}`;
}

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
    settings: { cityName: "F5 Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
    businesses: [], fos: [], collectors: [], rigs: [], assignments: [], sessions: [], evidence: [], issues: [],
    qualityReviews: [], correctiveActions: [], rigIncidents: [], repairRecords: [], activity: [], plans: [], reports: [],
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

async function tileValue(page, testId) {
  return Number(await page.locator(`[data-testid="${testId}"]`).innerText().then((t) => t.match(/\d+/)[0]));
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
    // [A][B][C][P][Q][R] Re-import into a store simulating the real
    // post-F.4 production state: 2 foreign (Manager-created) businesses +
    // the 33 already-imported businesses, matched by deterministic id.
    // ========================================================================
    const foreignBusinesses = [
      { id: "biz_foreign_001", name: "Manager Created Shop", category: "Automotive Services", area: "Rajampet", address: "", active: true, capacityHoursPerDay: 5, createdAt: "2024-01-01T00:00:00.000Z" },
      { id: "biz_foreign_002", name: "Another Manager Shop", category: "Metal Fabrication", area: "Kadapa", address: "", active: true, capacityHoursPerDay: 3, createdAt: "2024-01-02T00:00:00.000Z" },
    ];
    const seededImported = APPROVED_CODES.map((code, i) => ({
      id: deterministicId(code),
      name: `Placeholder ${code}`,
      category: "Automotive Services",
      area: "Rajampet",
      address: "",
      active: i === 0 ? false : true, // Manager toggled the first one off
      capacityHoursPerDay: i === 0 ? 9 : 3, // Manager bumped capacity on the first one
      notes: i === 0 ? "Manager note — must survive re-import" : undefined,
      createdAt: "2024-06-01T00:00:00.000Z",
    }));

    const reimportCtx = await browser.newContext();
    const reimportPage = await reimportCtx.newPage();
    await seedManager(reimportPage, emptyCityData({ businesses: [...foreignBusinesses, ...seededImported] }));
    await openImportTab(reimportPage);
    await uploadBuffer(reimportPage, readFileSync(REAL_FILE), "Rajampet_Kadapa Converted Leads - Iliyas.xlsx");
    await reimportPage.waitForSelector('[data-testid="biz-import-count-total"]');

    console.log("\n[A] Existing 33 production identities matched on re-upload:");
    const updateCount = Number(await reimportPage.locator('[data-testid="biz-import-count-update"]').innerText());
    check(updateCount === 33, `[A] all 33 previously-imported rows are recognized as UPDATE (got ${updateCount})`);
    const createCountBefore = Number(await reimportPage.locator('[data-testid="biz-import-count-ready"]').innerText());
    check(createCountBefore === 0, `[A] no NEW-create rows for the already-imported 33 (got ${createCountBefore})`);

    console.log("\n[C] Remaining 87 rows stay unresolved (re-uploading alone resolves nothing):");
    const reviewCount = Number(await reimportPage.locator('[data-testid="biz-import-count-review"]').innerText());
    const dupCount = Number(await reimportPage.locator('[data-testid="biz-import-count-duplicate"]').innerText());
    check(reviewCount + dupCount === 87, `[C] needs-review + duplicate-review still sum to 87 (got ${reviewCount + dupCount})`);

    console.log("\n[J] Source vs Production reconciliation:");
    await reimportPage.locator('[data-testid="biz-import-tab-reconciliation"]').click();
    await reimportPage.waitForSelector('[data-testid="biz-reconciliation-panel"]');
    const reconImported = await tileValue(reimportPage, "reconciliation-imported");
    const reconNotImported = await tileValue(reimportPage, "reconciliation-not-imported");
    const reconForeign = await tileValue(reimportPage, "reconciliation-existing-foreign");
    check(reconImported === 33, `[J] reconciliation shows 33 already-imported source rows (got ${reconImported})`);
    check(reconNotImported === 87, `[J] reconciliation shows 87 not-yet-imported source rows (got ${reconNotImported})`);
    check(reconForeign === 2, `[J] reconciliation shows exactly the 2 pre-existing, non-source businesses (got ${reconForeign})`);
    const foreignRows = await reimportPage.locator('[data-testid="reconciliation-foreign-business-row"]').count();
    check(foreignRows === 2, `[J] the 2 foreign businesses are listed distinctly from the 33 imported ones (got ${foreignRows})`);
    const importedRows = await reimportPage.locator('[data-testid="reconciliation-imported-business-row"]').count();
    check(importedRows === 33, `[J] all 33 already-imported businesses are listed under 'already imported from this source' (got ${importedRows})`);

    console.log("\n[K] Zero writes from viewing reconciliation / switching tabs:");
    const businessesStillSame = await getBusinesses(reimportPage);
    check(businessesStillSame.length === 2 + 33, "viewing reconciliation wrote nothing");

    console.log("\n[Q] Toggling filter/sort controls never changes the final plan:");
    await reimportPage.locator('[data-testid="biz-import-tab-quality"]').click();
    await reimportPage.waitForSelector('[data-testid="biz-dq-panel"]');
    const readyBeforeToggle = await tileValue(reimportPage, "biz-dq-summary-ready");
    await reimportPage.locator('[data-testid="biz-dq-filter-category"]').click();
    await reimportPage.locator('[data-testid="biz-dq-sort-select"]').click();
    await reimportPage.locator('[role="option"]', { hasText: "Business Name" }).click();
    await reimportPage.locator('[data-testid="biz-dq-filter-duplicate"]').click();
    await reimportPage.locator('[data-testid="biz-dq-filter-all"]').click();
    const readyAfterToggle = await tileValue(reimportPage, "biz-dq-summary-ready");
    check(readyBeforeToggle === readyAfterToggle, `[Q] Ready count unchanged by filter/sort toggling (${readyBeforeToggle} === ${readyAfterToggle})`);

    console.log("\n[M][P][R] Confirm writes exactly the update set, preserving Manager-owned fields:");
    await reimportPage.locator('[data-testid="biz-import-tab-summary"]').click();
    await reimportPage.locator('[data-testid="biz-import-confirm"]').click();
    await reimportPage.waitForSelector('[data-testid="biz-import-result"]');
    const afterReimport = await getBusinesses(reimportPage);
    check(afterReimport.length === 2 + 33, `[B] no duplicate businesses created on re-import (still ${2 + 33}, got ${afterReimport.length})`);
    const foreign1 = afterReimport.find((b) => b.id === "biz_foreign_001");
    const foreign2 = afterReimport.find((b) => b.id === "biz_foreign_002");
    check(foreign1?.name === "Manager Created Shop" && foreign2?.name === "Another Manager Shop", "[R] the 2 pre-existing foreign businesses were never touched");
    const firstImported = afterReimport.find((b) => b.id === deterministicId(APPROVED_CODES[0]));
    check(firstImported?.active === false && firstImported?.capacityHoursPerDay === 9 && firstImported?.notes === "Manager note — must survive re-import", "[P][R] Manager-owned fields (active/capacityHoursPerDay/notes) survived the re-import UPDATE");
    check(firstImported?.name !== `Placeholder ${APPROVED_CODES[0]}`, "[P][R] the importer-owned name field WAS refreshed from the spreadsheet on UPDATE");

    await reimportCtx.close();

    // ========================================================================
    // [D][E] Duplicate + category overlap — the fix: inline category
    // control inside the duplicate cluster card resolves rows the primary
    // Category review section can never show (their decision is
    // "duplicate_review", not "needs_review").
    // ========================================================================
    console.log("\n[D][E] Duplicate cluster member that's ALSO missing a category can be resolved inline:");
    const dcCtx = await browser.newContext();
    const dcPage = await dcCtx.newPage();
    await seedManager(dcPage, emptyCityData());
    await openImportTab(dcPage);
    const dcXlsx = await buildSyntheticXlsx([
      { "Business Code": "F5-001", "Business Name": "Dup Cat Pair", "Contact Phone": "9200000001", Category: "NA" },
      { "Business Code": "F5-002", "Business Name": "Dup Cat Pair", "Contact Phone": "9200000001", Category: "Automotive Services" },
      { "Business Code": "F5-003", "Business Name": "Unrelated Biz", Category: "Automotive Services" },
    ]);
    await uploadBuffer(dcPage, dcXlsx, "dc.xlsx");
    await dcPage.waitForSelector('[data-testid="biz-import-count-total"]');
    await dcPage.locator('[data-testid="biz-import-tab-quality"]').click();
    await dcPage.waitForSelector('[data-testid="biz-dq-panel"]');

    // F5-001 must NOT appear in the primary Category review card (its
    // decision is duplicate_review, not needs_review) — the pre-F.5 gap.
    const primaryCategoryHasF5001 = await dcPage.locator('[data-testid="biz-dq-category-row"]').filter({ hasText: "F5-001" }).count();
    check(primaryCategoryHasF5001 === 0, "[D] the duplicate-flagged, category-missing row does NOT appear in the primary Category review card (as before F.5)");

    // It DOES have an inline category control inside the duplicate cluster.
    const clusterCategorySelect = dcPage.locator('[data-testid="biz-dq-cluster"]').filter({ hasText: "F5-001" }).locator('[data-testid="biz-dq-cluster-category-select"]');
    check((await clusterCategorySelect.count()) === 1, "[D][E] the duplicate cluster card shows an inline category control for the row that's also missing a category");
    await clusterCategorySelect.click();
    await dcPage.locator('[role="option"]').first().click();
    await sleep(150);
    // Keep both — F5-001 should now become Ready since both its blockers (duplicate + category) are resolved.
    await dcPage.locator('[data-testid="biz-dq-cluster"]').filter({ hasText: "F5-001" }).locator('[data-testid="biz-dq-cluster-keep-all"]').click();
    await sleep(150);
    const readyRowCount = await dcPage.locator('[data-testid="biz-import-tab-preflight"]').count();
    await dcPage.locator('[data-testid="biz-import-tab-preflight"]').click();
    await dcPage.waitForSelector('[data-testid="biz-preflight-panel"]');
    const f5001Ready = await dcPage.locator('[data-testid="preflight-write-row"]').filter({ hasText: "Dup Cat Pair" }).count();
    check(readyRowCount === 1 && f5001Ready === 2, `[D][E] both members of the duplicate cluster are now Ready once EVERY blocker (duplicate resolution + category) is resolved (got ${f5001Ready} ready rows)`);
    await dcCtx.close();

    // ========================================================================
    // [F] Coordinate conflict + duplicate overlap — same fix, coordinate variant.
    // ========================================================================
    console.log("\n[F] Duplicate cluster member that ALSO has a coordinate conflict can be resolved inline:");
    const ccCtx = await browser.newContext();
    const ccPage = await ccCtx.newPage();
    await seedManager(ccPage, emptyCityData());
    await openImportTab(ccPage);
    const ccXlsx = await buildSyntheticXlsx([
      {
        "Business Code": "F5-010", "Business Name": "Dup Coord Pair", "Contact Phone": "9200000002", Category: "Automotive Services",
        Latitude: "14.19", Longitude: "79.16", "Maps Link": "https://www.google.com/maps?q=15.50,80.50",
      },
      { "Business Code": "F5-011", "Business Name": "Dup Coord Pair", "Contact Phone": "9200000002", Category: "Automotive Services" },
    ]);
    await uploadBuffer(ccPage, ccXlsx, "cc.xlsx");
    await ccPage.waitForSelector('[data-testid="biz-import-count-total"]');
    await ccPage.locator('[data-testid="biz-import-tab-quality"]').click();
    await ccPage.waitForSelector('[data-testid="biz-dq-panel"]');
    const primaryCoordHasF5010 = await ccPage.locator('[data-testid="biz-dq-coord-row"]').filter({ hasText: "F5-010" }).count();
    check(primaryCoordHasF5010 === 0, "[F] the duplicate-flagged coordinate-conflict row does NOT appear in the primary Coordinate review card");
    const clusterCoordButton = ccPage.locator('[data-testid="biz-dq-cluster"]').filter({ hasText: "F5-010" }).locator('[data-testid="biz-dq-cluster-coord-spreadsheet"]');
    check((await clusterCoordButton.count()) === 1, "[F] the duplicate cluster card shows an inline coordinate-conflict control");
    await clusterCoordButton.click();
    await ccPage.locator('[data-testid="biz-dq-cluster"]').filter({ hasText: "F5-010" }).locator('[data-testid="biz-dq-cluster-keep-all"]').click();
    await sleep(150);
    await ccPage.locator('[data-testid="biz-import-tab-preflight"]').click();
    await ccPage.waitForSelector('[data-testid="biz-preflight-panel"]');
    const ccReady = await ccPage.locator('[data-testid="preflight-write-row"]').filter({ hasText: "Dup Coord Pair" }).count();
    check(ccReady === 2, `[F] both members become Ready once the coordinate conflict AND duplicate are both resolved (got ${ccReady})`);
    await ccCtx.close();

    // ========================================================================
    // [G] Manual coordinate entry for the NEW "Missing location" bucket
    // (no Maps link at all — distinct from the pre-existing short-link
    // section) — validation rejects out-of-range values.
    // ========================================================================
    console.log("\n[G] Missing-location manual entry: validation + save:");
    const locCtx = await browser.newContext();
    const locPage = await locCtx.newPage();
    await seedManager(locPage, emptyCityData());
    await openImportTab(locPage);
    const locXlsx = await buildSyntheticXlsx([{ "Business Code": "F5-020", "Business Name": "No Location At All", Category: "Automotive Services" }]);
    await uploadBuffer(locPage, locXlsx, "loc.xlsx");
    await locPage.waitForSelector('[data-testid="biz-import-count-total"]');
    await locPage.locator('[data-testid="biz-import-tab-quality"]').click();
    await locPage.waitForSelector('[data-testid="biz-dq-panel"]');
    const locRow = locPage.locator('[data-testid="biz-dq-location-row"]');
    check((await locRow.count()) === 1, "[G] the no-Maps-link, no-coordinate row appears in the new Missing Location section");
    await locRow.locator('[data-testid="biz-dq-location-lat"]').fill("999");
    await locRow.locator('[data-testid="biz-dq-location-lng"]').fill("80");
    await locRow.locator('[data-testid="biz-dq-location-save"]').click();
    await sleep(100);
    check((await locPage.locator('[data-testid="biz-dq-location-saved"]').count()) === 0, "[G] an out-of-range manual latitude (999) is rejected, not silently saved");
    await locRow.locator('[data-testid="biz-dq-location-lat"]').fill("14.5");
    await locRow.locator('[data-testid="biz-dq-location-lng"]').fill("79.5");
    await locRow.locator('[data-testid="biz-dq-location-save"]').click();
    await sleep(100);
    check((await locPage.locator('[data-testid="biz-dq-location-saved"]').count()) === 1, "[G] a valid manual coordinate is saved");
    await locCtx.close();

    // ========================================================================
    // [H] Short-link section is unaffected by the new filter/sort/location bucket.
    // [I] Excluded-row handling: filter shows the excluded row, read-only (no action buttons).
    // ========================================================================
    console.log("\n[H][I] Short-link unaffected by the new bucket; excluded-row filter is read-only:");
    const hiCtx = await browser.newContext();
    const hiPage = await hiCtx.newPage();
    await seedManager(hiPage, emptyCityData());
    await openImportTab(hiPage);
    const hiXlsx = await buildSyntheticXlsx([
      { "Business Code": "F5-030", "Business Name": "Short Link Only", Category: "Automotive Services", "Maps Link": "https://maps.app.goo.gl/AbCdEfGh" },
      { "Business Code": "F5-031", "Business Name": "Excl Pair", "Contact Phone": "9200000003", Category: "Automotive Services" },
      { "Business Code": "F5-032", "Business Name": "Excl Pair", "Contact Phone": "9200000003", Category: "Automotive Services" },
    ]);
    await uploadBuffer(hiPage, hiXlsx, "hi.xlsx");
    await hiPage.waitForSelector('[data-testid="biz-import-count-total"]');
    await hiPage.locator('[data-testid="biz-import-tab-quality"]').click();
    await hiPage.waitForSelector('[data-testid="biz-dq-panel"]');
    check((await hiPage.locator('[data-testid="biz-dq-shortlink-row"]').count()) === 1, "[H] the short-link-only row still appears in its own, unchanged section");
    // F5-031/F5-032 (the duplicate pair) genuinely have no location signal at
    // all, so they correctly DO appear in Missing Location — the assertion
    // here is that the SHORT-LINK row (F5-030) specifically never also
    // shows up there (the two buckets are mutually exclusive per-row).
    check((await hiPage.locator('[data-testid="biz-dq-location-row"]').filter({ hasText: "F5-030" }).count()) === 0, "[H] the short-link row does NOT also appear in the missing-location section (mutually exclusive buckets)");
    check((await hiPage.locator('[data-testid="biz-dq-location-row"]').count()) === 2, "[H] the two genuinely-locationless rows (F5-031/F5-032) do appear in Missing Location");

    await hiPage.locator('[data-testid="biz-dq-cluster"]').filter({ hasText: "F5-031" }).locator('[data-testid="biz-dq-cluster-keep-only"]').first().click();
    await sleep(150);
    await hiPage.locator('[data-testid="biz-dq-filter-excluded"]').click();
    const excludedRow = hiPage.locator('[data-testid="biz-dq-excluded-row"]');
    check((await excludedRow.count()) === 1, "[I] the excluded-by-Manager filter shows exactly the excluded half of the pair");
    const excludedButtons = await excludedRow.locator("button").count();
    check(excludedButtons === 0, "[I] the excluded-row view is read-only — no action buttons");
    await hiCtx.close();

    // ========================================================================
    // [L] Zero writes from opening Preflight after all this resolution work.
    // ========================================================================
    console.log("\n[L] Zero writes from opening Preflight:");
    const lCtx = await browser.newContext();
    const lPage = await lCtx.newPage();
    await seedManager(lPage, emptyCityData());
    await openImportTab(lPage);
    await uploadBuffer(lPage, readFileSync(REAL_FILE), "Rajampet_Kadapa Converted Leads - Iliyas.xlsx");
    await lPage.waitForSelector('[data-testid="biz-import-count-total"]');
    await lPage.locator('[data-testid="biz-import-tab-preflight"]').click();
    await lPage.waitForSelector('[data-testid="biz-preflight-panel"]');
    const lBusinesses = await getBusinesses(lPage);
    check(lBusinesses.length === 0, "[L] viewing Preflight after a fresh upload wrote nothing");
    await lCtx.close();

    // ========================================================================
    // [N][O] Manager-only: FO cannot reach the Data Quality/Reconciliation UI.
    // ========================================================================
    console.log("\n[N][O] Manager-only: an FO cannot access Settings, Data Quality, or Reconciliation:");
    const foCtx = await browser.newContext();
    const foPage = await foCtx.newPage();
    await foPage.goto(`${BASE_URL}/login`);
    await foPage.evaluate(() => {
      const now = new Date().toISOString();
      const cityData = {
        version: 2,
        settings: { cityName: "FO F5 Denied", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
        businesses: [], fos: [{ id: "fo_f5_denied", name: "Denied FO", active: true, createdAt: now }], collectors: [], rigs: [],
        assignments: [], sessions: [], evidence: [], issues: [], qualityReviews: [], correctiveActions: [], rigIncidents: [],
        repairRecords: [], activity: [], plans: [], reports: [],
      };
      localStorage.setItem("city-ops-os", JSON.stringify({ state: cityData, version: 2 }));
      localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-fo-f5-denied", email: "denied.fo.f5@demo.city-ops", role: "FIELD_OFFICER", displayName: "Denied FO", foId: "fo_f5_denied", createdAt: now }));
    });
    await foPage.goto(`${BASE_URL}/settings?tab=data`);
    await sleep(500);
    check(!foPage.url().includes("/settings"), `[N] an FO navigating to /settings?tab=data is redirected away (ended at ${foPage.url()})`);
    check((await foPage.locator('[data-testid="biz-dq-panel"]').count()) === 0, "[N] the Data Quality panel never renders for an FO");
    check((await foPage.locator('[data-testid="biz-reconciliation-panel"]').count()) === 0, "[O] the Reconciliation panel never renders for an FO");
    check((await foPage.locator('[data-testid="biz-import-tab-reconciliation"]').count()) === 0, "[O] the Reconciliation tab trigger never renders for an FO");
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
