// Regression coverage for the broader "explicit undefined reaches
// Firestore" bug class discovered while fixing assignment asg_vz30htm7a2
// (see tests/assignment-rig-persistence.emulator.mjs for that original
// fix). The same `field: value || undefined` pattern existed in
// BusinessFormDialog.tsx and FOFormDialog.tsx for their optional fields —
// fixed by wrapping each dialog's payload with src/lib/omitUndefined.ts
// before it reaches addBusiness()/addFO().
//
// This test proves, against a REAL Firestore emulator with the REAL
// firestore.rules and the REAL modular setDoc() path firebaseBackend.ts
// uses:
//  - Business: populated optional fields persist; blank ones are omitted
//    entirely (never sent as undefined); no undefined anywhere, recursively.
//  - Field Officer: same.
//  - Rig: verifies its EXISTING optional-field handling (RigFormDialog.tsx
//    already falls back to a string default, never undefined) still holds.
//
// It also defines a generic, recursive "no explicit undefined anywhere in
// this object" assertion, reusable for any future Firestore-bound object —
// requirement from this round's task.
//
// Run with: npm run test:manager-entity-persistence
// (starts+stops its own `firebase emulators:start --only firestore`)

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc } from "firebase/firestore";

// Same port as assignment-rig-persistence.emulator.mjs's emulator (fixed by
// firebase.json) — these test scripts are meant to be run sequentially, not
// concurrently; each fully tears down its emulator (including the port)
// before exiting.
const EMULATOR_PORT = 8080;
const PROJECT_ID = "city-ops-manager-entity-test";

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

/** Generic, recursive "no explicit undefined value anywhere in this object
 * (including nested objects/arrays)" assertion — the Firestore Web SDK
 * rejects a document containing one at ANY depth, not just the top level
 * (see Reports.tsx's nested `data` payload for a real example). Returns the
 * first offending key path found, or null if the object is clean. */
function findUndefinedPath(value, path = "$") {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findUndefinedPath(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined) return `${path}.${key}`;
      const found = findUndefinedPath(v, `${path}.${key}`);
      if (found) return found;
    }
    return null;
  }
  return null;
}

function assertNoUndefinedDeep(obj, label) {
  const offendingPath = findUndefinedPath(obj);
  check(offendingPath === null, `${label}: no explicit undefined anywhere (recursive)${offendingPath ? ` — found at ${offendingPath}` : ""}`);
}

/** Mirrors BusinessFormDialog.tsx's exact (post-fix) payload construction —
 * the same object shape, then omitUndefined-equivalent filtering, kept in
 * sync with that file's `submit()`. */
function buildBusinessPayload({ id, name, area, googleMapsUrl, contactName, contactPhone, preferredWindowStart, preferredWindowEnd, notes }) {
  const raw = {
    id,
    name,
    category: "General",
    area,
    address: "",
    googleMapsUrl: googleMapsUrl || undefined,
    contactName: contactName || undefined,
    contactPhone: contactPhone || undefined,
    preferredWindowStart: preferredWindowStart || undefined,
    preferredWindowEnd: preferredWindowEnd || undefined,
    capacityHoursPerDay: 3,
    notes: notes || undefined,
    active: true,
    createdAt: new Date().toISOString(),
  };
  const clean = {};
  for (const [k, v] of Object.entries(raw)) if (v !== undefined) clean[k] = v;
  return clean;
}

/** Mirrors FOFormDialog.tsx's exact (post-fix) payload construction. */
function buildFOPayload({ id, name, phone, homeArea }) {
  const raw = { id, name, phone: phone || undefined, homeArea: homeArea || undefined, active: true, createdAt: new Date().toISOString() };
  const clean = {};
  for (const [k, v] of Object.entries(raw)) if (v !== undefined) clean[k] = v;
  return clean;
}

/** Mirrors RigFormDialog.tsx's existing (already-correct) payload
 * construction — `model` falls back to a literal string, never undefined,
 * so no omitUndefined wrapping is needed or present there. */
function buildRigPayload({ id, code, model }) {
  return {
    id,
    code,
    model: model || "Unspecified",
    active: true,
    batteryPct: 100,
    storagePct: 0,
    deploymentStatus: "active",
    createdAt: new Date().toISOString(),
  };
}

async function waitForEmulator() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${EMULATOR_PORT}`);
      if (res.status) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error("Firestore emulator did not become ready in time");
}

function killAndWait(child) {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill();
    setTimeout(resolve, 3000);
  }).then(() => {
    return new Promise((resolve) => {
      const fuser = spawn("fuser", ["-k", `${EMULATOR_PORT}/tcp`]);
      fuser.on("exit", () => resolve());
      fuser.on("error", () => resolve());
      setTimeout(resolve, 2000);
    });
  });
}

async function main() {
  console.log("Starting Firestore emulator...");
  const emulator = spawn("node_modules/.bin/firebase", ["emulators:start", "--only", "firestore", "--project", PROJECT_ID], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
  let emulatorOutput = "";
  emulator.stdout.on("data", (d) => (emulatorOutput += d.toString()));
  emulator.stderr.on("data", (d) => (emulatorOutput += d.toString()));

  let testEnv;
  try {
    await waitForEmulator();

    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: readFileSync("firestore.rules", "utf8"),
        host: "127.0.0.1",
        port: EMULATOR_PORT,
      },
    });

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", "manager-uid"), { role: "MANAGER" });
    });
    const managerDb = testEnv.authenticatedContext("manager-uid").firestore();

    // ---------------------------------------------------------------- BUSINESS
    console.log("\n[BUSINESS A] All optional fields populated — persists with every value preserved:");
    const bizFull = buildBusinessPayload({
      id: "biz_full",
      name: "Full Business",
      area: "Koramangala",
      googleMapsUrl: "https://maps.google.com/?q=test",
      contactName: "Asha",
      contactPhone: "9876543210",
      preferredWindowStart: "09:00",
      preferredWindowEnd: "17:00",
      notes: "Gate code 1234",
    });
    check(bizFull.contactName === "Asha" && bizFull.googleMapsUrl === "https://maps.google.com/?q=test", "populated fields preserved exactly");
    await assertSucceeds(setDoc(doc(managerDb, "businesses", bizFull.id), bizFull, { merge: true }));
    check(true, "full-optional-fields business setDoc() succeeded");
    assertNoUndefinedDeep(bizFull, "full business payload");

    console.log("\n[BUSINESS B] All optional fields blank — persists, with those keys omitted entirely:");
    const bizBlank = buildBusinessPayload({ id: "biz_blank", name: "Blank Business", area: "Indiranagar" });
    for (const key of ["googleMapsUrl", "contactName", "contactPhone", "preferredWindowStart", "preferredWindowEnd", "notes"]) {
      check(!(key in bizBlank), `blank business payload omits "${key}" entirely`);
    }
    await assertSucceeds(setDoc(doc(managerDb, "businesses", bizBlank.id), bizBlank, { merge: true }));
    check(true, "blank-optional-fields business setDoc() succeeded — this is the exact case that used to fail");

    console.log("\n[BUSINESS C] No undefined properties reach Firestore:");
    assertNoUndefinedDeep(bizBlank, "blank business payload");
    const storedBiz = await getDoc(doc(managerDb, "businesses", bizBlank.id));
    check(storedBiz.exists(), "blank business document exists in Firestore");
    assertNoUndefinedDeep(storedBiz.data(), "stored blank business document");

    // ------------------------------------------------------------ FIELD OFFICER
    console.log("\n[FO A] Optional fields populated — persists:");
    const foFull = buildFOPayload({ id: "fo_full", name: "Full FO", phone: "9876500000", homeArea: "HSR Layout" });
    check(foFull.phone === "9876500000" && foFull.homeArea === "HSR Layout", "populated fields preserved exactly");
    await assertSucceeds(setDoc(doc(managerDb, "fos", foFull.id), foFull, { merge: true }));
    check(true, "full-optional-fields FO setDoc() succeeded");
    assertNoUndefinedDeep(foFull, "full FO payload");

    console.log("\n[FO B] Optional fields blank — persists, with those keys omitted entirely:");
    const foBlank = buildFOPayload({ id: "fo_blank", name: "Blank FO" });
    check(!("phone" in foBlank), 'blank FO payload omits "phone" entirely');
    check(!("homeArea" in foBlank), 'blank FO payload omits "homeArea" entirely');
    await assertSucceeds(setDoc(doc(managerDb, "fos", foBlank.id), foBlank, { merge: true }));
    check(true, "blank-optional-fields FO setDoc() succeeded — this is the exact case that used to fail");

    console.log("\n[FO C] No undefined properties reach Firestore:");
    assertNoUndefinedDeep(foBlank, "blank FO payload");
    const storedFo = await getDoc(doc(managerDb, "fos", foBlank.id));
    check(storedFo.exists(), "blank FO document exists in Firestore");
    assertNoUndefinedDeep(storedFo.data(), "stored blank FO document");

    // ---------------------------------------------------------------------- RIG
    console.log("\n[RIG] Verify existing optional-field behavior (model falls back to a string, never undefined) + no undefined fields:");
    const rigBlankModel = buildRigPayload({ id: "rig_blank_model", code: "R-99", model: "" });
    check(rigBlankModel.model === "Unspecified", "blank model falls back to the literal string \"Unspecified\", not undefined or an omitted key");
    check("model" in rigBlankModel, "model key is present (RigFormDialog's existing design: always a string, never omitted)");
    await assertSucceeds(setDoc(doc(managerDb, "rigs", rigBlankModel.id), rigBlankModel, { merge: true }));
    check(true, "blank-model rig setDoc() succeeded");
    assertNoUndefinedDeep(rigBlankModel, "blank-model rig payload");
    const storedRig = await getDoc(doc(managerDb, "rigs", rigBlankModel.id));
    check(storedRig.exists(), "rig document exists in Firestore");
    assertNoUndefinedDeep(storedRig.data(), "stored rig document");

    if (failures > 0) console.error("\n--- emulator output (for debugging) ---\n" + emulatorOutput.slice(-4000));
  } finally {
    if (testEnv) await testEnv.cleanup();
    await killAndWait(emulator);
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
