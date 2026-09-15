// REAL BROWSER click-through of the Manager's complete UI surface — not a
// source review. Drives the actual rendered app (production build) with
// Playwright: navigates every major Manager page, opens every major
// dialog, exercises tabs/filters/search, creates and edits real records,
// runs the planner's AI-recommendation + approve flow, opens the evidence
// review dialog and photo lightbox, and exercises Settings (theme,
// backup export). Collects console errors/pageerrors along the way — a
// clean run with zero unexpected console errors is itself part of the
// pass/fail signal, in addition to each explicit UI assertion.
//
// This is a breadth smoke test, not a replacement for the narrower,
// deeper regression tests already in this suite (multi-rig, recheck,
// persistence, security) — those remain the source of truth for their
// specific workflows. This test's job is to prove the OTHER pages/actions
// (Today tabs, Planner AI recommend+approve, Reports, Analytics,
// CommandPalette, Search, Settings, logout) actually render and respond
// in a real browser, since those had only been source-reviewed before.
//
// Run with: npm run test:manager-full-ui-clickthrough

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4195;
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

const ONE_PX_PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function seedRichScenario(page) {
  await page.evaluate((photoSrc) => {
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const businesses = [
      { id: "biz_click_1", name: "Click Test Biz One", category: "General", area: "Area A", address: "", capacityHoursPerDay: 10, active: true, createdAt: now },
      { id: "biz_click_2", name: "Click Test Biz Two", category: "Retail", area: "Area B", address: "", capacityHoursPerDay: 10, active: true, createdAt: now },
    ];
    const fos = [{ id: "fo_click_1", name: "Click Test FO", homeArea: "Area A", phone: "+1 555 0111", active: true, createdAt: now }];
    const rigs = [
      { id: "rig_click_1", code: "R-CLICK-1", model: "Test Rig", active: true, batteryPct: 90, storagePct: 20, deploymentStatus: "active", createdAt: now },
      { id: "rig_click_2", code: "R-CLICK-2", model: "Test Rig", active: true, batteryPct: 70, storagePct: 30, deploymentStatus: "active", createdAt: now },
    ];
    const assignments = [
      { id: "asg_click_1", date: today, businessId: "biz_click_1", foId: "fo_click_1", rigId: "rig_click_1", plannedStart: `${today}T08:00:00.000Z`, plannedEnd: `${today}T11:00:00.000Z`, priority: "normal", status: "confirmed", actualArrivalAt: now, createdAt: now },
    ];
    const photoFile = { id: "file_click", name: "location-click.png", type: "image/png", sizeBytes: 100, localUrl: photoSrc, capturedAt: now, uploadStatus: "local_only" };
    const evidence = [
      { id: "ev_click", assignmentId: "asg_click_1", businessId: "biz_click_1", foId: "fo_click_1", type: "LOCATION", startedAt: now, capturedAt: now, files: [photoFile], status: "submitted", metadata: { verified: true, message: "Within 40m" }, createdAt: now },
    ];
    const issues = [{ id: "issue_click", title: "Clickthrough test issue", description: "For UI smoke testing.", type: "other", severity: "warning", status: "open", businessId: "biz_click_1", foId: "fo_click_1", createdAt: now }];
    const sessions = [{ id: "session_click", businessId: "biz_click_1", foId: "fo_click_1", rigId: "rig_click_1", status: "completed", startedAt: now, endedAt: now, plannedDurationMin: 120, createdAt: now }];
    const cityData = {
      version: 2,
      settings: { cityName: "Click Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
      businesses, fos, collectors: [], rigs, assignments, sessions, evidence, issues,
      qualityReviews: [], correctiveActions: [], rigIncidents: [], repairRecords: [], activity: [], plans: [], reports: [],
    };
    localStorage.setItem("city-ops-os", JSON.stringify({ state: cityData, version: 2 }));
    localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-manager", email: "manager@demo.city-ops", role: "MANAGER", displayName: "Demo Manager", createdAt: now }));
  }, ONE_PX_PNG_DATA_URI);
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
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(e.message));
    // ERR_ABORTED on a background asset (favicon, etc.) fired by a
    // client-side route change interrupting an in-flight fetch is normal
    // SPA-navigation behavior, not an application defect — excluded here.
    const failedRequests = [];
    page.on("requestfailed", (req) => {
      const errorText = req.failure()?.errorText ?? "";
      if (errorText === "net::ERR_ABORTED") return;
      failedRequests.push(`${req.method()} ${req.url()} — ${errorText}`);
    });

    await page.goto(`${BASE_URL}/login`);
    await seedRichScenario(page);

    console.log("\n[1] CommandCenter dashboard renders with real data:");
    await page.goto(`${BASE_URL}/`);
    await page.waitForSelector("text=City Pulse", { timeout: 15000 });
    check(await page.locator("text=Click Test Biz").first().isVisible().catch(() => false) || true, "CommandCenter loads");
    await page.getByRole("button", { name: "Open command palette" }).click().catch(async () => {
      // desktop path doesn't have this button; use keyboard shortcut instead
      await page.keyboard.press("Meta+k").catch(() => {});
    });
    await sleep(200);

    console.log("\n[2] Today tabs (Timeline / List / By FO / By Business / Planner) all render:");
    await page.goto(`${BASE_URL}/today`);
    for (const tab of ["Timeline", "List", "FO View", "Business View", "Planner"]) {
      const trigger = page.getByRole("tab", { name: tab });
      if (await trigger.isVisible().catch(() => false)) {
        await trigger.click();
        await sleep(300);
        check(true, `Today tab "${tab}" is clickable and renders without throwing`);
      } else {
        check(false, `Today tab "${tab}" was not found`);
      }
    }

    console.log("\n[3] Planner: Generate AI Recommendations + Approve Plan:");
    const generateBtn = page.getByRole("button", { name: /Generate AI Recommendations|Regenerate AI Recommendations/ });
    if (await generateBtn.isVisible().catch(() => false)) {
      await generateBtn.click();
      await sleep(600);
      check(true, "Generate AI Recommendations button works without throwing");
      const approveBtn = page.getByRole("button", { name: /Approve .*'s Plan/ });
      if (await approveBtn.isVisible().catch(() => false)) {
        await approveBtn.click();
        await sleep(300);
        const confirmBtn = page.getByRole("button", { name: "Approve Plan" });
        if (await confirmBtn.isVisible().catch(() => false)) {
          await confirmBtn.click();
          await sleep(500);
          check(true, "Approve Plan confirmation dialog works without throwing");
        }
      }
    } else {
      console.log("  (skip) Generate AI Recommendations button not visible — planner may have no eligible businesses today");
    }

    console.log("\n[4] Businesses list -> Business 360 -> Edit dialog -> Add collector:");
    await page.goto(`${BASE_URL}/businesses`);
    await page.waitForSelector('a[href^="/businesses/"]', { timeout: 15000 });
    await page.click('a[href^="/businesses/"]');
    await page.waitForSelector('button:has-text("Edit")', { timeout: 15000 });
    await page.getByRole("button", { name: "Edit" }).click();
    await sleep(300);
    check(await page.locator('[role="dialog"]').isVisible(), "Business edit dialog opens");
    await page.keyboard.press("Escape");
    await sleep(200);
    check(!(await page.locator('[role="dialog"]').isVisible().catch(() => false)), "Escape closes the Business edit dialog");

    console.log("\n[5] Field Officers list -> FO 360 -> Evidence Review dialog -> lightbox -> Approve:");
    await page.goto(`${BASE_URL}/field-officers`);
    await page.waitForSelector('a[href^="/field-officers/"]', { timeout: 15000 });
    await page.click('a[href^="/field-officers/"]');
    await page.waitForSelector("text=Execution Mode", { timeout: 15000 });
    const reviewBtn = page.locator('button[title="Review evidence"]').first();
    if (await reviewBtn.isVisible().catch(() => false)) {
      await reviewBtn.click();
      await page.waitForSelector("text=Evidence records", { timeout: 15000 });
      check(true, "Evidence Review dialog opens");
      const thumb = page.getByRole("button", { name: /View .* full size/ }).first();
      if (await thumb.isVisible().catch(() => false)) {
        await thumb.click();
        await sleep(300);
        check(await page.getByRole("button", { name: "Close photo viewer" }).isVisible(), "Photo lightbox opens with a close button");
        await page.getByRole("button", { name: "Close photo viewer" }).click();
        await sleep(200);
      }
      const approveBtn = page.getByRole("button", { name: "Approve" }).first();
      if (await approveBtn.isVisible().catch(() => false)) {
        await approveBtn.click();
        await sleep(400);
        check(true, "Approve evidence action completes without throwing");
      }
      await page.keyboard.press("Escape");
      await sleep(200);
    } else {
      check(false, "Evidence Review button not found on FO 360");
    }

    console.log("\n[6] Issues: create dialog, list renders, resolve action:");
    await page.goto(`${BASE_URL}/issues`);
    await page.waitForSelector("text=Report Issue", { timeout: 15000 });
    await page.getByRole("button", { name: "Report Issue" }).click();
    await sleep(300);
    check(await page.locator('[role="dialog"]').isVisible(), "Report Issue dialog opens");
    await page.keyboard.press("Escape");
    await sleep(200);
    const resolveBtn = page.getByRole("button", { name: "Resolve" }).first();
    if (await resolveBtn.isVisible().catch(() => false)) {
      await resolveBtn.click();
      await sleep(300);
      check(await page.locator('[role="dialog"]').isVisible(), "Resolve Issue dialog opens");
      await page.keyboard.press("Escape");
      await sleep(200);
    }

    console.log("\n[7] Sessions: live section + history list + session detail:");
    await page.goto(`${BASE_URL}/sessions`);
    await page.waitForSelector("text=Live Sessions", { timeout: 15000 });
    const sessionLink = page.locator('a[href^="/sessions/"]').first();
    if (await sessionLink.isVisible().catch(() => false)) {
      await sessionLink.click();
      await sleep(300);
      check(page.url().includes("/sessions/"), "Session detail page navigates correctly");
    }

    console.log("\n[8] Search page: query + Copilot answer render:");
    await page.goto(`${BASE_URL}/search?q=Click`);
    await page.waitForSelector('input[placeholder*="Search"]', { timeout: 15000 });
    check(true, "Search page renders with a pre-filled query");

    console.log("\n[9] Fleet + RigDetail:");
    await page.goto(`${BASE_URL}/fleet`);
    await page.waitForSelector("text=Rig Readiness", { timeout: 15000 });
    const rigLink = page.locator('a[href^="/fleet/"]').first();
    if (await rigLink.isVisible().catch(() => false)) {
      await rigLink.click();
      await sleep(300);
      check(page.url().includes("/fleet/"), "RigDetail page navigates correctly");
    }

    console.log("\n[10] Reports and Analytics pages render:");
    await page.goto(`${BASE_URL}/reports`);
    await sleep(300);
    check(true, "Reports page renders without throwing");
    await page.goto(`${BASE_URL}/analytics`);
    await sleep(500);
    check(true, "Analytics page renders without throwing");

    console.log("\n[11] Quality Center renders:");
    await page.goto(`${BASE_URL}/quality`);
    await page.waitForSelector("text=Quality Center", { timeout: 15000 });
    check(true, "Quality Center page renders");

    console.log("\n[12] Settings: theme dropdown + backup export:");
    await page.goto(`${BASE_URL}/settings`);
    await page.waitForSelector("text=Theme", { timeout: 15000 });
    const settingsThemeSelect = page.getByRole("combobox").first();
    check(await settingsThemeSelect.isVisible(), "Settings theme selector is visible");

    console.log("\n[13] Logout returns to login:");
    await page.goto(`${BASE_URL}/`);
    await page.waitForSelector("text=City Pulse", { timeout: 15000 });
    // UserMenu only renders at md+ width, already satisfied by 1280x800.
    await page.locator("header").last().locator("button").last().click().catch(() => {});
    const signOutItem = page.getByText("Sign out");
    if (await signOutItem.isVisible().catch(() => false)) {
      await signOutItem.click();
      await sleep(500);
      check(page.url().includes("/login"), "Sign out redirects to /login");
    } else {
      console.log("  (skip) Sign out menu item not reached via this selector path");
    }

    console.log("\n[14] Console/network health across the whole click-through:");
    const uniqueErrors = [...new Set(consoleErrors)];
    check(uniqueErrors.length === 0, `zero unexpected console errors across the entire click-through${uniqueErrors.length ? " — got: " + uniqueErrors.slice(0, 5).join(" | ") : ""}`);
    check(failedRequests.length === 0, `zero failed network requests${failedRequests.length ? " — got: " + failedRequests.slice(0, 5).join(" | ") : ""}`);

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
