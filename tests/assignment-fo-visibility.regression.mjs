// Regression test (F): a Manager-created, rig-less assignment must actually
// reach the correctly-assigned Field Officer's Today's Plan — the full
// chain this session's investigation traced: Manager UI -> local store ->
// outbox -> "Firestore" putDoc -> FO's ownership-scoped listener ->
// mergeRemoteCollection -> Today's Plan render.
//
// Drives the REAL app UI (real AssignmentFormDialog, real FOExecution
// Today's Plan) via Playwright against a production build, using the
// established __CITY_OPS_TEST_BACKEND__ seam so no live Firebase project is
// needed. The mock backend is deliberately backed by localStorage (not an
// in-memory JS object) so it survives the full page reload used to switch
// from the Manager's browser session to the FO's — otherwise the test would
// trivially "pass" by reading the Manager's own locally-persisted Zustand
// store instead of proving anything went through the sync path at all.
//
// Run with: npm run test:assignment-fo-visibility

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4178;
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

// Injected before every navigation. Backed by localStorage (not a JS
// closure) so it survives the full-page reload used to switch identity —
// simulating a genuinely separate remote Firestore that both the Manager's
// and the FO's "devices" independently sync against.
const MOCK_BACKEND_INIT_SCRIPT = `
(function () {
  const MOCK_KEY = "__mock_firestore_store__";
  function readStore() {
    try { return JSON.parse(localStorage.getItem(MOCK_KEY) || "{}"); } catch { return {}; }
  }
  function writeStore(store) {
    localStorage.setItem(MOCK_KEY, JSON.stringify(store));
  }
  window.__CITY_OPS_TEST_BACKEND__ = {
    async putDoc(collection, id, data) {
      // Mirror the real Firestore Web SDK's client-side rejection of any
      // explicit undefined field value (setDoc's actual behavior) — a mock
      // that silently accepted it would let this test pass even if the
      // AssignmentFormDialog fix were reverted. Scoped to "assignments"
      // only: this session's investigation also found the SAME "x ||
      // undefined" pattern in FOFormDialog.tsx (phone, homeArea) and
      // BusinessFormDialog.tsx (googleMapsUrl, contactName, contactPhone,
      // preferredWindowStart/End, notes) when those optional fields are
      // left blank — real, separate bugs, but explicitly out of scope for
      // this commit (see the final report). Enforcing strictly on every
      // collection here would make this test fail on THOSE pre-existing
      // bugs while creating its own setup data, instead of testing the one
      // fix this commit actually makes.
      if (collection === "assignments") {
        for (const key of Object.keys(data)) {
          if (data[key] === undefined) {
            throw new Error("Unsupported field value: undefined (found in field " + key + ")");
          }
        }
      }
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
    subscribeCollection(collection, cb, scope) {
      const emit = () => {
        const store = readStore();
        let docs = Object.values(store[collection] || {});
        if (scope && scope.foId) docs = docs.filter((d) => d.foId === scope.foId);
        cb(docs);
      };
      emit();
      return () => {};
    },
  };
})();
`;

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
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(MOCK_BACKEND_INIT_SCRIPT);
    page.on("pageerror", (err) => console.error("  [page error]", err.message));

    console.log("\nSigning in as demo Manager and starting a blank city...");
    // Deliberately NOT "Load Demo City": that path is local-only by design
    // (Onboarding.tsx: "Demo data must never reach a shared production
    // backend") and bulk-replaces the store outside the normal addX()
    // diff/enqueue path — combining it with an active __CITY_OPS_TEST_BACKEND__
    // races the listener's first (empty) snapshot against the just-loaded
    // local data and wipes it. Building the city through the real
    // "Add Field Officer" / "Add Business" forms exercises the exact same
    // addFO()/addBusiness()/addAssignment() single-record path a real
    // Manager's production writes go through, with no such race.
    await page.goto(`${BASE_URL}/login`);
    await page.click("text=Continue as Manager");
    await page.waitForSelector("text=Start My City", { timeout: 15000 });
    await page.click("text=Start My City");
    await page.click('button:has-text("Start my city")');
    await page.waitForURL(/\/(today)?$/, { timeout: 15000 }).catch(() => {});
    await sleep(500);

    console.log("Adding one Field Officer and one Business through the real forms...");
    // Client-side <NavLink> clicks, NOT page.goto() — goto() is a hard
    // reload that resets every in-memory module (syncEngine's `started`
    // flag included) and can abort an outbox write that hasn't drained yet,
    // silently losing the record. A real Manager never triggers a reload
    // just by clicking around the sidebar, so neither should this test.
    await page.click('a[href="/field-officers"]');
    await page.getByRole("button", { name: "Add Field Officer" }).first().click();
    const foDialog = page.locator('[role="dialog"]');
    await foDialog.locator("#fo-name").fill("Regression Test FO");
    await foDialog.getByRole("button", { name: "Add field officer", exact: true }).click();
    await page.waitForSelector('[role="dialog"]', { state: "hidden", timeout: 15000 }).catch(() => {});
    await sleep(800); // let the store mutation -> outbox -> mock putDoc chain settle before any navigation

    await page.click('a[href="/businesses"]');
    await page.getByRole("button", { name: "Add Business" }).first().click();
    const bizDialog = page.locator('[role="dialog"]');
    await bizDialog.locator("#biz-name").fill("Regression Test Business");
    await bizDialog.locator("#biz-area").fill("Test Area");
    await bizDialog.getByRole("button", { name: "Add business", exact: true }).click();
    await page.waitForSelector('[role="dialog"]', { state: "hidden", timeout: 15000 }).catch(() => {});
    await sleep(800);

    console.log("Opening the new Field Officer's detail page...");
    await page.click('a[href="/field-officers"]');
    await page.waitForSelector('a[href^="/field-officers/"]', { timeout: 15000 });
    const href = await page.getAttribute('a[href^="/field-officers/"]', "href");
    const foId = href.split("/field-officers/")[1];
    check(!!foId, `resolved the target FO id (${foId})`);
    await page.click('a[href^="/field-officers/"]');
    await page.waitForSelector("text=Assign rig", { timeout: 15000 });

    console.log("Creating a rig-less assignment via the real AssignmentFormDialog (no rig selected)...");
    await page.getByRole("button", { name: "Assign rig" }).click();
    const assignDialog = page.locator('[role="dialog"]');
    await assignDialog.locator("text=Select business").waitFor({ timeout: 15000 });
    // Select the first real business in the dropdown; deliberately never touch the Rig selector (stays "No rig").
    await assignDialog.getByRole("combobox").nth(1).click();
    const businessOption = page.locator('[role="option"]:not([data-disabled])').first();
    const businessName = (await businessOption.textContent())?.trim();
    await businessOption.click();
    await assignDialog.getByRole("button", { name: "Add assignment", exact: true }).click();
    await page.waitForSelector('[role="dialog"]', { state: "hidden", timeout: 15000 }).catch(() => {});
    await sleep(1500); // let the store mutation -> outbox -> mock putDoc chain settle

    console.log("\nVerifying the mock \"Firestore\" store received the assignment correctly:");
    const mockStore = await page.evaluate(() => JSON.parse(localStorage.getItem("__mock_firestore_store__") || "{}"));
    const assignments = Object.values(mockStore.assignments ?? {});
    const created = assignments.find((a) => a.foId === foId && a.businessId);
    check(!!created, "the new assignment document exists in the mock Firestore store");
    check(created ? !("rigId" in created) : false, "the stored document has NO rigId property (rig-less path)");
    check(created ? !Object.values(created).includes(undefined) : false, "the stored document has no undefined field values");
    const todayDate = created?.date;
    check(!!todayDate, `assignment was stored with a date (${todayDate})`);

    console.log("\nSwitching to the assigned FO's own device (separate local store, same remote mock backend)...");
    await page.evaluate((assignedFoId) => {
      // Wipe THIS "device's" local Zustand persistence — simulating the
      // FO's own phone, which never had the Manager's local state — while
      // leaving the mock remote Firestore store intact. If the assignment
      // still shows up after this, it can only have arrived via the real
      // sync/listener path, not local storage the Manager already wrote.
      localStorage.removeItem("city-ops-os");
      const user = {
        id: "demo-fo-test-" + assignedFoId,
        email: "test-fo@demo.city-ops",
        role: "FIELD_OFFICER",
        displayName: "Test FO",
        foId: assignedFoId,
        createdAt: new Date().toISOString(),
      };
      localStorage.setItem("city-ops-auth", JSON.stringify(user));
    }, foId);
    await page.goto(`${BASE_URL}/fo`);
    await page.waitForSelector("text=Today", { timeout: 15000 });
    await sleep(1500); // let the FO's own sync engine subscribe + merge

    console.log("\n[F] FO Today's Plan renders the assignment for the correct date:");
    const bodyText = await page.evaluate(() => document.body.innerText);
    check(!bodyText.includes("No visits scheduled today"), 'Today\'s Plan no longer shows "No visits scheduled today"');
    check(businessName ? bodyText.includes(businessName) : false, `Today's Plan shows the assigned business ("${businessName}")`);

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
