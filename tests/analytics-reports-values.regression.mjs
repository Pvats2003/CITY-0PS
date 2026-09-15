// REAL BROWSER value-level tests for engine/analytics.ts and
// engine/reports.ts — not "renders without throwing." A deterministic
// fixture (exact assignment/session times, one business, one FO, two
// rigs) is seeded, and the actual rendered numbers are asserted against
// values hand-derived from the real implementation's own documented
// formulas (src/engine/insights.ts's cityTargetHoursForDate = distinct
// rigs deployed x 10h; src/engine/selectors.ts's plannedHoursForDate/
// recordedHoursForDate; src/engine/reports.ts's buildSOD/buildMOD/
// buildEOD; src/engine/analytics.ts's buildBusinessRanking) — never
// invented expected values.
//
// Fixture, all on "today":
//   - 1 business, 2 rigs deployed today -> target = 2 x 10h = 20h.
//   - Assignment A: 08:00-11:00 (3h), status "completed".
//   - Assignment B: 12:00-14:00 (2h), status "confirmed" (not completed).
//   - plannedHoursForDate = 3h + 2h = 5.0h exactly.
//   - 1 session (for Assignment A's rig), 08:00-10:00 (2h), completed.
//   - recordedHoursForDate = 2.0h. achievementPct = round(2/20*100) = 10%.
//   - 1 FO, fully assigned to both -> zero "unassigned business" risk,
//     "Planned hours (5.0h) are below the 20h target." is the one risk
//     (5 < 20), and "Confirm check-in for all 1 FOs..." is the one action.
//
// SOD/MOD/EOD render these as plain, directly-readable text (Reports.tsx's
// <Stat> components) — asserted exactly. Analytics' Recording Performance/
// Utilization/FO Performance/Loss-breakdown charts are Recharts SVG with
// no plain-text numeric output for those series in this fixture's range;
// Business Reliability is analytics.ts's one metric that renders as plain
// text (<RankRow>), and IS asserted exactly here. The SVG-only metrics are
// explicitly left unasserted rather than approximated — see the final
// report for which analytics numbers still lack a plain-text assertion
// path.
//
// Run with: npm run test:analytics-reports-values

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4200;
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
    } catch {}
    await sleep(500);
  }
  throw new Error("Server did not become ready in time");
}

function killAndWait(child) {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill();
    setTimeout(resolve, 3000);
  }).then(() => new Promise((resolve) => {
    const fuser = spawn("fuser", ["-k", `${PORT}/tcp`]);
    fuser.on("exit", () => resolve());
    fuser.on("error", () => resolve());
    setTimeout(resolve, 2000);
  }));
}

async function seedFixture(page) {
  await page.evaluate(() => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const business = { id: "biz_metrics", name: "Metrics Test Business", category: "General", area: "Area", address: "", capacityHoursPerDay: 20, active: true, createdAt: now.toISOString() };
    const fo = { id: "fo_metrics", name: "Metrics Test FO", homeArea: "Area", phone: "+1 555 0188", active: true, createdAt: now.toISOString() };
    const rigA = { id: "rig_metrics_a", code: "R-MET-A", model: "Test Rig", active: true, batteryPct: 90, storagePct: 10, deploymentStatus: "active", createdAt: now.toISOString() };
    const rigB = { id: "rig_metrics_b", code: "R-MET-B", model: "Test Rig", active: true, batteryPct: 90, storagePct: 10, deploymentStatus: "active", createdAt: now.toISOString() };
    const asgA = {
      id: "asg_metrics_a", date: today, businessId: business.id, foId: fo.id, rigId: rigA.id,
      plannedStart: `${today}T08:00:00.000Z`, plannedEnd: `${today}T11:00:00.000Z`,
      priority: "normal", status: "completed", actualArrivalAt: `${today}T08:00:00.000Z`, createdAt: now.toISOString(),
    };
    const asgB = {
      id: "asg_metrics_b", date: today, businessId: business.id, foId: fo.id, rigId: rigB.id,
      plannedStart: `${today}T12:00:00.000Z`, plannedEnd: `${today}T14:00:00.000Z`,
      priority: "normal", status: "confirmed", createdAt: now.toISOString(),
    };
    const session = {
      id: "session_metrics", date: today, businessId: business.id, foId: fo.id, rigId: rigA.id, assignmentId: asgA.id,
      status: "completed", startedAt: `${today}T08:00:00.000Z`, endedAt: `${today}T10:00:00.000Z`, plannedDurationMin: 180, createdAt: now.toISOString(),
    };
    const cityData = {
      version: 2,
      settings: { cityName: "Metrics Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
      businesses: [business], fos: [fo], collectors: [], rigs: [rigA, rigB], assignments: [asgA, asgB], sessions: [session],
      evidence: [], issues: [], qualityReviews: [], correctiveActions: [], rigIncidents: [], repairRecords: [], activity: [], plans: [], reports: [],
    };
    localStorage.setItem("city-ops-os", JSON.stringify({ state: cityData, version: 2 }));
    localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-manager", email: "manager@demo.city-ops", role: "MANAGER", displayName: "Demo Manager", createdAt: now.toISOString() }));
  });
}

async function statValue(page, label) {
  const container = page.locator("div.rounded-md.bg-surface-2", { hasText: label });
  return (await container.first().innerText()).trim();
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
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", (err) => console.error("  [page error]", err.message));

    await page.goto(`${BASE_URL}/login`);
    await seedFixture(page);

    console.log("\n[1] SOD (Start of Day) — exact values:");
    await page.goto(`${BASE_URL}/reports?tab=sod`);
    await page.waitForSelector("text=Expected Hours", { timeout: 15000 });
    const expectedHoursText = await statValue(page, "Expected Hours");
    check(expectedHoursText.includes("5.0h"), `Expected Hours reads exactly '5.0h' (3h + 2h planned) — got "${expectedHoursText}"`);
    const targetHoursText = await statValue(page, "Target");
    check(targetHoursText.includes("20h"), `Target reads exactly '20h' (2 distinct rigs x 10h/rig, computed not hardcoded) — got "${targetHoursText}"`);
    // "Visits Planned" (not "Businesses Planned" — see the fix this test
    // found: the count is per-assignment/visit, not deduplicated by
    // business, so it must read 2 here (one business, two assignments).
    check(await page.locator("text=Visits Planned (2)").isVisible(), "Visits Planned count is exactly 2 (one business, two assignments/visits) — correctly labeled, not miscounted as 'Businesses'");
    check(await page.locator("text=Planned hours (5.0h) are below the 20h target.").isVisible(), "the exact risk sentence is generated from the real 5.0h/20h numbers");
    check(await page.locator("text=Confirm check-in for all 1 FOs before their first visit.").isVisible(), "the exact action sentence names the correct FO count (1)");

    console.log("\n[2] MOD (Mid Day) — exact completion ratio:");
    await page.goto(`${BASE_URL}/reports?tab=mod`);
    await page.waitForSelector("text=Completed Visits", { timeout: 15000 });
    const completedVisitsText = await statValue(page, "Completed Visits");
    check(completedVisitsText.includes("1/2"), `Completed Visits reads exactly '1/2' (1 of the 2 assignments is status=completed) — got "${completedVisitsText}"`);
    const plannedHoursText = await statValue(page, "Planned Hours");
    check(plannedHoursText.includes("5.0h"), `Planned Hours reads '5.0h', matching SOD's expectedHours from the same underlying calculation`);
    const actualSoFarText = await statValue(page, "Actual So Far");
    check(actualSoFarText.includes("2.0h"), `Actual So Far reads '2.0h' (the one 2-hour completed session) — got "${actualSoFarText}"`);

    console.log("\n[3] EOD (End of Day) — exact recording hours, target, and achievement %:");
    await page.goto(`${BASE_URL}/reports?tab=eod`);
    await page.waitForSelector("text=Recording Hours", { timeout: 15000 });
    const recordingHoursText = await statValue(page, "Recording Hours");
    check(recordingHoursText.includes("2.0h") && recordingHoursText.includes("of 20h target"), `Recording Hours reads '2.0h' with the correct 'of 20h target' sub-label — got "${recordingHoursText}"`);
    const achievementText = await statValue(page, "Achievement");
    check(achievementText.includes("10%"), `Achievement reads exactly '10%' (2.0h recorded / 20h target = round(10) = 10) — got "${achievementText}"`);
    const visitsText = await statValue(page, "Visits");
    check(visitsText.includes("1/2"), `EOD's Visits stat reads '1/2', matching MOD's completion ratio (correctly labeled 'Visits', not 'Businesses') — got "${visitsText}"`);

    console.log("\n[4] Analytics — Business Reliability exact value:");
    await page.goto(`${BASE_URL}/analytics`);
    await page.waitForSelector("text=Business Reliability", { timeout: 15000 });
    const reliabilityRow = page.locator("text=Metrics Test Business").locator("..");
    check(await reliabilityRow.locator("text=100%").isVisible().catch(() => false), "Business Reliability shows exactly 100% (1 completed assignment, 0 rejected/no-show, round((1-0)/1*100)=100)");

    console.log("\n[5] Edge case — zero data (no sessions at all) shows the correct empty states, not a fabricated number:");
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem("city-ops-os") || "{}");
      raw.state.sessions = [];
      localStorage.setItem("city-ops-os", JSON.stringify(raw));
    });
    await page.goto(`${BASE_URL}/analytics`);
    await sleep(400);
    check(await page.locator("text=Not enough data yet").isVisible(), "Analytics shows its real empty state ('Not enough data yet') once sessions.length is 0, rather than rendering charts with fabricated zeros");

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
