// Regression test for City Coverage — Phase B ("engine + map skeleton"):
// src/engine/cityCoverage.ts's mappableBusinesses()/projectPoints() and
// src/lib/googleMaps.ts's parseCoordinatesFromMapsUrl()/
// resolveBusinessCoordinates(), as consumed by the new Manager-only
// src/pages/CityCoverage.tsx.
//
// Scope for this phase: coordinate resolution and the map's marker
// rendering pipeline only — status-colored markers, the FO location layer,
// backup eligibility, and Recovery Radar are later phases with their own
// dedicated tests. Route-level Manager-only gating for /city-coverage is
// covered by tests/route-security.regression.mjs (extended to include it),
// not duplicated here.
//
// Checks:
//   [1] A business with real Business.lat/lng gets a marker.
//   [2] A business with ONLY a literal-coordinate googleMapsUrl (no
//       lat/lng) also gets a marker — proves the URL-parsing fallback.
//   [3] A business with a maps.app.goo.gl short link (no literal
//       coordinates) gets NO marker — never resolved/geocoded.
//   [4] A business with no location info at all gets NO marker.
//   [5] The "Missing Location" KPI honestly reflects the omitted count.
//   [6] Manager can reach /city-coverage directly and see the page.
//
// Run with: npm run test:city-coverage

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

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

    const now = new Date().toISOString();
    const businesses = [
      // [1] real lat/lng
      { id: "biz_latlng", name: "Latlng Biz", category: "General", area: "Area", address: "", lat: 14.19, lng: 79.16, capacityHoursPerDay: 10, active: true, createdAt: now },
      // [2] literal-coordinate Maps URL, no lat/lng fields
      { id: "biz_mapsurl", name: "Mapsurl Biz", category: "General", area: "Area", address: "", googleMapsUrl: "https://www.google.com/maps?q=14.20,79.17", capacityHoursPerDay: 10, active: true, createdAt: now },
      // [2b] "@lat,lng,zoom" shape, embedded further in a /place/ path
      { id: "biz_atshape", name: "Atshape Biz", category: "General", area: "Area", address: "", googleMapsUrl: "https://www.google.com/maps/place/Some+Place/@14.21,79.18,17z", capacityHoursPerDay: 10, active: true, createdAt: now },
      // [3] short link — no literal coordinates, must never be resolved
      { id: "biz_shortlink", name: "Shortlink Biz", category: "General", area: "Area", address: "", googleMapsUrl: "https://maps.app.goo.gl/abc123XYZ", capacityHoursPerDay: 10, active: true, createdAt: now },
      // [4] no location info at all
      { id: "biz_nolocation", name: "Nolocation Biz", category: "General", area: "Area", address: "", capacityHoursPerDay: 10, active: true, createdAt: now },
    ];

    const cityData = {
      version: 2,
      settings: { cityName: "Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
      businesses,
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
    };

    console.log("\n[1-5] City Coverage map: coordinate resolution and marker rendering:");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (err) => console.error("  [page error]", err.message));
    await page.goto(`${BASE_URL}/login`);
    await page.evaluate((cityData) => {
      localStorage.setItem("city-ops-os", JSON.stringify({ state: cityData, version: 2 }));
      localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-manager", email: "manager@demo.city-ops", role: "MANAGER", displayName: "Demo Manager", createdAt: new Date().toISOString() }));
    }, cityData);
    await page.goto(`${BASE_URL}/city-coverage`);
    await page.waitForSelector("text=City Coverage", { timeout: 15000 });
    await sleep(500);

    check(page.url().endsWith("/city-coverage"), "[6] Manager reaches /city-coverage directly without being redirected");

    const markerIds = await page.locator('[data-testid="city-coverage-marker"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-business-id")));
    check(markerIds.includes("biz_latlng"), "[1] business with real Business.lat/lng gets a marker");
    check(markerIds.includes("biz_mapsurl"), "[2] business with only a literal-coordinate 'q=lat,lng' Maps URL gets a marker (URL-parsing fallback)");
    check(markerIds.includes("biz_atshape"), "[2] business with a literal-coordinate '@lat,lng,zoom' Maps URL gets a marker");
    check(!markerIds.includes("biz_shortlink"), "[3] business with only a maps.app.goo.gl short link gets NO marker — never resolved/geocoded");
    check(!markerIds.includes("biz_nolocation"), "[4] business with no location info at all gets NO marker");
    check(markerIds.length === 3, `[1-4] exactly 3 markers rendered (real lat/lng + 2 parsed Maps URLs), got ${markerIds.length}: [${markerIds.join(", ")}]`);

    const coordSources = await page.locator('[data-testid="city-coverage-marker"]').evaluateAll((els) =>
      Object.fromEntries(els.map((el) => [el.getAttribute("data-business-id"), el.getAttribute("data-coord-source")])),
    );
    check(coordSources["biz_latlng"] === "business", "[1] biz_latlng's marker is sourced from Business.lat/lng directly");
    check(coordSources["biz_mapsurl"] === "maps_url", "[2] biz_mapsurl's marker is sourced from the parsed googleMapsUrl, not fabricated lat/lng");
    check(coordSources["biz_atshape"] === "maps_url", "[2] biz_atshape's marker is sourced from the parsed googleMapsUrl");

    const bodyText = await page.evaluate(() => document.body.innerText);
    check(/\b5\b/.test(bodyText) && bodyText.includes("Businesses"), "[5] the 'Businesses' KPI shows the true total of 5");
    check(bodyText.includes("3") && bodyText.includes("On Map"), "[5] the 'On Map' KPI shows 3 — matches the actual marker count, not the full business count");
    check(bodyText.includes("2") && bodyText.includes("Missing Location"), "[5] the 'Missing Location' KPI honestly shows 2 (short link + no location at all) rather than hiding or fabricating them");

    await context.close();

    console.log("\n[7] Empty state: zero mappable businesses shows an honest empty state, never a fabricated marker:");
    const emptyContext = await browser.newContext();
    const emptyPage = await emptyContext.newPage();
    emptyPage.on("pageerror", (err) => console.error("  [page error]", err.message));
    await emptyPage.goto(`${BASE_URL}/login`);
    await emptyPage.evaluate((cityData) => {
      localStorage.setItem("city-ops-os", JSON.stringify({ state: cityData, version: 2 }));
      localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-manager", email: "manager@demo.city-ops", role: "MANAGER", displayName: "Demo Manager", createdAt: new Date().toISOString() }));
    }, { ...cityData, businesses: [businesses[3]] }); // only the short-link business — zero mappable
    await emptyPage.goto(`${BASE_URL}/city-coverage`);
    await emptyPage.waitForSelector("text=City Coverage", { timeout: 15000 });
    await sleep(500);
    const emptyMarkerCount = await emptyPage.locator('[data-testid="city-coverage-marker"]').count();
    check(emptyMarkerCount === 0, "[7] zero markers rendered when no business has a resolvable location");
    check(await emptyPage.locator("text=No mappable business locations yet").isVisible(), "[7] the empty state is shown, not a blank or broken map");
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
