// REAL BROWSER tests for City Copilot (src/engine/copilot.ts, rendered via
// src/pages/SearchPage.tsx). Copilot is a deterministic, rule-based
// pattern-matcher over local data — not an LLM — so this file does NOT
// judge answer "intelligence." It tests exactly what's testable and
// meaningful for a deterministic system: input handling, missing/empty
// data, the unmatched-query fallback, role/data boundaries (answered only
// from local data, no network calls), safe rendering of adversarial input
// (no raw HTML/script injection since React always renders {copilot.answer}
// as text), and one deterministic answer's exact content against a known
// fixture.
//
// Run with: npm run test:copilot-behavior

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4201;
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

async function seedEmptyScenario(page) {
  await page.evaluate(() => {
    const now = new Date().toISOString();
    const cityData = {
      version: 2,
      settings: { cityName: "Copilot Test City", workingHoursStart: "08:00", workingHoursEnd: "19:00", defaultSessionDurationMin: 120, recordingHoursTargetPerDay: 10, theme: "dark", onboarded: true },
      businesses: [], fos: [], collectors: [], rigs: [], assignments: [], sessions: [], evidence: [],
      issues: [], qualityReviews: [], correctiveActions: [], rigIncidents: [], repairRecords: [], activity: [], plans: [], reports: [],
    };
    localStorage.setItem("city-ops-os", JSON.stringify({ state: cityData, version: 2 }));
    localStorage.setItem("city-ops-auth", JSON.stringify({ id: "demo-manager", email: "manager@demo.city-ops", role: "MANAGER", displayName: "Demo Manager", createdAt: now }));
  });
}

async function seedWithCriticalIssue(page) {
  await page.evaluate(() => {
    const now = new Date().toISOString();
    const issue = { id: "issue_copilot", title: "Copilot fixture critical issue", description: "For deterministic Copilot testing.", type: "other", severity: "critical", status: "open", createdAt: now };
    const raw = JSON.parse(localStorage.getItem("city-ops-os") || "{}");
    raw.state.issues = [issue];
    localStorage.setItem("city-ops-os", JSON.stringify(raw));
  });
}

async function askCopilot(page, question) {
  const input = page.locator('input[placeholder*="ask a question"]');
  await input.fill("");
  await input.fill(question);
  await sleep(300);
}

// Exact match: the always-visible "Try asking City Copilot" suggestions
// header (shown whenever the query is empty) contains "City Copilot" as a
// substring, so a non-exact text locator matches both it and the real
// answer card's own "City Copilot" heading span — exact match disambiguates.
async function copilotCardVisible(page) {
  return page.getByText("City Copilot", { exact: true }).isVisible().catch(() => false);
}

async function copilotAnswerText(page) {
  const card = page.getByText("City Copilot", { exact: true }).locator("../..");
  return card.locator("p").first().innerText();
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
    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(e.message));
    const requests = [];
    page.on("request", (req) => { if (!req.url().startsWith(BASE_URL) && req.url().startsWith("http")) requests.push(req.url()); });

    await page.goto(`${BASE_URL}/login`);
    await seedEmptyScenario(page);
    await page.goto(`${BASE_URL}/search`);
    await page.waitForSelector('input[placeholder*="ask a question"]', { timeout: 15000 });

    console.log("\n[1] Input handling — empty and short queries never trigger a Copilot answer:");
    await askCopilot(page, "");
    check(!(await copilotCardVisible(page)), "an empty query shows no Copilot card");
    await askCopilot(page, "abc");
    check(!(await copilotCardVisible(page)), "a query of length <= 4 (SearchPage's own threshold) shows no Copilot card");

    console.log("\n[2] Empty-state data — zero critical issues gets the correct deterministic answer:");
    await askCopilot(page, "Show all open critical issues");
    check(await copilotCardVisible(page), "a recognized query on empty data still produces a Copilot card (not silently nothing)");
    let answer = await copilotAnswerText(page);
    check(answer === "No open critical issues.", `with zero issues, the answer is the exact deterministic string "No open critical issues." — got "${answer}"`);

    console.log("\n[3] Populated data — the same query now reflects the real fixture data exactly:");
    await seedWithCriticalIssue(page);
    // The store's live in-memory state doesn't watch localStorage for
    // out-of-band writes within the same tab — a reload is required for
    // the seeded change to actually reach useCity()'s reactive state.
    await page.reload();
    await page.waitForSelector('input[placeholder*="ask a question"]', { timeout: 15000 });
    await askCopilot(page, "Show all open critical issues");
    answer = await copilotAnswerText(page);
    check(answer.includes("1 open critical issue") && answer.includes("Copilot fixture critical issue"), `with one seeded critical issue, the answer names it exactly — got "${answer}"`);
    check(await page.getByRole("link", { name: "Open Issues" }).isVisible(), "the answer includes a working 'Open Issues' link");

    console.log("\n[4] Unmatched query falls back to the documented generic help text, not an empty or broken answer:");
    await askCopilot(page, "asdkjaslkdjaslkdjalksjd nonsense query");
    answer = await copilotAnswerText(page);
    check(answer.includes("I can only answer from your local data"), `an unmatched query gets the exact documented fallback — got "${answer}"`);

    console.log("\n[5] Malformed/adversarial input renders safely as plain text — no raw HTML/script injection:");
    await askCopilot(page, "<script>window.__copilot_xss__=true</script> critical issue");
    await sleep(200);
    const xssRan = await page.evaluate(() => window.__copilot_xss__ === true);
    check(!xssRan, "an HTML/script-like query string is never executed — React's text rendering escapes it");
    const answerHtml = await page.locator("text=City Copilot").locator("../..").locator("p").first().evaluate((el) => el.innerHTML);
    check(!answerHtml.includes("<script>"), "the raw <script> tag never appears unescaped in the rendered DOM");

    console.log("\n[6] Role boundary — Copilot answers come from local data only, no network calls:");
    check(requests.length === 0, `zero outbound network requests were made while asking Copilot questions (answers come from local data only) — got: ${requests.slice(0, 3).join(", ")}`);

    console.log("\n[7] Console health:");
    const uniqueErrors = [...new Set(consoleErrors)];
    check(uniqueErrors.length === 0, `zero unexpected console errors across all Copilot interactions${uniqueErrors.length ? " — got: " + uniqueErrors.slice(0, 5).join(" | ") : ""}`);

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
