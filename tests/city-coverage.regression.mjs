// Regression test for City Coverage — Phase B ("engine + map skeleton") and
// Phase C ("operational layers"): src/engine/cityCoverage.ts's
// mappableBusinesses()/projectPoints()/deriveBusinessStatus()/
// foLastKnownLocations()/formatLocationAge() and src/lib/googleMaps.ts's
// parseCoordinatesFromMapsUrl()/resolveBusinessCoordinates(), as consumed
// by the Manager-only src/pages/CityCoverage.tsx.
//
// Route-level Manager-only gating for /city-coverage is covered by
// tests/route-security.regression.mjs (extended to include it), not
// duplicated here.
//
// Run with: npm run test:city-coverage

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";

const PORT = 4198;
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

async function main() {
  // ====================================================================
  console.log("[0] STATIC CHECK: City Coverage source never READS a spreadsheet-only field (comments that merely name them, to document what's deliberately NOT used, don't count):");
  const sourceFiles = ["src/engine/cityCoverage.ts", "src/pages/CityCoverage.tsx", "src/lib/googleMaps.ts"];
  // camelCase identifiers only — the actual shape a real property access
  // (business.riskScore, data.riskScore, etc.) or destructure would take.
  // The human-readable phrases ("Risk Score", "Suggested Category", ...)
  // are expected to appear in this codebase's own explanatory comments
  // disclaiming their use, so only the identifier form is checked.
  const FORBIDDEN_IDENTIFIERS = ["riskScore", "workersDeclared", "workersPhotographed", "suggestedCategory", "outcome", "verificationStatus"];
  function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }
  for (const file of sourceFiles) {
    const codeOnly = stripComments(readFileSync(file, "utf8"));
    for (const identifier of FORBIDDEN_IDENTIFIERS) {
      const re = new RegExp(`\\b${identifier}\\b`);
      check(!re.test(codeOnly), `[6] ${file}'s actual code (comments excluded) never reads a "${identifier}" field`);
    }
  }

  console.log("\nBuilding production bundle...");
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

    const today = new Date().toISOString().slice(0, 10);
    const iso = (h) => `${today}T${String(h).padStart(2, "0")}:00:00.000Z`;
    const now = new Date().toISOString();

    function mkAssignment(overrides) {
      return {
        id: overrides.id,
        date: today,
        businessId: overrides.businessId,
        foId: overrides.foId ?? "fo_main",
        rigId: overrides.rigId,
        plannedStart: overrides.plannedStart ?? iso(9),
        plannedEnd: overrides.plannedEnd ?? iso(19),
        priority: "normal",
        status: overrides.status ?? "confirmed",
        reviewStatus: overrides.reviewStatus,
        createdAt: now,
      };
    }

    // ------------------------------------------------------------------
    // Businesses covering every coordinate-resolution path (Phase B) and
    // every deriveBusinessStatus() branch (Phase C).
    const businesses = [
      { id: "biz_latlng", name: "Latlng Biz", category: "General", area: "Area", address: "", lat: 14.19, lng: 79.16, capacityHoursPerDay: 10, active: true, createdAt: now },
      { id: "biz_mapsurl", name: "Mapsurl Biz", category: "General", area: "Area", address: "", googleMapsUrl: "https://www.google.com/maps?q=14.20,79.17", capacityHoursPerDay: 10, active: true, createdAt: now },
      { id: "biz_atshape", name: "Atshape Biz", category: "General", area: "Area", address: "", googleMapsUrl: "https://www.google.com/maps/place/Some+Place/@14.21,79.18,17z", capacityHoursPerDay: 10, active: true, createdAt: now },
      { id: "biz_shortlink", name: "Shortlink Biz", category: "General", area: "Area", address: "", googleMapsUrl: "https://maps.app.goo.gl/abc123XYZ", capacityHoursPerDay: 10, active: true, createdAt: now },
      { id: "biz_nolocation", name: "Nolocation Biz", category: "General", area: "Area", address: "", capacityHoursPerDay: 10, active: true, createdAt: now },

      { id: "biz_assigned", name: "Assigned Biz", category: "General", area: "Area", address: "", lat: 14.22, lng: 79.19, capacityHoursPerDay: 10, active: true, createdAt: now },
      { id: "biz_completed", name: "Completed Biz", category: "General", area: "Area", address: "", lat: 14.23, lng: 79.20, capacityHoursPerDay: 10, active: true, createdAt: now },
      { id: "biz_at_risk_hours", name: "AtRiskHours Biz", category: "General", area: "Area", address: "", lat: 14.24, lng: 79.21, capacityHoursPerDay: 10, active: true, createdAt: now },
      { id: "biz_at_risk_recheck", name: "AtRiskRecheck Biz", category: "General", area: "Area", address: "", lat: 14.25, lng: 79.22, capacityHoursPerDay: 10, active: true, createdAt: now },
      { id: "biz_at_risk_issue", name: "AtRiskIssue Biz", category: "General", area: "Area", address: "", lat: 14.26, lng: 79.23, capacityHoursPerDay: 10, active: true, createdAt: now },
      { id: "biz_unavailable_rejected", name: "Rejected Biz", category: "General", area: "Area", address: "", lat: 14.27, lng: 79.24, capacityHoursPerDay: 10, active: true, createdAt: now },
      { id: "biz_unavailable_noshow", name: "NoShow Biz", category: "General", area: "Area", address: "", lat: 14.28, lng: 79.25, capacityHoursPerDay: 10, active: true, createdAt: now },
      { id: "biz_unavailable_inactive", name: "Inactive Biz", category: "General", area: "Area", address: "", lat: 14.29, lng: 79.26, capacityHoursPerDay: 10, active: false, createdAt: now },
      { id: "biz_unassigned", name: "Unassigned Biz", category: "General", area: "Area", address: "", lat: 14.30, lng: 79.27, capacityHoursPerDay: 10, active: true, createdAt: now },
      { id: "biz_partial_reject", name: "PartialReject Biz", category: "General", area: "Area", address: "", lat: 14.31, lng: 79.28, capacityHoursPerDay: 10, active: true, createdAt: now },
      { id: "biz_four_rig", name: "FourRig Biz", category: "General", area: "Area", address: "", lat: 14.32, lng: 79.29, capacityHoursPerDay: 10, active: true, createdAt: now },
    ];

    const fos = [
      { id: "fo_main", name: "Main FO", active: true, createdAt: now },
      { id: "fo_alpha", name: "Alpha FO", active: true, createdAt: now },
      { id: "fo_beta", name: "Beta FO", active: true, createdAt: now },
      { id: "fo_gamma", name: "Gamma FO", active: true, createdAt: now },
    ];

    const assignments = [
      mkAssignment({ id: "asg_assigned", businessId: "biz_assigned", rigId: "rig_a", status: "confirmed" }),
      mkAssignment({ id: "asg_completed", businessId: "biz_completed", rigId: "rig_b", status: "completed" }),
      mkAssignment({ id: "asg_at_risk_hours", businessId: "biz_at_risk_hours", rigId: "rig_c", status: "completed" }),
      mkAssignment({ id: "asg_at_risk_recheck", businessId: "biz_at_risk_recheck", rigId: "rig_d", status: "completed", reviewStatus: "recheck_requested" }),
      mkAssignment({ id: "asg_at_risk_issue", businessId: "biz_at_risk_issue", rigId: "rig_e", status: "in_progress" }),
      mkAssignment({ id: "asg_rejected", businessId: "biz_unavailable_rejected", rigId: "rig_f", status: "rejected" }),
      mkAssignment({ id: "asg_noshow", businessId: "biz_unavailable_noshow", rigId: "rig_g", status: "no_show" }),
      // biz_unavailable_inactive: deliberately NO assignment — inactive flag alone must be enough
      // biz_unassigned: deliberately NO assignment
      mkAssignment({ id: "asg_partial_1", businessId: "biz_partial_reject", rigId: "rig_h1", status: "rejected" }),
      mkAssignment({ id: "asg_partial_2", businessId: "biz_partial_reject", rigId: "rig_h2", status: "confirmed" }),
      mkAssignment({ id: "asg_4rig_1", businessId: "biz_four_rig", rigId: "rig_4a", status: "confirmed" }),
      mkAssignment({ id: "asg_4rig_2", businessId: "biz_four_rig", rigId: "rig_4b", status: "confirmed" }),
      mkAssignment({ id: "asg_4rig_3", businessId: "biz_four_rig", rigId: "rig_4c", status: "confirmed" }),
      mkAssignment({ id: "asg_4rig_4", businessId: "biz_four_rig", rigId: "rig_4d", status: "confirmed" }),
    ];

    const sessions = [
      // biz_completed: a full 10h+ session -> recordedHours >= targetHours(10h) -> COMPLETED
      { id: "session_completed", assignmentId: "asg_completed", businessId: "biz_completed", foId: "fo_main", rigId: "rig_b", date: today, startedAt: iso(9), endedAt: iso(19), plannedDurationMin: 600, status: "completed", batteryPct: 90, storagePct: 10, signal: "healthy", createdAt: now },
      // biz_at_risk_hours: deliberately NO session -> recordedHours=0 < target(10h) -> AT_RISK
    ];

    const issues = [
      { id: "issue_rig_failure", type: "rig_failure", severity: "critical", title: "Rig failure", description: "Rig failed mid-recording.", businessId: "biz_at_risk_issue", foId: "fo_main", status: "open", createdAt: now },
    ];

    const rigs = ["rig_a", "rig_b", "rig_c", "rig_d", "rig_e", "rig_f", "rig_g", "rig_h1", "rig_h2", "rig_4a", "rig_4b", "rig_4c", "rig_4d"].map((id) => ({
      id,
      code: id.toUpperCase(),
      model: "Test Rig",
      active: true,
      batteryPct: 100,
      storagePct: 0,
      deploymentStatus: "active",
      createdAt: now,
    }));

    // ------------------------------------------------------------------
    // FO last-known-location evidence: fo_alpha has an older + a newer
    // valid record (newer must win); fo_beta has only an OUT-OF-RANGE
    // coordinate (must be treated as no valid location); fo_gamma has no
    // evidence at all.
    const olderCapturedAt = new Date(Date.now() - 3 * 3_600_000).toISOString(); // 3h ago
    const newerCapturedAt = new Date(Date.now() - 18 * 60_000).toISOString(); // 18 min ago
    const evidence = [
      { id: "ev_alpha_old", assignmentId: "asg_assigned", businessId: "biz_assigned", foId: "fo_alpha", type: "ARRIVAL", startedAt: olderCapturedAt, capturedAt: olderCapturedAt, lat: 14.10, lng: 79.10, files: [], status: "submitted", createdAt: now },
      { id: "ev_alpha_new", assignmentId: "asg_completed", businessId: "biz_completed", foId: "fo_alpha", type: "LOCATION", startedAt: newerCapturedAt, capturedAt: newerCapturedAt, lat: 14.23, lng: 79.20, files: [], status: "submitted", createdAt: now },
      { id: "ev_beta_invalid", assignmentId: "asg_at_risk_hours", businessId: "biz_at_risk_hours", foId: "fo_beta", type: "LOCATION", startedAt: now, capturedAt: now, lat: 999, lng: 79.21, files: [], status: "submitted", createdAt: now },
      // fo_gamma: no evidence at all
    ];

    const cityData = {
      version: 2,
      settings: { cityName: "Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
      businesses,
      fos,
      collectors: [],
      rigs,
      assignments,
      sessions,
      evidence,
      issues,
      qualityReviews: [],
      correctiveActions: [],
      rigIncidents: [],
      repairRecords: [],
      activity: [],
      plans: [],
      reports: [],
    };

    console.log("\n[1-6] City Coverage map: coordinate resolution, marker rendering, and Manager access:");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (err) => console.error("  [page error]", err.message));
    await page.goto(`${BASE_URL}/login`);
    await page.evaluate((cityData) => {
      localStorage.setItem("city-ops-os", JSON.stringify({ state: cityData, version: 2 }));
      localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-manager", email: "manager@demo.city-ops", role: "MANAGER", displayName: "Demo Manager", createdAt: new Date().toISOString() }));
    }, cityData);
    await page.goto(`${BASE_URL}/city-coverage`);
    await page.waitForSelector("h1:has-text(\"City Coverage\")", { timeout: 15000 });
    await sleep(600);

    check(page.url().endsWith("/city-coverage"), "[19] Manager reaches /city-coverage directly without being redirected");

    const businessMarkerIds = await page.locator('[data-testid="city-coverage-business-marker"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-business-id")));
    check(businessMarkerIds.includes("biz_latlng"), "[1] business with real Business.lat/lng gets a marker");
    check(businessMarkerIds.includes("biz_mapsurl"), "[2] business with only a literal-coordinate 'q=lat,lng' Maps URL gets a marker");
    check(businessMarkerIds.includes("biz_atshape"), "[3] business with a literal-coordinate '@lat,lng,zoom' Maps URL gets a marker");
    check(!businessMarkerIds.includes("biz_shortlink"), "[5] business with only a maps.app.goo.gl short link (invalid/unparseable) gets NO marker — never resolved/geocoded");
    check(!businessMarkerIds.includes("biz_nolocation"), "[5] business with no location info at all gets NO marker");

    const coordSources = await page
      .locator('[data-testid="city-coverage-business-marker"]')
      .evaluateAll((els) => Object.fromEntries(els.map((el) => [el.getAttribute("data-business-id"), el.getAttribute("data-coord-source")])));
    check(coordSources["biz_latlng"] === "business", "[1] biz_latlng's marker is sourced from Business.lat/lng directly");
    check(coordSources["biz_mapsurl"] === "maps_url", "[2] biz_mapsurl's marker is sourced from the parsed googleMapsUrl");

    const bodyText = await page.evaluate(() => document.body.innerText);
    check(bodyText.includes("Missing Location"), "[5] the 'Missing Location' KPI is present and honest about omitted businesses");

    console.log("\n[7-9] Business status derivation, multi-rig independence, target-hours = rigs x 10:");
    const statusByBiz = await page
      .locator('[data-testid="city-coverage-business-marker"]')
      .evaluateAll((els) => Object.fromEntries(els.map((el) => [el.getAttribute("data-business-id"), el.getAttribute("data-status")])));
    check(statusByBiz["biz_assigned"] === "assigned", `biz_assigned derives status 'assigned' (got '${statusByBiz["biz_assigned"]}')`);
    check(statusByBiz["biz_completed"] === "completed", `biz_completed (10h+ recorded of 10h target) derives status 'completed' (got '${statusByBiz["biz_completed"]}')`);
    check(statusByBiz["biz_at_risk_hours"] === "at_risk", `biz_at_risk_hours (0h recorded of 10h target, assignment completed) derives status 'at_risk' (got '${statusByBiz["biz_at_risk_hours"]}')`);
    check(statusByBiz["biz_at_risk_recheck"] === "at_risk", `biz_at_risk_recheck (reviewStatus=recheck_requested) derives status 'at_risk' (got '${statusByBiz["biz_at_risk_recheck"]}')`);
    check(statusByBiz["biz_at_risk_issue"] === "at_risk", `biz_at_risk_issue (open rig_failure issue) derives status 'at_risk' (got '${statusByBiz["biz_at_risk_issue"]}')`);
    check(statusByBiz["biz_unavailable_rejected"] === "unavailable", `biz_unavailable_rejected derives status 'unavailable' (got '${statusByBiz["biz_unavailable_rejected"]}')`);
    check(statusByBiz["biz_unavailable_noshow"] === "unavailable", `biz_unavailable_noshow derives status 'unavailable' (got '${statusByBiz["biz_unavailable_noshow"]}')`);
    check(statusByBiz["biz_unavailable_inactive"] === "unavailable", `[6] biz_unavailable_inactive (Business.active=false, no spreadsheet field used) derives status 'unavailable' (got '${statusByBiz["biz_unavailable_inactive"]}')`);
    check(statusByBiz["biz_unassigned"] === "unassigned", `biz_unassigned (zero assignments today) derives status 'unassigned' (got '${statusByBiz["biz_unassigned"]}')`);
    check(statusByBiz["biz_partial_reject"] === "at_risk", `[7] biz_partial_reject (1 of 2 assignments rejected, other still active) derives status 'at_risk', not 'unavailable' — the healthy assignment isn't collapsed into the rejected one (got '${statusByBiz["biz_partial_reject"]}')`);
    check(statusByBiz["biz_four_rig"] === "assigned", `biz_four_rig (4 independent confirmed assignments) derives status 'assigned' (got '${statusByBiz["biz_four_rig"]}')`);

    console.log("\n  Verifying the partial-reject business's OTHER assignment is untouched (independence, not merged):");
    const partialAssignments = await page.evaluate(() => JSON.parse(localStorage.getItem("city-ops-os")).state.assignments.filter((a) => a.businessId === "biz_partial_reject"));
    check(partialAssignments.length === 2, "[7] biz_partial_reject still has exactly 2 independent Assignment records (never merged into one)");
    check(partialAssignments.find((a) => a.id === "asg_partial_1").status === "rejected", "[7] asg_partial_1 keeps its own 'rejected' status");
    check(partialAssignments.find((a) => a.id === "asg_partial_2").status === "confirmed", "[7] asg_partial_2 keeps its own 'confirmed' status, unaffected by its sibling's rejection");

    console.log("\n  Clicking the four-rig business's marker to verify targetHours = rigs x 10 in the detail panel:");
    await page.locator('[data-testid="city-coverage-business-marker"][data-business-id="biz_four_rig"]').click();
    await sleep(300);
    const fourRigDetailText = await page.locator('[data-testid="city-coverage-business-detail"]').innerText();
    check(fourRigDetailText.includes("40h") || /Target hours[\s\S]{0,30}40/.test(fourRigDetailText), `[8] Four Rig Biz's detail panel shows target hours = 4 rigs x 10h = 40h — got: ${fourRigDetailText.slice(0, 200)}`);
    check(fourRigDetailText.includes("FourRig Biz"), "[9] the correct business (FourRig Biz) is shown in the detail panel, distinct from any other business");

    console.log("\n[10-13] FO last-known-location: latest-wins, invalid coordinates rejected, explicit 'last known' framing:");
    const foMarkerIds = await page.locator('[data-testid="city-coverage-fo-marker"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-fo-id")));
    check(foMarkerIds.includes("fo_alpha"), "fo_alpha (has valid location evidence) gets a marker");
    check(!foMarkerIds.includes("fo_beta"), "[12] fo_beta (only an out-of-range/invalid coordinate) gets NO fabricated marker");
    check(!foMarkerIds.includes("fo_gamma"), "[12] fo_gamma (no location evidence at all) gets NO fabricated marker");
    check(!foMarkerIds.includes("fo_main"), "fo_main (no LOCATION-bearing evidence in this fixture) gets no marker either — never invented");

    await page.locator('[data-testid="city-coverage-fo-marker"][data-fo-id="fo_alpha"]').click();
    await sleep(300);
    const foDetailText = await page.locator('[data-testid="city-coverage-fo-detail"]').innerText();
    check(/Last known location/i.test(foDetailText), "[13] the FO detail panel explicitly says 'Last known location'");
    check(!/\blive\b/i.test(foDetailText) && !/current location/i.test(foDetailText) && !/tracking/i.test(foDetailText), "[13] the FO detail panel never implies live GPS tracking (no 'live'/'current location'/'tracking' wording)");
    check(foDetailText.includes("Completed Biz"), `[10] fo_alpha's marker reflects the NEWER evidence (captured near Completed Biz), not the older one near Assigned Biz — got: ${foDetailText.slice(0, 200)}`);
    check(!foDetailText.includes("Assigned Biz"), "[11] fo_alpha's older evidence (near Assigned Biz) did NOT override the newer one");

    console.log("\n[14-15] Business and FO markers are visually distinguishable, and status is not color-alone:");
    const businessMarkerTag = await page.locator('[data-testid="city-coverage-business-marker"] circle').first().evaluate((el) => el.tagName.toLowerCase());
    const foMarkerTag = await page.locator('[data-testid="city-coverage-fo-marker"] rect').first().evaluate((el) => el.tagName.toLowerCase());
    check(businessMarkerTag === "circle", "[14] business markers render as circles");
    check(foMarkerTag === "rect", "[14] FO markers render as a distinct shape (rotated square), not a circle — never ambiguous with a business marker");
    const ariaLabels = await page.locator('[data-testid="city-coverage-business-marker"]').evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
    check(ariaLabels.every((l) => l && /—/.test(l)), "[15] every business marker carries an accessible text label naming its status (aria-label), not color alone");
    check(await page.locator('[data-testid="city-coverage-legend"]').isVisible(), "[15] a text legend mapping color to status label is present");

    console.log("\n[24] No assignment mutation occurs from City Coverage (pure read-only page):");
    const assignmentsBefore = JSON.stringify([...assignments].sort((a, b) => a.id.localeCompare(b.id)));
    // Exercise filters, layer toggles, and marker selection — none of these should touch store data.
    await page.locator('button:has-text("At Risk")').first().click();
    await sleep(200);
    await page.locator('[data-testid="toggle-fo-layer"]').click();
    await sleep(200);
    await page.locator('[data-testid="toggle-fo-layer"]').click();
    await sleep(200);
    await page.locator('button:has-text("All")').first().click();
    await sleep(200);
    const assignmentsAfter = await page.evaluate(() => JSON.stringify([...JSON.parse(localStorage.getItem("city-ops-os")).state.assignments].sort((a, b) => a.id.localeCompare(b.id))));
    check(assignmentsBefore === assignmentsAfter, "[24] every Assignment record is byte-for-byte unchanged after browsing City Coverage — no mutation path exists on this page");

    await context.close();

    console.log("\n[16-18] Light theme, mobile viewports (375/390/412), no horizontal overflow:");
    for (const [w, h] of [[375, 812], [390, 844], [412, 915]]) {
      const mobileContext = await browser.newContext({ viewport: { width: w, height: h } });
      const mobilePage = await mobileContext.newPage();
      mobilePage.on("pageerror", (err) => console.error("  [page error]", err.message));
      await mobilePage.goto(`${BASE_URL}/login`);
      await mobilePage.evaluate((cityData) => {
        const withLightTheme = { ...cityData, settings: { ...cityData.settings, theme: "light" } };
        localStorage.setItem("city-ops-os", JSON.stringify({ state: withLightTheme, version: 2 }));
        localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-manager", email: "manager@demo.city-ops", role: "MANAGER", displayName: "Demo Manager", createdAt: new Date().toISOString() }));
      }, cityData);
      await mobilePage.goto(`${BASE_URL}/city-coverage`);
      await mobilePage.waitForSelector("h1:has-text(\"City Coverage\")", { timeout: 15000 });
      await sleep(500);
      const overflow = await mobilePage.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
      check(overflow.scrollWidth <= overflow.clientWidth + 1, `[18] at ${w}x${h}: no horizontal overflow (scrollWidth ${overflow.scrollWidth} <= clientWidth ${overflow.clientWidth})`);
      const isDark = await mobilePage.evaluate(() => document.documentElement.classList.contains("dark"));
      check(!isDark, `[16] at ${w}x${h}: light theme applied (no 'dark' class)`);
      const markerCount = await mobilePage.locator('[data-testid="city-coverage-business-marker"]').count();
      check(markerCount > 0, `[16] at ${w}x${h}: business markers still render in light theme on mobile (got ${markerCount})`);
      await mobileContext.close();
    }

    console.log("\n[17] Dark theme:");
    const darkContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const darkPage = await darkContext.newPage();
    darkPage.on("pageerror", (err) => console.error("  [page error]", err.message));
    await darkPage.goto(`${BASE_URL}/login`);
    await darkPage.evaluate((cityData) => {
      localStorage.setItem("city-ops-os", JSON.stringify({ state: cityData, version: 2 }));
      localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-manager", email: "manager@demo.city-ops", role: "MANAGER", displayName: "Demo Manager", createdAt: new Date().toISOString() }));
    }, cityData);
    await darkPage.goto(`${BASE_URL}/city-coverage`);
    await darkPage.waitForSelector("h1:has-text(\"City Coverage\")", { timeout: 15000 });
    await sleep(500);
    check(await darkPage.evaluate(() => document.documentElement.classList.contains("dark")), "[17] dark theme applied");
    check((await darkPage.locator('[data-testid="city-coverage-business-marker"]').count()) > 0, "[17] business markers render correctly in dark theme");
    await darkContext.close();

    console.log("\n[20-23] Existing regressions remain green (run separately via package.json scripts — see final report). Empty-state sanity here:");
    const emptyContext = await browser.newContext();
    const emptyPage = await emptyContext.newPage();
    emptyPage.on("pageerror", (err) => console.error("  [page error]", err.message));
    await emptyPage.goto(`${BASE_URL}/login`);
    await emptyPage.evaluate((cityData) => {
      localStorage.setItem("city-ops-os", JSON.stringify({ state: { ...cityData, businesses: [], fos: [], evidence: [] }, version: 2 }));
      localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-manager", email: "manager@demo.city-ops", role: "MANAGER", displayName: "Demo Manager", createdAt: new Date().toISOString() }));
    }, cityData);
    await emptyPage.goto(`${BASE_URL}/city-coverage`);
    await emptyPage.waitForSelector("h1:has-text(\"City Coverage\")", { timeout: 15000 });
    await sleep(500);
    check((await emptyPage.locator('[data-testid="city-coverage-business-marker"]').count()) === 0, "zero markers rendered when there are no businesses at all");
    check(await emptyPage.locator("text=Nothing to show on the map").isVisible(), "the empty state is shown, not a blank or broken map");
    await emptyContext.close();

    if (failures > 0) console.error("\n--- preview server output (for debugging) ---\n" + serverOutput.slice(-4000));
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
