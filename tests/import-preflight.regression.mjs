// Regression test for Phase F.3 — Import Preflight
// (src/engine/importPreflight.ts's buildFinalImportPlan(), and
// src/components/import/ImportPreflight.tsx as wired into
// src/pages/Settings.tsx's Import Businesses dialog). REAL BROWSER
// click-through against the production build, using the actual 120-row
// lead spreadsheet plus small synthetic fixtures for precise reason-code
// and write-preview assertions.
//
// Run with: npm run test:import-preflight

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
    settings: { cityName: "Preflight Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
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

async function openPreflightTab(page) {
  await page.waitForSelector('[data-testid="biz-import-tab-preflight"]');
  await page.locator('[data-testid="biz-import-tab-preflight"]').click();
  await page.waitForSelector('[data-testid="biz-preflight-panel"]');
}

async function tileValue(page, testId) {
  return Number(await page.locator(`[data-testid="${testId}"]`).innerText().then((t) => t.match(/\d+/)[0]));
}

async function main() {
  console.log("\n[static] Preflight source never reads a spreadsheet-only operational field:");
  const FORBIDDEN_IDENTIFIERS = ["riskScore", "workersDeclared", "workersPhotographed", "dataCaptain", "dcCode", "submittedAt", "suggestedCategory", "outcome", "hardTasks"];
  function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }
  for (const file of ["src/engine/importPreflight.ts", "src/components/import/ImportPreflight.tsx"]) {
    const codeOnly = stripComments(readFileSync(file, "utf8"));
    for (const identifier of FORBIDDEN_IDENTIFIERS) {
      check(!new RegExp(`\\b${identifier}\\b`).test(codeOnly), `[static] ${file} never reads a "${identifier}" field`);
    }
  }
  console.log("\n[15] Hard-stop check — no direct Firestore write anywhere in the preflight engine:");
  const preflightSrc = readFileSync("src/engine/importPreflight.ts", "utf8");
  check(!/setDoc|doc\(db|collection\(db|importCreateBusiness|updateBusiness\(/.test(preflightSrc), "importPreflight.ts never calls a write action — it only reads the resolved plan");

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
    // [A] Real 120-row file: final-plan classification
    // ========================================================================
    const realCtx = await browser.newContext();
    const realPage = await realCtx.newPage();
    await seedManager(realPage, emptyCityData());
    await openImportTab(realPage);
    await uploadBuffer(realPage, readFileSync(REAL_FILE), "Rajampet_Kadapa Converted Leads - Iliyas.xlsx");
    await realPage.waitForSelector('[data-testid="biz-import-count-total"]');
    await openPreflightTab(realPage);

    console.log("\n[A] Real file — final-plan classification (recalculated from the current implementation, not assumed):");
    const ready = await tileValue(realPage, "preflight-summary-ready");
    const blocked = await tileValue(realPage, "preflight-summary-blocked");
    const create = await tileValue(realPage, "preflight-summary-create");
    const update = await tileValue(realPage, "preflight-summary-update");
    const dup = await tileValue(realPage, "preflight-summary-duplicate");
    const cat = await tileValue(realPage, "preflight-summary-category");
    const coord = await tileValue(realPage, "preflight-summary-coordinate");
    const loc = await tileValue(realPage, "preflight-summary-location");
    const short = await tileValue(realPage, "preflight-summary-shortlink");
    const invalid = await tileValue(realPage, "preflight-summary-invalid");
    console.log(`    ready=${ready} blocked=${blocked} create=${create} update=${update} dup=${dup} cat=${cat} coord=${coord} loc=${loc} short=${short} invalid=${invalid}`);
    check(ready === 33, `ready === 33 (got ${ready})`);
    check(blocked === 87, `blocked === 87 (got ${blocked})`);
    check(ready + blocked === 120, `ready + blocked === 120 total rows (got ${ready + blocked})`);
    check(create === 33 && update === 0, `create=33, update=0 on a first import into an empty city (got create=${create}, update=${update})`);
    check(dup === 41, `duplicate-review reason code count === 41 (got ${dup})`);
    // 80, not 45: this schema's reason codes are per Section 1's explicit
    // instruction ("do not collapse different problems into one generic
    // needs-review... preserve all applicable reasons") — CATEGORY_REVIEW_
    // REQUIRED is attached to every row still missing a category REGARDLESS
    // of whether it's also duplicate-flagged, unlike the Data Quality tab's
    // own "Missing category" tile (which intentionally stays primary-bucket
    // scoped at 45, for a different, non-overlapping-counts purpose). 80 is
    // the true count of rows with Category=NA in the real file.
    check(cat === 80, `category-review reason code count === 80 (got ${cat}) — every row still missing a category, including the 35 that are ALSO duplicate-flagged`);
    check(coord === 1, `coordinate-review reason code count === 1 (got ${coord})`);
    check(invalid === 0, `invalid === 0 (got ${invalid})`);
    // 4, not the earlier Phase F.1 estimate of 3: recalculated precisely
    // against the real isGoogleMapsUrl() validator (per this phase's "do
    // not assume those numbers are still unchanged" instruction). Two rows
    // (67, 114) use a "https://share.google/..." link format that
    // isGoogleMapsUrl() doesn't recognize either, in addition to row 95's
    // already-known bare goo.gl/maps/ link and row 112's total absence of
    // any Maps Link — so all four have no STORED googleMapsUrl at all and
    // are correctly LOCATION_MISSING, not SHORT_MAPS_LINK_UNRESOLVED.
    check(loc === 4, `[M] location-missing (informational, non-blocking) === 4 rows with no stored location signal at all (got ${loc})`);
    check(short === 70, `[L] short-map-link (informational, non-blocking) === 70 rows (got ${short})`);

    console.log("\n[B] Multiple simultaneous block reasons are preserved, never collapsed:");
    const multiReasonRow = await realPage.locator('[data-testid="preflight-blocked-row"]').filter({ hasText: "Category review required" }).filter({ has: realPage.locator('[data-reason-code="DUPLICATE_REVIEW_REQUIRED"]') }).first();
    const multiReasonCount = await multiReasonRow.locator('[data-reason-code]').count();
    check(multiReasonCount >= 2, `at least one blocked row shows 2+ distinct reason codes at once (found a row with ${multiReasonCount})`);

    console.log("\n[Q][R] Preview/tab-switching performs zero writes:");
    const businessesStillZero = await getBusinesses(realPage);
    check(businessesStillZero.length === 0, "viewing the Preflight tab wrote nothing");

    console.log("\n[N][O] Write preview shows exact fields for CREATE rows:");
    const firstWriteRow = realPage.locator('[data-testid="preflight-write-row"][data-operation="CREATE"]').first();
    const fieldsWrittenText = await firstWriteRow.locator('[data-testid="preflight-fields-written"]').innerText();
    check(/name=/.test(fieldsWrittenText) && /category=/.test(fieldsWrittenText), "a CREATE row's write preview shows name= and category=");
    // notes/createdAt are NEVER importer-set, not even on create (createdAt
    // comes from the write timestamp itself, notes is Manager-only from
    // birth). active/capacityHoursPerDay DO legitimately appear here for a
    // CREATE — a brand-new business needs them initialized to the existing
    // safe default (see DEFAULT_IMPORTED_CAPACITY_HOURS_PER_DAY) — the
    // "never touch Manager-owned fields" rule is about re-import UPDATEs
    // never reverting a Manager's later edit, not about create-time
    // initialization (checked separately below, in the UPDATE preview).
    check(!/notes=|createdAt=/.test(fieldsWrittenText), "the CREATE write preview's fieldsWritten never lists notes= or createdAt= (never importer-set, even on create)");
    check(/active=true/.test(fieldsWrittenText) && /capacityHoursPerDay=3/.test(fieldsWrittenText), "a CREATE row's write preview does show active=true and capacityHoursPerDay=3 — the existing safe defaults for a brand-new business");

    console.log("\n[S] Confirm writes exactly the previewed Ready set:");
    const confirmationLine = await realPage.locator('[data-testid="biz-import-confirmation-summary"]').innerText();
    check(new RegExp(`${create}.*created`).test(confirmationLine) || confirmationLine.includes(String(create)), `the confirmation guard line names the create count (${create})`);
    await realPage.locator('[data-testid="biz-import-confirm"]').click();
    await realPage.waitForSelector('[data-testid="biz-import-result"]');
    const businessesAfterConfirm = await getBusinesses(realPage);
    check(businessesAfterConfirm.length === create, `[S] Confirm created exactly ${create} businesses (got ${businessesAfterConfirm.length})`);

    console.log("\n[T] Idempotent re-import: same file, same (empty) resolutions -> identical final plan shape:");
    await uploadBuffer(realPage, readFileSync(REAL_FILE), "Rajampet_Kadapa Converted Leads - Iliyas.xlsx");
    await realPage.waitForSelector('[data-testid="biz-import-count-total"]');
    await openPreflightTab(realPage);
    const reimportReady = await tileValue(realPage, "preflight-summary-ready");
    const reimportCreate = await tileValue(realPage, "preflight-summary-create");
    const reimportUpdate = await tileValue(realPage, "preflight-summary-update");
    // "Ready" in this schema means create+update combined (neither is
    // blocked) — it correctly STAYS at 33 across the re-import, which is
    // itself a useful idempotency signal (nothing fell out of Ready); the
    // real idempotency proof is create dropping to 0 and update rising to 33.
    check(reimportReady === 33, `[T] Ready (create+update) stays at 33 across the re-import — nothing was lost (got ${reimportReady})`);
    check(reimportCreate === 0, `[T] re-importing the identical file finds 0 NEW-create rows (got ${reimportCreate})`);
    check(reimportUpdate === create, `[T] every previously-created business is now recognized as an update (${reimportUpdate} === ${create})`);
    await realPage.locator('[data-testid="biz-import-tab-summary"]').click();
    await realPage.getByRole("button", { name: "Cancel" }).last().click();

    await realCtx.close();

    // ========================================================================
    // Synthetic: category resolution shows resolved vs raw, duplicate
    // keep-semantics reflected in preflight, coordinate provenance
    // ========================================================================
    console.log("\n[G] Category resolution: resolved value shown separately from the raw spreadsheet value:");
    const catCtx = await browser.newContext();
    const catPage = await catCtx.newPage();
    await seedManager(catPage, emptyCityData());
    await openImportTab(catPage);
    const catXlsx = await buildSyntheticXlsx([
      { "Business Code": "PF-001", "Business Name": "Cat Test Biz", Category: "NA" },
      { "Business Code": "PF-002", "Business Name": "Other Biz With Category", Category: "Automotive Services" },
    ]);
    await uploadBuffer(catPage, catXlsx, "cat.xlsx");
    await catPage.waitForSelector('[data-testid="biz-import-count-total"]');
    await catPage.locator('[data-testid="biz-import-tab-quality"]').click();
    await catPage.waitForSelector('[data-testid="biz-dq-panel"]');
    await catPage.locator('[data-testid="biz-dq-category-select"]').click();
    await catPage.locator('[role="option"]').first().click();
    await sleep(150);
    await openPreflightTab(catPage);
    // PF-002 ships with a real category already and is Ready regardless —
    // the precise claim here is about PF-001 specifically: resolving its
    // category makes IT Ready, checked by name rather than by total count
    // (which now legitimately includes PF-002 too).
    const resolvedCatRow = await catPage.locator('[data-testid="preflight-write-row"]').filter({ hasText: "Cat Test Biz" }).count();
    check(resolvedCatRow === 1, `[G] resolving the only category-missing row makes it Ready (got ${resolvedCatRow} matching write-preview rows)`);
    await catCtx.close();

    console.log("\n[C][D][E][F] Duplicate keep-semantics reflected in the Preflight reason codes and write preview:");
    const dupCtx = await browser.newContext();
    const dupPage = await dupCtx.newPage();
    await seedManager(dupPage, emptyCityData());
    await openImportTab(dupPage);
    const dupXlsx = await buildSyntheticXlsx([
      { "Business Code": "PF-010", "Business Name": "Keep A Pair", "Contact Phone": "9100000001", Category: "Automotive Services" },
      { "Business Code": "PF-011", "Business Name": "Keep A Pair", "Contact Phone": "9100000001", Category: "Automotive Services" },
      { "Business Code": "PF-012", "Business Name": "Keep Both Pair", "Contact Phone": "9100000002", Category: "Automotive Services" },
      { "Business Code": "PF-013", "Business Name": "Keep Both Pair", "Contact Phone": "9100000002", Category: "Automotive Services" },
      { "Business Code": "PF-014", "Business Name": "Untouched Pair", "Contact Phone": "9100000003", Category: "Automotive Services" },
      { "Business Code": "PF-015", "Business Name": "Untouched Pair", "Contact Phone": "9100000003", Category: "Automotive Services" },
    ]);
    await uploadBuffer(dupPage, dupXlsx, "dup.xlsx");
    await dupPage.waitForSelector('[data-testid="biz-import-count-total"]');
    await dupPage.locator('[data-testid="biz-import-tab-quality"]').click();
    await dupPage.waitForSelector('[data-testid="biz-dq-panel"]');
    // KEEP_A: cluster 1 (PF-010/PF-011) -> keep only PF-010
    await dupPage.locator('[data-testid="biz-dq-cluster"]').filter({ hasText: "PF-010" }).locator('[data-testid="biz-dq-cluster-keep-only"]').first().click();
    // KEEP_BOTH: cluster 2 (PF-012/PF-013)
    await dupPage.locator('[data-testid="biz-dq-cluster"]').filter({ hasText: "PF-012" }).locator('[data-testid="biz-dq-cluster-keep-all"]').click();
    // NEEDS_FURTHER_REVIEW: cluster 3 (PF-014/PF-015) left untouched (default)
    await sleep(150);
    await openPreflightTab(dupPage);
    const dupReady = await tileValue(dupPage, "preflight-summary-ready");
    check(dupReady === 3, `[C][D=implicit][E] "keep only A" (+1) and "keep both" (+2) => 3 ready, "needs further review" pair stays blocked (got ${dupReady})`);
    const excludedRow = dupPage.locator('[data-testid="preflight-blocked-row"]').filter({ hasText: "PF-011" });
    check(/Excluded/i.test(await excludedRow.innerText()), "[C] the un-kept half of the KEEP_A pair (PF-011) is shown as explicitly Excluded, not just 'needs review'");
    const untouchedRow = dupPage.locator('[data-testid="preflight-blocked-row"]').filter({ hasText: "PF-014" });
    check(/Duplicate review required/i.test(await untouchedRow.innerText()), "[F] the untouched pair still carries DUPLICATE_REVIEW_REQUIRED — both rows genuinely blocked");
    await dupCtx.close();

    console.log("\n[H][I][J][K] Coordinate resolution provenance (locationSource) — spreadsheet vs Maps vs unresolved:");
    const coordCtx = await browser.newContext();
    const coordPage = await coordCtx.newPage();
    await seedManager(coordPage, emptyCityData());
    await openImportTab(coordPage);
    // PF-020 and PF-021 each need their OWN independent spreadsheet-vs-Maps
    // mismatch — giving them the identical Maps Link + identical lat/lng (as
    // an earlier draft of this fixture did) makes the duplicate detector
    // (Maps Link signal + Coordinates signal, businessImport.ts's
    // flagGroupDuplicates) flag them as duplicates of EACH OTHER, which
    // overrides their decision to "duplicate_review" and hides them from
    // the Data Quality coordinate-conflict list entirely. Distinct values
    // on both rows keep the two conflicts independent.
    const coordXlsx = await buildSyntheticXlsx([
      { "Business Code": "PF-020", "Business Name": "Use Spreadsheet Coords", Category: "Automotive Services", Latitude: "14.19", Longitude: "79.16", "Maps Link": "https://www.google.com/maps?q=15.50,80.50" },
      { "Business Code": "PF-021", "Business Name": "Use Maps Coords", Category: "Automotive Services", Latitude: "16.00", Longitude: "81.00", "Maps Link": "https://www.google.com/maps?q=17.30,82.30" },
      { "Business Code": "PF-022", "Business Name": "Explicit Plus Short Link", Category: "Automotive Services", Latitude: "14.20", Longitude: "79.17", "Maps Link": "https://maps.app.goo.gl/ZzYyXxWwVvUuTt" },
    ]);
    await uploadBuffer(coordPage, coordXlsx, "coord.xlsx");
    await coordPage.waitForSelector('[data-testid="biz-import-count-total"]');
    await coordPage.locator('[data-testid="biz-import-tab-quality"]').click();
    await coordPage.waitForSelector('[data-testid="biz-dq-panel"]');
    const coordRowLocator = coordPage.locator('[data-testid="biz-dq-coord-row"]');
    const coordRowCount = await coordRowLocator.count();
    check(coordRowCount === 2, `[H][I] two rows have a genuine spreadsheet-vs-Maps mismatch (got ${coordRowCount})`);
    // The coordinate-conflict list is scoped to still-unresolved rows (an
    // existing, unchanged Phase F.2 behavior — see BusinessDataQuality.tsx's
    // coordConflictRows filter on decision === "needs_review"), so resolving
    // PF-020 removes it from the list and shifts PF-021 to index 0. Filter
    // by Business Code each time rather than using a captured index/array,
    // so each click targets the intended row regardless of list reflow.
    await coordRowLocator.filter({ hasText: "PF-020" }).locator('[data-testid="biz-dq-coord-spreadsheet"]').click();
    await coordRowLocator.filter({ hasText: "PF-021" }).locator('[data-testid="biz-dq-coord-mapslink"]').click();
    await sleep(150);
    await openPreflightTab(coordPage);
    const useSpreadsheetRow = coordPage.locator('[data-testid="preflight-write-row"]').filter({ hasText: "Use Spreadsheet Coords" });
    const useMapsRow = coordPage.locator('[data-testid="preflight-write-row"]').filter({ hasText: "Use Maps Coords" });
    check((await useSpreadsheetRow.count()) === 1, "[H] the spreadsheet-coordinate row is Ready");
    check((await useMapsRow.count()) === 1, "[I] the Maps-coordinate row is Ready");
    const spreadsheetFields = await useSpreadsheetRow.locator('[data-testid="preflight-fields-written"]').innerText();
    const mapsFields = await useMapsRow.locator('[data-testid="preflight-fields-written"]').innerText();
    check(/lat=14\.19/.test(spreadsheetFields), "[H] the spreadsheet-choice row writes the spreadsheet's own lat (14.19), not the Maps Link's");
    check(/lat=17\.3/.test(mapsFields), "[I] the Maps-choice row writes the Maps Link's lat (17.3), overriding the spreadsheet's (16.0)");
    // [K] explicit coordinates + an (unrelated) short link: the row is still
    // Ready off its own explicit lat/lng, and the short link is purely
    // informational — never blocks it.
    const explicitPlusShortRow = coordPage.locator('[data-testid="preflight-write-row"]').filter({ hasText: "Explicit Plus Short Link" });
    check((await explicitPlusShortRow.count()) === 1, "[K] a row with explicit valid coordinates is Ready even though its Maps Link is an unresolved short link");
    await coordCtx.close();

    // ========================================================================
    // [P] Existing Manager-owned field preservation surfaced in write preview
    // ========================================================================
    console.log("\n[P] UPDATE write preview lists preserved Manager-owned fields, and never overwrites them:");
    const updateCtx = await browser.newContext();
    const updatePage = await updateCtx.newPage();
    const existingBiz = {
      id: "biz_import_pf-030",
      name: "Old Name",
      category: "Old Category",
      area: "Old Area",
      address: "",
      active: false,
      capacityHoursPerDay: 7,
      notes: "Manager note",
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    await seedManager(updatePage, emptyCityData({ businesses: [existingBiz] }));
    await openImportTab(updatePage);
    const updateXlsx = await buildSyntheticXlsx([{ "Business Code": "PF-030", "Business Name": "New Name", Category: "Metal Fabrication" }]);
    await uploadBuffer(updatePage, updateXlsx, "update.xlsx");
    await updatePage.waitForSelector('[data-testid="biz-import-count-total"]');
    await openPreflightTab(updatePage);
    const updateRow = updatePage.locator('[data-testid="preflight-write-row"][data-operation="UPDATE"]');
    check((await updateRow.count()) === 1, "[O] the matching row is classified UPDATE");
    const preservedText = await updateRow.locator('[data-testid="preflight-fields-preserved"]').innerText();
    check(/active/.test(preservedText) && /notes/.test(preservedText) && /createdAt/.test(preservedText) && /capacityHoursPerDay/.test(preservedText), "[P] fieldsPreserved explicitly lists active/notes/createdAt/capacityHoursPerDay");
    await updatePage.locator('[data-testid="biz-import-confirm"]').click();
    await updatePage.waitForSelector('[data-testid="biz-import-result"]');
    const [updatedBiz] = await getBusinesses(updatePage);
    check(updatedBiz.name === "New Name" && updatedBiz.active === false && updatedBiz.notes === "Manager note" && updatedBiz.capacityHoursPerDay === 7, "[P] the actual write matched the preview: name updated, Manager-owned fields untouched");
    await updateCtx.close();

    // ========================================================================
    // [U][V] Security
    // ========================================================================
    console.log("\n[U][V] Manager-only: an FO cannot reach Settings or see the Preflight UI:");
    const foCtx = await browser.newContext();
    const foPage = await foCtx.newPage();
    await foPage.goto(`${BASE_URL}/login`);
    await foPage.evaluate(() => {
      const now = new Date().toISOString();
      const cityData = {
        version: 2,
        settings: { cityName: "FO Preflight Denied", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
        businesses: [],
        fos: [{ id: "fo_pf_denied", name: "Denied FO", active: true, createdAt: now }],
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
      localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-fo-pf-denied", email: "denied.fo.pf@demo.city-ops", role: "FIELD_OFFICER", displayName: "Denied FO", foId: "fo_pf_denied", createdAt: now }));
    });
    await foPage.goto(`${BASE_URL}/settings?tab=data`);
    await sleep(500);
    check(!foPage.url().includes("/settings"), `[U][V] an FO navigating to /settings?tab=data is redirected away (ended at ${foPage.url()})`);
    check((await foPage.locator('[data-testid="biz-preflight-panel"]').count()) === 0, "[V] the Preflight panel never renders for an FO");
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
