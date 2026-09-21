// Regression test for a real bug found during the full production-readiness
// audit: src/components/today/Planner.tsx's "resume an existing draft for
// this date" effect used to depend on [date] ONLY. `date` is set once at
// mount (useState(tomorrowISO())) and never changes on its own, so on a
// fresh page load against a real (non-demo) backend, this effect's first
// run could race Firestore's "plans" listener — if the initial snapshot
// hadn't arrived yet, the effect concluded "no existing draft" using an
// empty/stale plans array, and since it never re-ran on its own, an
// already-existing draft or approved plan for that date would silently
// stay invisible for the rest of the session.
//
// Fixed by adding plansSync.hasSyncedOnce (useCollectionSyncStatus("plans"))
// to the effect's dependency array — it flips exactly once (false -> true)
// the moment the real first snapshot lands, giving the effect exactly one
// necessary extra run, and never fires again afterward.
//
// This test uses the established window.__CITY_OPS_TEST_BACKEND__ seam
// (same pattern as tests/multi-rig-business.regression.mjs) with an
// artificial delay on the FIRST "plans" snapshot only, to deterministically
// reproduce the exact race — proving the bug existed before the fix and is
// closed after it.
//
// Run with: npm run test:planner-plans-sync-race

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

// Mirrors Planner.tsx's own tomorrowISO() exactly.
function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

const PLANS_DELAY_MS = 800;

// A mock RemoteBackend where every collection's first snapshot fires
// immediately EXCEPT "plans", which is deliberately delayed — simulating a
// real Firestore onSnapshot listener that hasn't delivered its first
// result yet by the time the Planner component mounts and runs its
// draft-resume effect.
function buildInitScript(seedData) {
  return `
(function () {
  const SEED = ${JSON.stringify(seedData)};
  window.__CITY_OPS_TEST_BACKEND__ = {
    async putDoc() {},
    async deleteDoc() {},
    subscribeCollection(collection, cb) {
      const docs = SEED[collection] || [];
      if (collection === "plans") {
        setTimeout(() => cb(docs), ${PLANS_DELAY_MS});
      } else {
        cb(docs);
      }
      return () => {};
    },
  };
})();
`;
}

function emptyCityData(overrides = {}) {
  return {
    version: 2,
    settings: { cityName: "Planner Race Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
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

    const date = tomorrowISO();
    const now = new Date().toISOString();
    const business = { id: "biz_race_001", name: "Race Test Business", category: "Automotive Services", area: "Rajampet", address: "", active: true, capacityHoursPerDay: 3, createdAt: now };
    const fo = { id: "fo_race_001", name: "Race Test FO", active: true, createdAt: now };
    const rig = { id: "rig_race_001", name: "Rig R-RACE", deploymentStatus: "active", createdAt: now };
    const draftAssignment = {
      id: "asg_race_001",
      date,
      businessId: business.id,
      foId: fo.id,
      rigId: rig.id,
      plannedStart: `${date}T09:00:00.000Z`,
      plannedEnd: `${date}T11:00:00.000Z`,
      priority: "normal",
      status: "planned",
    };
    const existingPlan = {
      id: "plan_race_001",
      date,
      status: "draft",
      draftAssignments: [draftAssignment],
      aiSuggestedIds: [],
      assignmentIds: [],
      score: 80,
      scoreBreakdown: [],
      conflicts: [],
      createdAt: now,
    };

    const seedData = {
      businesses: [business],
      fos: [fo],
      rigs: [rig],
      assignments: [],
      plans: [existingPlan],
    };

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error("  [pageerror]", e.message));
    await page.addInitScript(buildInitScript(seedData));
    await seedManager(page, emptyCityData());

    console.log(`\n[race] Navigating to Today's Planner (tomorrow = ${date}) with a deliberately delayed "plans" snapshot (${PLANS_DELAY_MS}ms):`);
    const navigateStart = Date.now();
    await page.goto(`${BASE_URL}/today`);
    // The Planner lives under the "Planner" tab of /today — Timeline is the
    // default tab on load.
    await page.getByRole("tab", { name: "Planner" }).click();
    await page.waitForSelector('button:has-text("Generate AI Recommendations"), button:has-text("Regenerate AI Recommendations")');
    const elapsedAtFirstRender = Date.now() - navigateStart;

    if (elapsedAtFirstRender < PLANS_DELAY_MS) {
      const immediateButtonText = await page.locator('button:has-text("Generate AI Recommendations"), button:has-text("Regenerate AI Recommendations")').first().innerText();
      console.log(`    (at ${elapsedAtFirstRender}ms, before the delayed snapshot lands, button reads: "${immediateButtonText.trim()}")`);
    }

    console.log(`\n[race] Waiting for the delayed "plans" snapshot to land (>${PLANS_DELAY_MS}ms)...`);
    await sleep(PLANS_DELAY_MS + 400);

    const finalButton = page.locator('button:has-text("Generate AI Recommendations"), button:has-text("Regenerate AI Recommendations")').first();
    const finalButtonText = await finalButton.innerText();
    check(
      /Regenerate AI Recommendations/.test(finalButtonText),
      `[FIX] the existing draft plan for ${date} is picked up once the delayed "plans" snapshot lands (button now reads "${finalButtonText.trim()}", proving hasSyncedOnce re-triggered the resume effect)`,
    );

    const assignedCountTile = await page.locator("text=Assigned").locator("..").innerText().catch(() => "");
    check(/1/.test(assignedCountTile) || (await page.locator("text=Race Test Business").count()) > 0, "the resumed draft actually contains the seeded assignment (Race Test Business is visible somewhere in the plan)");

    // Sanity: switching the date away and back should still work (existing
    // behavior, unaffected by the fix) — the fix only ADDS a trigger, never
    // removes the original [date]-driven one.
    await page.locator('input[type="date"]').first().fill("2020-01-01");
    await sleep(150);
    const afterDateChange = await finalButton.innerText().catch(() => "");
    check(/Generate AI Recommendations/.test(afterDateChange) && !/Regenerate/.test(afterDateChange), "[unchanged] switching to an unrelated date still correctly shows no-draft state");
    await page.locator('input[type="date"]').first().fill(date);
    await sleep(150);
    const afterDateBack = await finalButton.innerText().catch(() => "");
    check(/Regenerate AI Recommendations/.test(afterDateBack), "[unchanged] switching back to the original date still correctly re-resumes the draft (the [date] trigger still works)");

    await ctx.close();

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
