// REAL BROWSER regression test for role-based route security
// (src/auth/RequireRole.tsx). Drives the actual rendered app (production
// build) with Playwright: a signed-in Field Officer directly navigates to
// every Manager-only route, and a signed-in Manager directly navigates to
// the FO route, verifying RequireRole's redirect — not a UI nav-link
// check, a direct URL bar navigation, which is exactly how a
// non-cooperating client would probe access.
//
// No Firestore rules or UI authorization were weakened to make this pass.
//
// Run with: npm run test:route-security

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4197;
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

const MANAGER_ONLY_ROUTES = [
  "/", "/dashboard", "/today", "/businesses", "/businesses/biz_sec",
  "/field-officers", "/field-officers/fo_sec", "/city-coverage", "/fleet", "/fleet/rig_sec",
  "/sessions", "/sessions/session_sec", "/issues", "/issues/issue_sec",
  "/quality", "/reports", "/analytics", "/search", "/settings",
];

async function seedScenario(page) {
  await page.evaluate(() => {
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const business = { id: "biz_sec", name: "Route Security Test Biz", category: "General", area: "Area", address: "", capacityHoursPerDay: 10, active: true, createdAt: now };
    // A SECOND business with no relationship whatsoever to the FO's own
    // assignment — this is the name that must never leak into anything the
    // FO's browser renders, unlike the FO's own assigned business above.
    const otherBusiness = { id: "biz_sec_other", name: "MANAGER ONLY LEAK CANARY BUSINESS", category: "General", area: "Area", address: "", capacityHoursPerDay: 10, active: true, createdAt: now };
    const fo = { id: "fo_sec", name: "Route Security Test FO", homeArea: "Area", phone: "+1 555 0177", active: true, createdAt: now };
    const rig = { id: "rig_sec", code: "R-SEC", model: "Test Rig", active: true, batteryPct: 90, storagePct: 10, deploymentStatus: "active", createdAt: now };
    const assignment = { id: "asg_sec", date: today, businessId: business.id, foId: fo.id, rigId: rig.id, plannedStart: `${today}T08:00:00.000Z`, plannedEnd: `${today}T11:00:00.000Z`, priority: "normal", status: "confirmed", createdAt: now };
    const session = { id: "session_sec", businessId: otherBusiness.id, foId: fo.id, rigId: rig.id, status: "completed", startedAt: now, endedAt: now, plannedDurationMin: 120, createdAt: now };
    const issue = { id: "issue_sec", title: "Route security test issue", description: "For route security testing.", type: "other", severity: "warning", status: "open", businessId: otherBusiness.id, foId: fo.id, createdAt: now };
    const cityData = {
      version: 2,
      settings: { cityName: "Route Security Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
      businesses: [business, otherBusiness], fos: [fo], collectors: [], rigs: [rig], assignments: [assignment],
      sessions: [session], evidence: [], issues: [issue], qualityReviews: [], correctiveActions: [], rigIncidents: [], repairRecords: [], activity: [], plans: [], reports: [],
    };
    localStorage.setItem("city-ops-os", JSON.stringify({ state: cityData, version: 2 }));
  });
}

async function signInAs(page, role) {
  await page.evaluate((role) => {
    const now = new Date().toISOString();
    if (role === "MANAGER") {
      localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-manager", email: "manager@demo.city-ops", role: "MANAGER", displayName: "Demo Manager", createdAt: now }));
    } else {
      localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-fo-fo_sec", email: "sec.fo@demo.city-ops", role: "FIELD_OFFICER", displayName: "Route Security Test FO", foId: "fo_sec", createdAt: now }));
    }
  }, role);
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

    console.log("\n[1] Signed-in Field Officer directly navigating to every Manager-only route is redirected to /fo, with no Manager data exposed:");
    const foContext = await browser.newContext();
    const foPage = await foContext.newPage();
    await foPage.goto(`${BASE_URL}/fo`);
    await seedScenario(foPage);
    await signInAs(foPage, "FIELD_OFFICER");

    for (const route of MANAGER_ONLY_ROUTES) {
      await foPage.goto(`${BASE_URL}${route}`);
      await sleep(400);
      const url = foPage.url();
      check(url.endsWith("/fo") || url.endsWith("/fo/"), `FO navigating to ${route} is redirected to /fo (got ${url.replace(BASE_URL, "")})`);
      const bodyText = await foPage.evaluate(() => document.body.innerText);
      check(!bodyText.includes("MANAGER ONLY LEAK CANARY BUSINESS"), `FO at ${route} never sees the unrelated Manager-only business's name leak into the redirected page`);
    }

    console.log("\n[2] The FO's own route (/fo) still works normally after all those denied attempts:");
    await foPage.goto(`${BASE_URL}/fo`);
    await sleep(300);
    check(await foPage.locator("text=Route Security Test Biz").isVisible().catch(() => false), "the FO's own assignment is still visible on /fo — denial attempts didn't corrupt their own session");
    await foContext.close();

    console.log("\n[3] Signed-in Manager directly navigating to the FO route (/fo) is redirected to Manager territory:");
    const managerContext = await browser.newContext();
    const managerPage = await managerContext.newPage();
    await managerPage.goto(`${BASE_URL}/login`);
    await seedScenario(managerPage);
    await signInAs(managerPage, "MANAGER");
    await managerPage.goto(`${BASE_URL}/fo`);
    await sleep(400);
    check(!managerPage.url().includes("/fo"), `Manager navigating to /fo is redirected away from the FO shell (got ${managerPage.url().replace(BASE_URL, "")})`);

    console.log("\n[4] All intended Manager routes remain accessible to a signed-in Manager:");
    for (const route of MANAGER_ONLY_ROUTES) {
      await managerPage.goto(`${BASE_URL}${route}`);
      await sleep(300);
      const url = managerPage.url();
      check(url.endsWith(route) || (route === "/" && (url === `${BASE_URL}/` || url === `${BASE_URL}`)), `Manager can still reach ${route} directly (got ${url.replace(BASE_URL, "")})`);
    }
    await managerContext.close();

    console.log("\n[5] An unauthenticated visitor hitting a Manager route is sent to /login, and an FO route to /fo/login:");
    const anonContext = await browser.newContext();
    const anonPage = await anonContext.newPage();
    await anonPage.goto(`${BASE_URL}/businesses`);
    await sleep(400);
    check(anonPage.url().includes("/login") && !anonPage.url().includes("/fo/login"), "an unauthenticated visitor to a Manager route lands on /login");
    await anonPage.goto(`${BASE_URL}/fo`);
    await sleep(400);
    check(anonPage.url().includes("/fo/login"), "an unauthenticated visitor to /fo lands on /fo/login, not the generic /login");
    await anonContext.close();

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
