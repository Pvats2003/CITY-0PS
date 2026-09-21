// Regression test for src/data/outbox.ts's drainOutbox() reentrancy guard
// (the `draining`/`drainQueued` module-level flags) — requested twice in the
// second deep audit pass's "outbox/offline concurrency" section: prove,
// against a REAL production build and the REAL syncEngine/outbox code (not
// a reimplementation), that two overlapping drain triggers caused by ONE
// user action never produce a duplicate Firestore write.
//
// src/store/city.ts's addBusiness() performs two SEPARATE synchronous
// Zustand `set()` calls (push the business, then logActivity's own push) —
// see syncEngine.ts's attachLocalWatcher() doc comment, which documents
// this exact shape as the real-world trigger for two independently
// scheduled `drainOutbox()` calls arriving close together. Without the
// `draining`/`drainQueued` guard, both calls can read the same
// not-yet-deleted outbox entry and both call `backend.putDoc()` for it — a
// real duplicate write, proven via a production-build reproduction per that
// comment. This test drives the REAL "Add Business" UI form (not a
// synthetic store call) against a mock backend whose putDoc() is
// deliberately slow (400ms) and counts calls per document id, so any
// duplicate-write window has ample time to manifest, then asserts every
// document was written EXACTLY ONCE.
//
// It also proves the complementary "no lost mutations" direction: every
// document addBusiness() should produce (the business itself + its
// activity log entry) actually reaches the mock backend at least once.
//
// This does NOT clear the outbox at any point — IndexedDB (and therefore
// the outbox) is torn down only by closing the browser context at the very
// end, the normal cleanup for a Playwright test, not a mechanism to force
// tests green.
//
// Run with: npm run test:outbox-drain-reentrancy

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4199;
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

// A mock RemoteBackend whose putDoc() is slow (so two overlapping drains
// have a real window to both attempt the same write) and records every
// call it ever receives, keyed by collection+id, so the test can assert
// "exactly once" rather than merely "eventually present".
const PUT_DELAY_MS = 400;
const INIT_SCRIPT = `
(function () {
  const MOCK_KEY = "__mock_firestore_store__";
  function readStore() {
    try { return JSON.parse(localStorage.getItem(MOCK_KEY) || "{}"); } catch { return {}; }
  }
  function writeStore(store) {
    localStorage.setItem(MOCK_KEY, JSON.stringify(store));
  }
  window.__CITY_OPS_PUT_CALLS__ = [];
  window.__CITY_OPS_TEST_BACKEND__ = {
    async putDoc(collection, id, data) {
      window.__CITY_OPS_PUT_CALLS__.push({ collection, id, at: Date.now() });
      await new Promise((r) => setTimeout(r, ${PUT_DELAY_MS}));
      const store = readStore();
      store[collection] = store[collection] || {};
      store[collection][id] = data;
      writeStore(store);
    },
    async deleteDoc(collection, id) {
      const store = readStore();
      if (store[collection]) delete store[collection][id];
      writeStore(store);
    },
    subscribeCollection(collection, cb) {
      const store = readStore();
      cb(Object.values(store[collection] || {}));
      return () => {};
    },
  };
})();
`;

async function seedManager(page) {
  await page.goto(`${BASE_URL}/login`);
  await page.evaluate(() => {
    const now = new Date().toISOString();
    const cityData = {
      version: 2,
      settings: { cityName: "Outbox Reentrancy Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
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
    };
    localStorage.setItem("city-ops-os", JSON.stringify({ state: cityData, version: 2 }));
    localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-manager", email: "manager@demo.city-ops", role: "MANAGER", displayName: "Demo Manager", createdAt: now }));
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

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error("  [pageerror]", e.message));
    await page.addInitScript(INIT_SCRIPT);
    await seedManager(page);

    console.log("\n[reentrancy] Adding THREE businesses back-to-back — each addBusiness() call performs two separate synchronous store mutations (the business itself, then its activity log entry), each of which independently schedules its own drainOutbox() call per syncEngine.ts's attachLocalWatcher():");
    await page.goto(`${BASE_URL}/businesses`);
    await page.waitForSelector('button:has-text("Add Business")');

    const businessNames = ["Reentrancy Test Biz One", "Reentrancy Test Biz Two", "Reentrancy Test Biz Three"];
    for (const name of businessNames) {
      await page.locator('button:has-text("Add Business")').first().click();
      await page.locator("#biz-name").fill(name);
      await page.locator("#biz-area").fill("Test Area");
      // Scoped to the dialog itself (exact, case-sensitive match) — the
      // page also has "Add Business" trigger buttons whose text
      // case-insensitively collides with the dialog's own "Add business"
      // submit button under Playwright's default :has-text() matching.
      await page.getByRole("dialog").getByRole("button", { name: "Add business", exact: true }).click();
      // No wait here — the whole point is to fire the next addBusiness()
      // trigger while the previous one's drainOutbox() (and its 400ms-slow
      // putDoc calls) may still be in flight, maximizing the reentrancy
      // window rather than serializing it away.
    }

    console.log("\n[reentrancy] Waiting for every enqueued write to actually settle...");
    // 3 businesses x 2 docs each (business + activity) x PUT_DELAY_MS,
    // plus generous headroom for the drain-queue retry pass.
    await sleep(businessNames.length * 2 * PUT_DELAY_MS + 3000);

    const putCalls = await page.evaluate(() => window.__CITY_OPS_PUT_CALLS__);
    const businessCalls = putCalls.filter((c) => c.collection === "businesses");
    const activityCalls = putCalls.filter((c) => c.collection === "activity");

    check(businessCalls.length === businessNames.length, `exactly ${businessNames.length} 'businesses' putDoc call(s) total across all 3 additions (got ${businessCalls.length}) — no lost, no duplicated`);
    check(activityCalls.length === businessNames.length, `exactly ${businessNames.length} 'activity' putDoc call(s) total (got ${activityCalls.length}) — no lost, no duplicated`);

    const businessIdCounts = new Map();
    for (const c of businessCalls) businessIdCounts.set(c.id, (businessIdCounts.get(c.id) ?? 0) + 1);
    const activityIdCounts = new Map();
    for (const c of activityCalls) activityIdCounts.set(c.id, (activityIdCounts.get(c.id) ?? 0) + 1);

    check(businessIdCounts.size === businessNames.length, `${businessNames.length} DISTINCT business document ids were written (got ${businessIdCounts.size} distinct ids) — confirms 3 real businesses, not 3 collapsed into fewer`);
    check([...businessIdCounts.values()].every((n) => n === 1), `every individual business document id was written EXACTLY ONCE (counts: ${JSON.stringify([...businessIdCounts.values()])}) — the reentrancy guard prevented a duplicate write despite overlapping drains`);
    check([...activityIdCounts.values()].every((n) => n === 1), `every individual activity document id was written EXACTLY ONCE (counts: ${JSON.stringify([...activityIdCounts.values()])})`);

    console.log("\n[convergence] Reloading — the store's persisted state must show all 3 businesses, proving no mutation was silently lost:");
    await page.reload();
    await page.waitForSelector("text=Reentrancy Test Biz One");
    for (const name of businessNames) {
      check(await page.locator(`text=${name}`).first().isVisible().catch(() => false), `"${name}" is visible after reload (persisted correctly, nothing lost)`);
    }

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
