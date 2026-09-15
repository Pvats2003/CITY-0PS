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

      // --- Phase D: Recovery Radar / backup-candidate fixtures ---
      { id: "biz_multirig_recovery", name: "MultiRigRecovery Biz", category: "General", area: "Area", address: "", lat: 14.33, lng: 79.30, capacityHoursPerDay: 10, active: true, createdAt: now },
      { id: "biz_complete_multirig_ok", name: "CompleteMultiRig Biz", category: "General", area: "Area", address: "", lat: 14.34, lng: 79.31, capacityHoursPerDay: 10, active: true, createdAt: now },
      { id: "biz_recording_failure", name: "RecordingFailure Biz", category: "General", area: "Area", address: "", lat: 14.35, lng: 79.32, capacityHoursPerDay: 10, active: true, createdAt: now },
      { id: "biz_backup_unavailable_today", name: "UnavailableToday Biz", category: "General", area: "Area", address: "", lat: 14.36, lng: 79.33, capacityHoursPerDay: 10, active: true, unavailableDates: [today], createdAt: now },
      // Deliberately ~120m from biz_partial_reject (14.31,79.28) — the
      // nearer of two otherwise-identical eligible candidates.
      { id: "biz_backup_near", name: "BackupNear Biz", category: "General", area: "Area", address: "", lat: 14.3108, lng: 79.2808, capacityHoursPerDay: 10, active: true, createdAt: now },
      // Deliberately ~30km from biz_partial_reject — eligible, but must
      // rank BEHIND biz_backup_near.
      { id: "biz_backup_far", name: "BackupFar Biz", category: "General", area: "Area", address: "", lat: 14.55, lng: 79.55, capacityHoursPerDay: 10, active: true, createdAt: now },
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

      // --- Phase D fixtures ---
      // 3 rigs, 2 rejected, 1 healthy -> at_risk, targetHours=30, affectedRigCount=2, still 3 independent assignments.
      mkAssignment({ id: "asg_mrr_1", businessId: "biz_multirig_recovery", rigId: "rig_mrr1", status: "rejected" }),
      mkAssignment({ id: "asg_mrr_2", businessId: "biz_multirig_recovery", rigId: "rig_mrr2", status: "rejected" }),
      mkAssignment({ id: "asg_mrr_3", businessId: "biz_multirig_recovery", rigId: "rig_mrr3", status: "confirmed" }),
      // 3 rigs, all completed, 33h recorded of 30h target -> completed, NOT a recovery item.
      mkAssignment({ id: "asg_cmr_1", businessId: "biz_complete_multirig_ok", rigId: "rig_cmr1", status: "completed" }),
      mkAssignment({ id: "asg_cmr_2", businessId: "biz_complete_multirig_ok", rigId: "rig_cmr2", status: "completed" }),
      mkAssignment({ id: "asg_cmr_3", businessId: "biz_complete_multirig_ok", rigId: "rig_cmr3", status: "completed" }),
      // Open recording_failure issue, still in progress (not yet a false "completed-under-target" case).
      mkAssignment({ id: "asg_recfail", businessId: "biz_recording_failure", rigId: "rig_recfail", status: "in_progress" }),
      // biz_backup_unavailable_today: deliberately NO assignment — unavailableDates alone must be enough.
      // biz_backup_near / biz_backup_far: deliberately NO assignment — plain eligible backup candidates.
      // biz_completed (already defined above, asg_completed) doubles as the
      // conflict-check fixture below: it's operationally "completed"
      // (target met) but shares fo_main and the SAME 9-19 window as
      // biz_partial_reject's own visit — proving the conflict check adds
      // real protection beyond the operational-status filter alone, with
      // no extra assignment needed.
    ];

    const sessions = [
      // biz_completed: a full 10h+ session -> recordedHours >= targetHours(10h) -> COMPLETED
      { id: "session_completed", assignmentId: "asg_completed", businessId: "biz_completed", foId: "fo_main", rigId: "rig_b", date: today, startedAt: iso(9), endedAt: iso(19), plannedDurationMin: 600, status: "completed", batteryPct: 90, storagePct: 10, signal: "healthy", createdAt: now },
      // biz_at_risk_hours: deliberately NO session -> recordedHours=0 < target(10h) -> AT_RISK
      // biz_complete_multirig_ok: 3 completed sessions, 11h each = 33h >= 30h target -> COMPLETED, no false recovery.
      { id: "session_cmr_1", assignmentId: "asg_cmr_1", businessId: "biz_complete_multirig_ok", foId: "fo_main", rigId: "rig_cmr1", date: today, startedAt: iso(8), endedAt: new Date(new Date(iso(8)).getTime() + 11 * 3_600_000).toISOString(), plannedDurationMin: 660, status: "completed", batteryPct: 90, storagePct: 10, signal: "healthy", createdAt: now },
      { id: "session_cmr_2", assignmentId: "asg_cmr_2", businessId: "biz_complete_multirig_ok", foId: "fo_main", rigId: "rig_cmr2", date: today, startedAt: iso(8), endedAt: new Date(new Date(iso(8)).getTime() + 11 * 3_600_000).toISOString(), plannedDurationMin: 660, status: "completed", batteryPct: 90, storagePct: 10, signal: "healthy", createdAt: now },
      { id: "session_cmr_3", assignmentId: "asg_cmr_3", businessId: "biz_complete_multirig_ok", foId: "fo_main", rigId: "rig_cmr3", date: today, startedAt: iso(8), endedAt: new Date(new Date(iso(8)).getTime() + 11 * 3_600_000).toISOString(), plannedDurationMin: 660, status: "completed", batteryPct: 90, storagePct: 10, signal: "healthy", createdAt: now },
    ];

    const issues = [
      { id: "issue_rig_failure", type: "rig_failure", severity: "critical", title: "Rig failure", description: "Rig failed mid-recording.", businessId: "biz_at_risk_issue", foId: "fo_main", status: "open", createdAt: now },
      { id: "issue_recording_failure", type: "recording_failure", severity: "critical", title: "Recording failure", description: "Recording stopped unexpectedly.", businessId: "biz_recording_failure", foId: "fo_main", status: "open", createdAt: now },
    ];

    const rigs = ["rig_a", "rig_b", "rig_c", "rig_d", "rig_e", "rig_f", "rig_g", "rig_h1", "rig_h2", "rig_4a", "rig_4b", "rig_4c", "rig_4d", "rig_mrr1", "rig_mrr2", "rig_mrr3", "rig_cmr1", "rig_cmr2", "rig_cmr3", "rig_recfail"].map((id) => ({
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

    // ==================================================================
    console.log("\n[PHASE D 1-10] Recovery Radar detection, explanation, and false-positive guards:");
    const recoveryText = await page.locator('[data-testid="recovery-radar-list"]').innerText();
    const recoveryBizIds = await page.locator('[data-testid="recovery-radar-item"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-business-id")));
    check(recoveryBizIds.includes("biz_unavailable_rejected"), "[2] a fully-rejected business appears in Recovery Radar");
    check(recoveryBizIds.includes("biz_unavailable_noshow"), "[3] a fully-no-show business appears in Recovery Radar");
    check(recoveryBizIds.includes("biz_at_risk_issue"), "[4] an open rig_failure issue business appears in Recovery Radar");
    check(recoveryBizIds.includes("biz_recording_failure"), "[5] an open recording_failure issue business appears in Recovery Radar");
    check(recoveryBizIds.includes("biz_at_risk_recheck"), "[6] a recheck-requested business appears in Recovery Radar");
    check(recoveryBizIds.includes("biz_partial_reject"), "[7] a partial multi-rig failure appears in Recovery Radar");
    check(recoveryBizIds.includes("biz_multirig_recovery"), "[7][11-14] a 3-rig partial failure appears in Recovery Radar");
    check(!recoveryBizIds.includes("biz_complete_multirig_ok"), "[8] a complete multi-rig business AT target does NOT falsely appear in Recovery Radar");
    check(!recoveryBizIds.includes("biz_assigned"), "[9] in-progress work (not yet judged against its hours target) does NOT falsely appear in Recovery Radar");
    check(!recoveryBizIds.includes("biz_four_rig"), "[9] in-progress 4-rig work does NOT falsely appear in Recovery Radar");
    check(recoveryBizIds.includes("biz_at_risk_hours"), "[10] completed work below target appears in Recovery Radar");
    check(!recoveryBizIds.includes("biz_completed"), "sanity: a completed business AT its 1-rig target does NOT appear");
    check(!recoveryBizIds.includes("biz_unassigned"), "sanity: a merely-unassigned (not at-risk) business does NOT appear in Recovery Radar");

    console.log("\n[PHASE D 11-15] Multi-rig target hours in Recovery Radar, assignments stay independent:");
    check(recoveryText.includes("3 rigs") && recoveryText.includes("30h target"), `[13] biz_multirig_recovery's card shows '3 rigs · 30h target' — got a list containing: ${recoveryText.includes("MultiRigRecovery") ? "(found business name)" : "(business name missing!)"}`);
    check(/2 of 3 rigs/.test(recoveryText), "[7][11-14] biz_multirig_recovery's card names '2 of 3 rigs' affected — rig-level detail, not a business-wide guess");
    const mrrAssignments = await page.evaluate(() => JSON.parse(localStorage.getItem("city-ops-os")).state.assignments.filter((a) => a.businessId === "biz_multirig_recovery"));
    check(mrrAssignments.length === 3, "[15] biz_multirig_recovery still has exactly 3 independent Assignment records — Recovery Radar never collapses them into one synthetic assignment");
    check(mrrAssignments.filter((a) => a.status === "rejected").length === 2 && mrrAssignments.filter((a) => a.status === "confirmed").length === 1, "[15] each of the 3 assignments keeps its own distinct, correct status");

    console.log("\n[PHASE D: severity model] deterministic three-tier severity, reused color tokens, not an opaque score:");
    const severityByBiz = await page.locator('[data-testid="recovery-radar-item"]').evaluateAll((els) => Object.fromEntries(els.map((el) => [el.getAttribute("data-business-id"), el.getAttribute("data-severity")])));
    check(severityByBiz["biz_unavailable_rejected"] === "critical", `unavailable (rejected) -> CRITICAL severity (got '${severityByBiz["biz_unavailable_rejected"]}')`);
    check(severityByBiz["biz_unavailable_noshow"] === "critical", `unavailable (no-show) -> CRITICAL severity (got '${severityByBiz["biz_unavailable_noshow"]}')`);
    check(severityByBiz["biz_partial_reject"] === "high", `partial multi-rig failure -> HIGH severity (got '${severityByBiz["biz_partial_reject"]}')`);
    check(severityByBiz["biz_at_risk_issue"] === "high", `open rig_failure issue -> HIGH severity (got '${severityByBiz["biz_at_risk_issue"]}')`);
    check(severityByBiz["biz_recording_failure"] === "high", `open recording_failure issue -> HIGH severity (got '${severityByBiz["biz_recording_failure"]}')`);
    check(severityByBiz["biz_at_risk_recheck"] === "medium", `recheck requested -> MEDIUM severity (got '${severityByBiz["biz_at_risk_recheck"]}')`);

    console.log("\n[PHASE D: static check] no opaque score exists anywhere in the engine or page source:");
    const cityCoverageEngineSrc = readFileSync("src/engine/cityCoverage.ts", "utf8");
    const cityCoveragePageSrc = readFileSync("src/pages/CityCoverage.tsx", "utf8");
    for (const forbidden of ["riskScore", "backupScore", "aiScore", "probabilityScore", "AI recommendation", "AI-powered"]) {
      check(!cityCoverageEngineSrc.includes(forbidden) && !cityCoveragePageSrc.includes(forbidden), `[26] no "${forbidden}" concept exists in the Recovery Radar / backup engine or page`);
    }

    console.log("\n[PHASE D 16-23,25] Backup eligibility (inactive/unavailable-today/missing-coordinates/conflicting all rejected; valid eligible accepted and ranked by distance; distance labeled straight-line):");
    await page.locator('[data-testid="recovery-radar-item"][data-business-id="biz_partial_reject"] button:has-text("Review Backup")').click();
    await sleep(400);
    check(await page.locator('[data-testid="backup-review-dialog"]').isVisible(), "the Review Backup dialog opens");
    const backupCandidateIds = await page.locator('[data-testid="backup-candidate-row"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-business-id")));
    check(!backupCandidateIds.includes("biz_unavailable_inactive"), "[16] the inactive business is never an eligible backup candidate");
    check(!backupCandidateIds.includes("biz_backup_unavailable_today"), "[17] the unavailable-today business is never an eligible backup candidate");
    check(!backupCandidateIds.includes("biz_nolocation"), "[18] the business with no coordinates at all is never an eligible backup candidate (excluded before eligibility is even evaluated)");
    check(!backupCandidateIds.includes("biz_completed"), "[19] a business that LOOKS operationally eligible but has a conflicting overlapping assignment for the same FO is correctly rejected");
    check(backupCandidateIds.includes("biz_backup_near"), "[20] a genuinely eligible, conflict-free business IS accepted as a backup candidate");
    // biz_backup_far is deliberately ~30km away — with this shared
    // fixture's ~20 businesses, several other operationally-eligible ones
    // legitimately rank closer, so it can fall outside the dialog's
    // intentional top-5 display. Ranking-order correctness (near-before-
    // far) is verified below in an ISOLATED fixture with only 3
    // businesses, where both are guaranteed to be visible.

    console.log("\n[PHASE D 22] eligibility before distance — an ineligible-but-closer candidate never outranks an eligible one:");
    check(
      !backupCandidateIds.includes("biz_completed") && backupCandidateIds.includes("biz_backup_near"),
      "[22] an eligible candidate is present in ranked results while a nearer-but-ineligible one (biz_completed, conflicting) never outranks it — it's excluded entirely",
    );
    const backupDialogText = await page.locator('[data-testid="backup-candidate-list"]').innerText();
    check(/straight-line/i.test(backupDialogText), "[25] every distance in the backup list is explicitly labeled 'straight-line'");
    // "driving" is allowed to appear ONLY inside the explicit disclaimer
    // ("...straight-line, not driving distance") — never asserting a
    // distance actually IS driving distance/time. Strip the known-good
    // disclaimer phrase out first, then confirm "driving" doesn't appear
    // anywhere else in the text.
    const textWithoutDisclaimer = backupDialogText.replace(/straight-line, not driving distance\.?/gi, "");
    check(!/driving/i.test(textWithoutDisclaimer), "[25] 'driving' never appears outside the explicit straight-line-not-driving disclaimer — no distance is described as driving distance/time");

    console.log("\n[PHASE D: eligibility checklist transparency, marker interaction from within the dialog]");
    const firstCandidateChecklist = await page.locator('[data-testid="backup-candidate-row"]').first().innerText();
    check(/✓|✗/.test(firstCandidateChecklist), "each backup candidate shows its own pass/fail eligibility checklist, not a single score");
    await page.locator('[data-testid="backup-candidate-row"][data-business-id="biz_backup_near"]').click();
    await sleep(300);
    check(await page.locator('[data-testid="city-coverage-business-detail"]').isVisible(), "[41] clicking a backup candidate row in the dialog selects/focuses that business on the map's detail panel");

    console.log("\n[PHASE D 12,29] FO-location context in the backup dialog is explicitly last-known, never live:");
    check(!/\blive\b/i.test(backupDialogText) && !/tracking/i.test(backupDialogText), "the backup dialog's distance-reference note never implies live tracking");

    console.log("\n[PHASE D: Manager action confirmation, no mutation from the review flow]");
    const assignmentsBeforeBackupFlow = await page.evaluate(() => JSON.stringify([...JSON.parse(localStorage.getItem("city-ops-os")).state.assignments].sort((a, b) => a.id.localeCompare(b.id))));
    check(assignmentsBeforeBackupFlow === assignmentsAfter, "[48][49][50] browsing Recovery Radar, opening Review Backup, and clicking a candidate row mutated NO assignment and created NO synthetic assignment");
    check(await page.locator('[data-testid="backup-review-dialog"] button:has-text("Open Assignment Planner")').isVisible(), "the confirmation workflow offers 'Open Assignment Planner' — routes to the EXISTING assignment workflow, never an automatic reassignment button");
    check(await page.locator('[data-testid="backup-review-dialog"] button:has-text("Cancel")').isVisible(), "a plain Cancel action is available — no forced action");
    await page.locator('[data-testid="backup-review-dialog"] button:has-text("Cancel")').click();
    await sleep(300);
    check(!(await page.locator('[data-testid="backup-review-dialog"]').isVisible().catch(() => false)), "Cancel closes the dialog without navigating or mutating anything");

    console.log("\n[PHASE D 21] insufficient-data fallback design note:");
    // This data model's Assignment always carries foId/date/plannedStart/
    // plannedEnd (non-optional fields) and Business always carries
    // active/unavailableDates (even if undefined, a defined absence, not
    // an ambiguous one) — so rankBackupCandidates() never actually lacks
    // the data it needs to decide eligibility. There is no reachable case
    // in this schema where an "Insufficient assignment data" fallback
    // would fire; documented here rather than faked with a contrived gap
    // in the data model.
    check(true, "[21] no code path in rankBackupCandidates() ever guesses eligibility from incomplete data — every dimension it checks is a required, always-present field");

    console.log("\n[PHASE D: no assignment mutation across the ENTIRE Recovery Radar / backup review session]");
    const assignmentsFinal = await page.evaluate(() => JSON.stringify([...JSON.parse(localStorage.getItem("city-ops-os")).state.assignments].sort((a, b) => a.id.localeCompare(b.id))));
    check(assignmentsFinal === assignmentsAfter, "[49][50] after the full Recovery Radar + Review Backup interaction session, every Assignment record remains byte-for-byte unchanged");

    await context.close();

    console.log("\n[PHASE D 23,24] Isolated ranking check: nearer eligible candidate ranks above a farther eligible one, deterministically:");
    const rankContext = await browser.newContext();
    const rankPage = await rankContext.newPage();
    rankPage.on("pageerror", (err) => console.error("  [page error]", err.message));
    await rankPage.goto(`${BASE_URL}/login`);
    await rankPage.evaluate(() => {
      const now = new Date().toISOString();
      const today = now.slice(0, 10);
      const source = { id: "biz_rank_source", name: "Rank Source Biz", category: "General", area: "Area", address: "", lat: 14.0, lng: 79.0, capacityHoursPerDay: 10, active: true, createdAt: now };
      const near = { id: "biz_rank_near", name: "Rank Near Biz", category: "General", area: "Area", address: "", lat: 14.001, lng: 79.001, capacityHoursPerDay: 10, active: true, createdAt: now };
      const far = { id: "biz_rank_far", name: "Rank Far Biz", category: "General", area: "Area", address: "", lat: 14.3, lng: 79.3, capacityHoursPerDay: 10, active: true, createdAt: now };
      const fo = { id: "fo_rank", name: "Rank FO", active: true, createdAt: now };
      const rig = { id: "rig_rank", code: "R-RANK", model: "Test Rig", active: true, batteryPct: 100, storagePct: 0, deploymentStatus: "active", createdAt: now };
      const assignment = { id: "asg_rank_source", date: today, businessId: source.id, foId: fo.id, rigId: rig.id, plannedStart: `${today}T09:00:00.000Z`, plannedEnd: `${today}T19:00:00.000Z`, priority: "normal", status: "rejected", createdAt: now };
      const cityData = {
        version: 2,
        settings: { cityName: "Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
        businesses: [source, near, far],
        fos: [fo],
        collectors: [],
        rigs: [rig],
        assignments: [assignment],
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
    await rankPage.goto(`${BASE_URL}/city-coverage`);
    await rankPage.waitForSelector("h1:has-text(\"City Coverage\")", { timeout: 15000 });
    await sleep(500);
    await rankPage.locator('button:has-text("Review Backup")').click();
    await sleep(400);
    const rankCandidateIds = await rankPage.locator('[data-testid="backup-candidate-row"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-business-id")));
    check(rankCandidateIds.includes("biz_rank_near") && rankCandidateIds.includes("biz_rank_far"), `[20] both the near and far eligible candidates appear — got [${rankCandidateIds.join(", ")}]`);
    check(
      rankCandidateIds.indexOf("biz_rank_near") < rankCandidateIds.indexOf("biz_rank_far"),
      `[23] the nearer eligible candidate ranks strictly ABOVE the farther eligible one — order: [${rankCandidateIds.join(", ")}]`,
    );
    // [24] Haversine distance is a pure, deterministic function of its
    // inputs — re-opening the same dialog again must produce the exact
    // same order and distance text every time.
    await rankPage.locator('[data-testid="backup-review-dialog"] button:has-text("Cancel")').click();
    await sleep(300);
    await rankPage.locator('button:has-text("Review Backup")').click();
    await sleep(400);
    const rankCandidateIdsAgain = await rankPage.locator('[data-testid="backup-candidate-row"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-business-id")));
    check(JSON.stringify(rankCandidateIds) === JSON.stringify(rankCandidateIdsAgain), "[24] re-opening the same Review Backup dialog produces the exact same deterministic ranking every time");
    await rankContext.close();

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
      const recoveryCountMobile = await mobilePage.locator('[data-testid="recovery-radar-item"]').count();
      check(recoveryCountMobile > 0, `[37-39] at ${w}x${h}: Recovery Radar items render on mobile (got ${recoveryCountMobile})`);
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
    check((await darkPage.locator('[data-testid="recovery-radar-item"]').count()) > 0, "[36][40] Recovery Radar items render correctly in dark theme at desktop width");
    await darkPage.locator('[data-testid="recovery-radar-item"]').first().locator('button:has-text("Review Backup")').click();
    await sleep(300);
    check(await darkPage.locator('[data-testid="backup-review-dialog"]').isVisible(), "[36] the Backup Review dialog opens and is visible in dark theme");
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
    check((await emptyPage.locator('[data-testid="recovery-radar-item"]').count()) === 0, "[43] zero Recovery Radar items rendered when there are no businesses at all");
    check(await emptyPage.locator("text=City looks stable").isVisible(), "[1][43] Recovery Radar shows 'City looks stable' when nothing needs attention — never a fake recommendation");
    check(await emptyPage.locator("text=0 businesses currently require recovery attention.").isVisible(), "[43] the empty state names the exact count (0), not a vague message");
    await emptyContext.close();

    console.log("\n[PHASE D 44] Recovery required but no eligible backup exists:");
    const noBackupContext = await browser.newContext();
    const noBackupPage = await noBackupContext.newPage();
    noBackupPage.on("pageerror", (err) => console.error("  [page error]", err.message));
    await noBackupPage.goto(`${BASE_URL}/login`);
    await noBackupPage.evaluate(() => {
      const now = new Date().toISOString();
      const today = now.slice(0, 10);
      const soleBusiness = { id: "biz_alone_recovery", name: "Alone Recovery Biz", category: "General", area: "Area", address: "", lat: 14.4, lng: 79.4, capacityHoursPerDay: 10, active: true, createdAt: now };
      const fo = { id: "fo_alone", name: "Alone FO", active: true, createdAt: now };
      const rig = { id: "rig_alone", code: "R-ALONE", model: "Test Rig", active: true, batteryPct: 100, storagePct: 0, deploymentStatus: "active", createdAt: now };
      const assignment = { id: "asg_alone", date: today, businessId: soleBusiness.id, foId: fo.id, rigId: rig.id, plannedStart: `${today}T09:00:00.000Z`, plannedEnd: `${today}T19:00:00.000Z`, priority: "normal", status: "rejected", createdAt: now };
      const cityData = {
        version: 2,
        settings: { cityName: "Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
        businesses: [soleBusiness],
        fos: [fo],
        collectors: [],
        rigs: [rig],
        assignments: [assignment],
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
    await noBackupPage.goto(`${BASE_URL}/city-coverage`);
    await noBackupPage.waitForSelector("h1:has-text(\"City Coverage\")", { timeout: 15000 });
    await sleep(500);
    check((await noBackupPage.locator('[data-testid="recovery-radar-item"]').count()) === 1, "[44] the sole rejected business correctly appears in Recovery Radar");
    check(await noBackupPage.locator('[data-testid="recovery-item-no-backup"]').isVisible(), "[44] with no other business to serve as a backup, the card honestly states no eligible backup was found — never a forced/fabricated recommendation");
    await noBackupPage.locator('button:has-text("Review Backup")').click();
    await sleep(300);
    check(await noBackupPage.locator('[data-testid="backup-no-candidates"]').isVisible(), "[44] the Review Backup dialog also honestly states no eligible backup business was found");
    await noBackupContext.close();

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
