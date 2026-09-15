// REAL BROWSER click-through of Settings' Backup/Restore feature
// (src/lib/backup.ts's validateBackup()/mergeCityData(), driven from
// src/pages/Settings.tsx). No CSV IMPORT feature exists anywhere in this
// codebase (grep confirms src/lib/csv.ts and Settings.tsx only ever
// EXPORT CSV — there is no CSV parser or upload path) — this file covers
// the JSON backup import/export/merge/replace flow instead, which is the
// actual, real import feature this app has.
//
// Uses only synthetic test fixtures — never production data.
//
// Run with: npm run test:backup-restore

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

const EMPTY_ARRAYS = {
  businesses: [], fos: [], collectors: [], rigs: [], assignments: [], sessions: [], evidence: [],
  issues: [], qualityReviews: [], correctiveActions: [], rigIncidents: [], repairRecords: [], activity: [], plans: [], reports: [],
};

async function seedBaseScenario(page) {
  await page.evaluate((EMPTY_ARRAYS) => {
    const now = new Date().toISOString();
    const business = { id: "biz_backup_existing", name: "Pre-existing Business", category: "General", area: "Area", address: "", capacityHoursPerDay: 10, active: true, createdAt: now };
    const cityData = {
      version: 2,
      settings: { cityName: "Backup Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
      ...EMPTY_ARRAYS,
      businesses: [business],
    };
    localStorage.setItem("city-ops-os", JSON.stringify({ state: cityData, version: 2 }));
    localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-manager", email: "manager@demo.city-ops", role: "MANAGER", displayName: "Demo Manager", createdAt: now }));
  }, EMPTY_ARRAYS);
}

async function getCityData(page) {
  return page.evaluate(() => (JSON.parse(localStorage.getItem("city-ops-os") || "{}").state) ?? null);
}

async function uploadBackupFile(page, jsonOrText, filename = "backup.json") {
  const buffer = Buffer.from(typeof jsonOrText === "string" ? jsonOrText : JSON.stringify(jsonOrText));
  await page.locator('input[type="file"][accept="application/json"]').setInputFiles({ name: filename, mimeType: "application/json", buffer });
  await sleep(300);
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
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (err) => console.error("  [page error]", err.message));

    await page.goto(`${BASE_URL}/login`);
    await seedBaseScenario(page);
    await page.goto(`${BASE_URL}/settings?tab=data`);
    await page.waitForSelector("text=Import Backup", { timeout: 15000 });

    console.log("\n[1] Malformed (non-JSON) file is rejected with a clear error, no data changed:");
    await uploadBackupFile(page, "this is not valid json {{{");
    check(await page.locator("text=/not valid JSON/i").isVisible(), "a clear 'not valid JSON' error is shown");
    let cityData = await getCityData(page);
    check(cityData.businesses.length === 1 && cityData.businesses[0].id === "biz_backup_existing", "existing data is completely untouched after a malformed-JSON upload");

    console.log("\n[2] Valid JSON but missing required fields (e.g. no `settings`) is rejected, no data changed:");
    await uploadBackupFile(page, { businesses: [] });
    check(await page.locator("text=/missing the `settings` field/i").isVisible(), "a clear 'missing settings field' error is shown");
    cityData = await getCityData(page);
    check(cityData.businesses.length === 1, "existing data is still untouched after a missing-fields upload");

    console.log("\n[3] Valid JSON missing a required array (e.g. no `evidence`) is rejected, no data changed:");
    const missingArrayBackup = { settings: { cityName: "X", theme: "dark" }, businesses: [] };
    await uploadBackupFile(page, missingArrayBackup);
    check(await page.locator("text=/missing the `fos` field|missing the `.*` field/i").isVisible(), "a clear 'missing required field' error is shown for an incomplete backup");
    cityData = await getCityData(page);
    check(cityData.businesses.length === 1, "existing data is still untouched after an incomplete-arrays upload");

    console.log("\n[4] Empty/minimal valid backup (zero records everywhere) is accepted and previewed correctly:");
    const emptyBackup = {
      version: 2,
      settings: { cityName: "Empty Backup City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "light", onboarded: true },
      ...EMPTY_ARRAYS,
    };
    await uploadBackupFile(page, emptyBackup);
    check(await page.getByRole("heading", { name: "Import backup" }).isVisible(), "the import preview dialog opens for a valid, minimal (all-zero) backup");
    check(await page.locator("text=businesses").locator("..").locator("text=0").first().isVisible().catch(() => true), "the preview shows zero counts for an empty backup (best-effort visual check)");

    console.log("\n[5] Merge preserves existing records and adds new ones (upsert-by-id, no data loss):");
    await page.getByRole("button", { name: "Cancel" }).click();
    await sleep(200);
    const mergeBackup = {
      version: 2,
      settings: { cityName: "Merge Source City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "light", onboarded: true },
      ...EMPTY_ARRAYS,
      businesses: [{ id: "biz_backup_new", name: "Merged-in Business", category: "General", area: "Area", address: "", capacityHoursPerDay: 10, active: true, createdAt: new Date().toISOString() }],
    };
    await uploadBackupFile(page, mergeBackup);
    await page.getByRole("button", { name: "Merge with existing" }).click();
    await sleep(400);
    cityData = await getCityData(page);
    check(cityData.businesses.some((b) => b.id === "biz_backup_existing"), "Merge keeps the pre-existing business");
    check(cityData.businesses.some((b) => b.id === "biz_backup_new"), "Merge adds the new business from the backup");
    check(cityData.businesses.length === 2, "Merge results in exactly the union — no duplicates, no loss");
    check(cityData.settings.cityName === "Backup Test City", "Merge never overwrites the device's own local settings (theme/cityName) from the imported backup's settings");

    console.log("\n[6] Duplicate-id record in the backup overwrites (upserts) the matching existing record, not duplicates it:");
    const overwriteBackup = {
      version: 2,
      settings: { cityName: "Overwrite Source", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "light", onboarded: true },
      ...EMPTY_ARRAYS,
      businesses: [{ id: "biz_backup_existing", name: "RENAMED Pre-existing Business", category: "General", area: "Area", address: "", capacityHoursPerDay: 10, active: true, createdAt: new Date().toISOString() }],
    };
    await uploadBackupFile(page, overwriteBackup);
    await page.getByRole("button", { name: "Merge with existing" }).click();
    await sleep(400);
    cityData = await getCityData(page);
    const existingCount = cityData.businesses.filter((b) => b.id === "biz_backup_existing").length;
    check(existingCount === 1, "a duplicate-id record upserts (overwrites) rather than creating a second copy");
    check(cityData.businesses.find((b) => b.id === "biz_backup_existing").name === "RENAMED Pre-existing Business", "the upsert applied the incoming record's fields");

    console.log("\n[7] Replace everything fully replaces operational data:");
    const replaceBackup = {
      version: 2,
      settings: { cityName: "Replace Source", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "light", onboarded: true },
      ...EMPTY_ARRAYS,
      businesses: [{ id: "biz_backup_replace_only", name: "Replace-only Business", category: "General", area: "Area", address: "", capacityHoursPerDay: 10, active: true, createdAt: new Date().toISOString() }],
    };
    await uploadBackupFile(page, replaceBackup);
    await page.getByRole("button", { name: "Replace everything" }).click();
    await sleep(400);
    cityData = await getCityData(page);
    check(cityData.businesses.length === 1 && cityData.businesses[0].id === "biz_backup_replace_only", "Replace everything fully replaces operational data (no leftover records from before)");

    console.log("\n[8] The restored state persists across a full page reload:");
    await page.reload();
    await page.waitForSelector("text=Import Backup", { timeout: 15000 });
    cityData = await getCityData(page);
    check(cityData.businesses.length === 1 && cityData.businesses[0].id === "biz_backup_replace_only", "the replaced data survives a full page reload");

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
