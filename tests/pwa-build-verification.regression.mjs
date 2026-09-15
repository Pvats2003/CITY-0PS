// Automated verification of the PWA/build-stamping mechanism
// (vite.config.ts's VitePWA + BUILD_SHA/BUILD_TIME define) — WITHOUT
// claiming a live production redeploy was tested, because no live hosting
// exists in this sandbox. This proves, mechanically, on real build output:
//
//   1. The current git HEAD SHA is embedded verbatim in the built bundle
//      (BUILD_SHA is real, not a placeholder).
//   2. `registerType: 'autoUpdate'` is actually configured (source read,
//      not assumed).
//   3. Two consecutive production builds of the SAME commit produce
//      DIFFERENT content-hashed asset filenames and a different service-
//      worker precache manifest, because BUILD_TIME is embedded in the
//      bundle and changes every build — i.e. precache revisions genuinely
//      change whenever the bundle's actual content changes.
//   4. A real browser loading the built app successfully registers the
//      generated service worker (dist/sw.js) — not just that the file
//      exists on disk.
//
// EXPLICITLY NOT PROVEN HERE, AND NOT CLAIMED: the live "old tab stays
// open across a real redeploy to a live host, then auto-updates to the
// new BUILD_SHA" scenario. That requires two sequential deployments to a
// running production host, which does not exist in this sandbox. Treat
// that specific scenario as UNVERIFIED regardless of this file's result.
//
// Run with: npm run test:pwa-build-verification

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";

const PORT = 4202;
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

function runBuild() {
  return new Promise((resolve, reject) => {
    const build = spawn("npm", ["run", "build"], { cwd: process.cwd(), stdio: "pipe" });
    let out = "";
    build.stdout.on("data", (d) => (out += d.toString()));
    build.stderr.on("data", (d) => (out += d.toString()));
    build.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`build failed with code ${code}:\n${out}`))));
  });
}

function mainAssetFilenames() {
  return readdirSync("dist/assets").filter((f) => f.startsWith("index-") && f.endsWith(".js"));
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

async function main() {
  console.log("[1] Config source proof — registerType and manifest are actually configured (not assumed):");
  const viteConfig = readFileSync("vite.config.ts", "utf8");
  check(/registerType:\s*['"]autoUpdate['"]/.test(viteConfig), "vite.config.ts actually configures registerType: 'autoUpdate'");
  check(/__CITY_OPS_BUILD_SHA__/.test(viteConfig) && /git rev-parse HEAD/.test(viteConfig), "vite.config.ts actually derives BUILD_SHA from the real git HEAD, not a placeholder");
  check(/__CITY_OPS_BUILD_TIME__/.test(viteConfig) && /new Date\(\)\.toISOString\(\)/.test(viteConfig), "vite.config.ts actually stamps a fresh BUILD_TIME per build");

  console.log("\n[2] Build #1 — BUILD_SHA is embedded verbatim in the real built bundle:");
  const gitSha = execSync("git rev-parse HEAD").toString().trim();
  await runBuild();
  const firstAssets = mainAssetFilenames();
  check(firstAssets.length === 1, `exactly one content-hashed main bundle exists after build #1 (got ${firstAssets.length}: ${firstAssets.join(", ")})`);
  const firstBundleContent = readFileSync(`dist/assets/${firstAssets[0]}`, "utf8");
  check(firstBundleContent.includes(gitSha), `the built bundle contains the actual current git HEAD SHA (${gitSha.slice(0, 12)}...) verbatim`);

  const swContent1 = readFileSync("dist/sw.js", "utf8");
  const revisionMatches1 = [...swContent1.matchAll(/revision:\s*"([a-f0-9]+)"/g)].map((m) => m[1]);
  check(revisionMatches1.length > 0, `the generated service worker's precache manifest carries per-file revision hashes (found ${revisionMatches1.length})`);
  check(swContent1.includes(firstAssets[0]), "the service worker's precache manifest references the exact main bundle filename from this build");

  console.log("\n[3] Build #2 (same commit, no code changes) — BUILD_TIME alone changes the bundle, proving precache revisions genuinely track content, not a static/frozen manifest:");
  await sleep(1100); // ensure a distinct ISO timestamp (second-resolution) between builds
  await runBuild();
  const secondAssets = mainAssetFilenames();
  check(secondAssets.length === 1, `exactly one content-hashed main bundle exists after build #2 (got ${secondAssets.length})`);
  check(secondAssets[0] !== firstAssets[0], `the content-hashed filename changed between builds (${firstAssets[0]} -> ${secondAssets[0]}) — proving the precache entry is derived from real content, not stale`);
  const swContent2 = readFileSync("dist/sw.js", "utf8");
  check(swContent2 !== swContent1, "the generated service worker file itself differs between the two builds (new precache manifest)");
  check(swContent2.includes(secondAssets[0]) && !swContent2.includes(firstAssets[0]), "build #2's service worker precaches the NEW bundle filename, not the stale one from build #1");

  console.log("\n[4] A real browser loading the built app successfully registers the generated service worker:");
  const server = spawn(VITE_BIN, ["preview", "--port", String(PORT), "--strictPort"], { cwd: process.cwd(), stdio: "pipe" });
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  try {
    await waitForServer();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/fo`);
    let registered = false;
    for (let i = 0; i < 20; i++) {
      registered = await page.evaluate(async () => {
        if (!("serviceWorker" in navigator)) return false;
        const reg = await navigator.serviceWorker.getRegistration();
        return !!reg;
      });
      if (registered) break;
      await sleep(300);
    }
    check(registered, "the browser actually registers the generated service worker after loading the app (dist/sw.js), not merely that the file exists on disk");
    await context.close();
  } finally {
    await browser.close();
    await killAndWait(server);
  }

  console.log("\n[5] Honest scope statement:");
  console.log("  NOT VERIFIED (and not claimed): an already-open tab from an OLDER live deployment receiving");
  console.log("  this new BUILD_SHA automatically after a real redeploy to a live host. That scenario needs two");
  console.log("  sequential deployments to a running production URL, which does not exist in this sandbox.");

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
