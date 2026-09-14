// Regression test for: Manager Evidence Review's photo lightbox.
//
// REQUIRED BEHAVIOR: clicking an evidence photo thumbnail in Manager
// Evidence Review (src/components/forms/EvidenceReviewDialog.tsx) opens a
// large image viewer (max-width 95vw / max-height 90vh, object-fit:
// contain, dark backdrop, obvious close button, closes on backdrop click
// or Escape) showing the EXACT SAME resolved image src the thumbnail
// itself renders — never a second fetch, never a new storage path — and
// closing it returns to Evidence Review, never navigating away. Approve /
// Request Recheck / Reject controls, and evidence persistence/sync, are
// unaffected — this is a pure display-layer addition.
//
// Drives the REAL app UI (real FieldOfficerDetail "Review evidence" button,
// real EvidenceReviewDialog, real EvidenceThumb) via Playwright against a
// production build, in demo/local mode (a pure UI feature — no backend
// needed to prove it).
//
// Run with: npm run test:evidence-photo-lightbox

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4187;
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

// A real, tiny data: URI — resolvable by the browser with no network call,
// so useEvidenceDisplaySrc()'s localUrl fallback renders an actual decoded
// image (not a broken-image placeholder), and the test can assert on the
// exact string the thumbnail and the lightbox both use.
const ONE_PX_PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function seedManagerEvidenceScenario(page) {
  await page.evaluate((photoSrc) => {
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const business = { id: "biz_lb", name: "Lightbox Test Biz", category: "General", area: "Area", address: "", capacityHoursPerDay: 3, active: true, createdAt: now };
    const fo = { id: "fo_lb", name: "Lightbox Test FO", active: true, createdAt: now };
    const rig = { id: "rig_lb", code: "R-LB", model: "Test Rig", active: true, batteryPct: 100, storagePct: 0, deploymentStatus: "active", createdAt: now };
    const assignment = {
      id: "asg_lb",
      date: today,
      businessId: business.id,
      foId: fo.id,
      rigId: rig.id,
      plannedStart: `${today}T08:00:00.000Z`,
      plannedEnd: `${today}T11:00:00.000Z`,
      priority: "normal",
      status: "confirmed",
      actualArrivalAt: now,
      createdAt: now,
    };
    const photoFile = { id: "file_lb", name: "location-lb.png", type: "image/png", sizeBytes: 100, localUrl: photoSrc, capturedAt: now, uploadStatus: "local_only" };
    const locationEvidence = {
      id: "ev_location_lb",
      assignmentId: assignment.id,
      businessId: business.id,
      foId: fo.id,
      type: "LOCATION",
      startedAt: now,
      capturedAt: now,
      files: [photoFile],
      status: "submitted",
      metadata: { verified: true, message: "Within 40m of business" },
      createdAt: now,
    };
    const cityData = {
      version: 2,
      settings: { cityName: "Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
      businesses: [business],
      fos: [fo],
      collectors: [],
      rigs: [rig],
      assignments: [assignment],
      sessions: [],
      evidence: [locationEvidence],
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
  }, ONE_PX_PNG_DATA_URI);
}

async function getLocalEvidence(page) {
  return page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("city-ops-os") || "{}").state?.evidence ?? [];
    } catch {
      return [];
    }
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

    console.log("\n[1] Opening Manager Evidence Review and confirming the thumbnail renders:");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (err) => console.error("  [page error]", err.message));

    await page.goto(`${BASE_URL}/login`);
    await seedManagerEvidenceScenario(page);
    await page.goto(`${BASE_URL}/field-officers`);
    await page.waitForSelector('a[href^="/field-officers/"]', { timeout: 15000 });
    await page.click('a[href^="/field-officers/"]');
    await page.waitForSelector('button[title="Review evidence"]', { timeout: 15000 });
    await page.click('button[title="Review evidence"]');
    await page.waitForSelector("text=Evidence records", { timeout: 15000 });

    const thumbButton = page.getByRole("button", { name: "View location-lb.png full size" });
    check(await thumbButton.isVisible(), "the evidence photo thumbnail renders as a keyboard-accessible button with a descriptive accessible name");
    const thumbImg = page.locator('img[alt="location-lb.png"]').first();
    check(await thumbImg.isVisible(), "the thumbnail's <img> is visible with meaningful alt text");
    const thumbSrc = await thumbImg.getAttribute("src");
    check(thumbSrc === ONE_PX_PNG_DATA_URI, "the thumbnail renders the evidence file's actual resolved display src (localUrl fallback), not a placeholder");

    console.log("\n[2] Clicking the thumbnail opens the large image viewer:");
    await thumbButton.click();
    await sleep(300);
    // Two <img alt="location-lb.png"> now exist: the thumbnail (still
    // mounted underneath) and the lightbox's large image.
    const allMatchingImgs = page.locator('img[alt="location-lb.png"]');
    check((await allMatchingImgs.count()) === 2, "a second, large image element now renders (the lightbox), alongside the still-present thumbnail");
    const lightboxImg = allMatchingImgs.nth(1);
    check(await lightboxImg.isVisible(), "the lightbox image is visible");

    console.log("\n[3] The viewer shows the SAME image URL as the thumbnail:");
    const lightboxSrc = await lightboxImg.getAttribute("src");
    check(lightboxSrc === thumbSrc, `the lightbox's src is byte-identical to the thumbnail's src (no re-fetch, no new URL) — thumb="${thumbSrc?.slice(0, 40)}…" lightbox="${lightboxSrc?.slice(0, 40)}…"`);

    console.log("\n  Verifying the required sizing/fit CSS is applied:");
    const lightboxClass = (await lightboxImg.getAttribute("class")) ?? "";
    check(lightboxClass.includes("max-w-[95vw]"), "the lightbox image is capped at max-width: 95vw");
    check(lightboxClass.includes("max-h-[90vh]"), "the lightbox image is capped at max-height: 90vh");
    check(lightboxClass.includes("object-contain"), "the lightbox image uses object-fit: contain — preserves aspect ratio, never stretches/distorts");

    console.log("\n[4] The close (X) button closes the viewer, without navigating away from Evidence Review:");
    const closeBtn = page.getByRole("button", { name: "Close photo viewer" });
    check(await closeBtn.isVisible(), "an obvious, accessibly-labeled close button is present");
    await closeBtn.click();
    await sleep(300);
    check((await page.locator('img[alt="location-lb.png"]').count()) === 1, "the lightbox is closed — only the thumbnail's <img> remains");
    check(await page.locator("text=Evidence records").isVisible(), "Evidence Review itself is still open — closing the lightbox did not navigate away");

    console.log("\n[5] Clicking the backdrop closes the viewer:");
    await thumbButton.click();
    await sleep(300);
    check((await page.locator('img[alt="location-lb.png"]').count()) === 2, "(setup) lightbox is open again");
    // Click far in a corner, outside the centered image/close-button area —
    // lands on the Radix Overlay, which is what backdrop-click targets.
    await page.mouse.click(5, 5);
    await sleep(300);
    check((await page.locator('img[alt="location-lb.png"]').count()) === 1, "clicking the backdrop closed the lightbox");
    check(await page.locator("text=Evidence records").isVisible(), "Evidence Review remains open after a backdrop-click close");

    console.log("\n[6] Escape closes the viewer:");
    await thumbButton.click();
    await sleep(300);
    check((await page.locator('img[alt="location-lb.png"]').count()) === 2, "(setup) lightbox is open again");
    await page.keyboard.press("Escape");
    await sleep(300);
    check((await page.locator('img[alt="location-lb.png"]').count()) === 1, "Escape closed the lightbox");
    check(await page.locator("text=Evidence records").isVisible(), "Evidence Review remains open after an Escape close — Escape did not also close Evidence Review itself");

    console.log("\n[7] Existing Approve / Request Recheck / Reject controls still render and work:");
    check(await page.getByRole("button", { name: "Approve" }).first().isVisible(), "the per-evidence 'Approve' button still renders");
    check(await page.getByRole("button", { name: "Request Recheck" }).first().isVisible(), "the per-evidence 'Request Recheck' button still renders");
    check(await page.getByRole("button", { name: "Reject" }).first().isVisible(), "the per-evidence 'Reject' button still renders");
    await page.getByRole("button", { name: "Approve" }).first().click();
    await sleep(400);
    const evidenceAfterApprove = await getLocalEvidence(page);
    const approvedRecord = evidenceAfterApprove.find((e) => e.id === "ev_location_lb");
    check(approvedRecord?.status === "approved", `clicking Approve still works — the evidence record's status updates to 'approved' (got '${approvedRecord?.status}')`);

    console.log("\n[8] No changes to evidence persistence — the record's files/photo data is untouched by the viewer:");
    check(approvedRecord?.files?.length === 1, "the evidence record still has exactly one file (the lightbox never added/removed/duplicated a file)");
    check(approvedRecord?.files?.[0]?.localUrl === ONE_PX_PNG_DATA_URI, "the file's stored localUrl is byte-identical to what was seeded — the lightbox never rewrote it");
    check(approvedRecord?.files?.[0]?.id === "file_lb", "the file's id is unchanged — no new file record was created for the lightbox");

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
