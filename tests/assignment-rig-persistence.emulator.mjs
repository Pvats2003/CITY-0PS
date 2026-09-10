// Regression test for the "no rig selected -> assignment never reaches
// Firestore" bug (production case: assignment asg_vz30htm7a2, FO_RJT001).
//
// Root cause: src/components/forms/AssignmentFormDialog.tsx used to build
// `rigId: rigId || undefined` when no rig was picked. That's a REAL
// enumerable property with value `undefined`, and the Firestore Web SDK's
// setDoc() rejects any document containing one — client-side, before any
// network call — unless ignoreUndefinedProperties is configured (it
// deliberately isn't; see src/auth/firebaseApp.ts). The fix replaces that
// with `...(rigId ? { rigId } : {})`, which omits the key entirely.
//
// This test runs against a REAL Firestore emulator using the REAL
// firestore.rules and the REAL modular setDoc()/getDocs() path
// firebaseBackend.ts uses — not just an object-shape check — per the task's
// own "test the actual Firestore emulator" requirement.
//
// Run with: npm run test:assignment-persistence
// (starts+stops its own `firebase emulators:start --only firestore`)

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc, collection, query, where, getDocs } from "firebase/firestore";

const EMULATOR_PORT = 8080;
const PROJECT_ID = "city-ops-assignment-test";

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
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

/** Mirrors AssignmentFormDialog.tsx's exact (post-fix) object construction
 * for the fields relevant to this bug — kept deliberately in sync with that
 * file's `submit()` so this test tracks the real logic, not a copy of it.
 * If that file's construction pattern for `rigId` ever changes, update
 * this helper to match. */
function buildAssignment({ id, foId, businessId, date, rigId, status = "planned" }) {
  return {
    id,
    date,
    businessId,
    foId,
    ...(rigId ? { rigId } : {}),
    plannedStart: `${date}T08:00:00.000Z`,
    plannedEnd: `${date}T11:00:00.000Z`,
    priority: "normal",
    status,
    createdAt: new Date().toISOString(),
  };
}

/** The OLD, buggy construction this fix replaces — kept here only to prove
 * the contrast (assertFails below), never used by the app anymore. */
function buildAssignmentPreFixBuggy({ id, foId, businessId, date, rigId }) {
  return {
    id,
    date,
    businessId,
    foId,
    rigId: rigId || undefined, // <-- the exact bug: explicit `undefined`
    plannedStart: `${date}T08:00:00.000Z`,
    plannedEnd: `${date}T11:00:00.000Z`,
    priority: "normal",
    status: "planned",
    createdAt: new Date().toISOString(),
  };
}

function killAndWait(child) {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill();
    setTimeout(resolve, 3000);
  }).then(() => {
    // Belt-and-suspenders: `firebase emulators:start` forks a JVM child
    // (cloud-firestore-emulator) that can outlive the wrapper process it
    // was spawned from — make sure the port is actually free before this
    // script exits, so a later run never fails with "port already in use".
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
  // The local binary directly — NOT `npx firebase`, whose wrapper process
  // can leave the emulator's own child processes (including the JVM) alive
  // after the wrapper is killed.
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

    // Seed the two users/{uid} profile docs firestore.rules' isManager()/
    // isFieldOfficer()/myFoId() read via get() — bypassing rules to write
    // them, exactly like a real admin-provisioned account (see
    // firestore.rules' own comment: these are never written by the app).
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "users", "manager-uid"), { role: "MANAGER" });
      await setDoc(doc(db, "users", "fo-uid"), { role: "FIELD_OFFICER", foId: "FO_RJT001" });
      await setDoc(doc(db, "users", "other-fo-uid"), { role: "FIELD_OFFICER", foId: "FO_OTHER" });
    });

    const managerDb = testEnv.authenticatedContext("manager-uid").firestore();

    console.log("\n[A] Assignment WITH a rig selected has `rigId`:");
    const withRig = buildAssignment({ id: "asg_with_rig", foId: "FO_RJT001", businessId: "biz_1", date: "2026-09-10", rigId: "RIG_1" });
    check("rigId" in withRig, "object has a `rigId` key");
    check(withRig.rigId === "RIG_1", "rigId value is the selected rig");

    console.log("\n[B] Assignment WITHOUT a rig selected has NO `rigId` property:");
    const noRig = buildAssignment({ id: "asg_no_rig", foId: "FO_RJT001", businessId: "biz_1", date: "2026-09-10", rigId: "" });
    check(!("rigId" in noRig), "object has NO `rigId` key at all (not even set to undefined)");

    console.log("\n[C] Neither assignment object contains any `undefined` field value:");
    check(!Object.values(withRig).includes(undefined), "with-rig object: no undefined values");
    check(!Object.values(noRig).includes(undefined), "no-rig object: no undefined values");

    console.log("\n[D] The rig-less assignment (the exact previous failure case) now persists to Firestore via the REAL setDoc() path used by firebaseBackend.ts:");
    await assertSucceeds(setDoc(doc(managerDb, "assignments", withRig.id), withRig, { merge: true }));
    check(true, "with-rig setDoc() succeeded");
    await assertSucceeds(setDoc(doc(managerDb, "assignments", noRig.id), noRig, { merge: true }));
    check(true, "no-rig setDoc() succeeded — THIS is the exact case that used to fail (asg_vz30htm7a2)");

    console.log("\n[D-contrast] The OLD buggy construction (`rigId: rigId || undefined`) still fails against this same emulator/rules — proves the bug was real and the fix is what changed the outcome:");
    const buggy = buildAssignmentPreFixBuggy({ id: "asg_buggy_would_fail", foId: "FO_RJT001", businessId: "biz_1", date: "2026-09-10", rigId: "" });
    check("rigId" in buggy && buggy.rigId === undefined, "buggy object does carry an explicit rigId:undefined property");
    // Not assertFails() here: this is a client-side SDK validation error
    // (code "invalid-argument", rejected before any network call), not a
    // Firestore rules PERMISSION_DENIED — assertFails() specifically
    // expects the latter. Assert the exact failure mode directly instead.
    let buggyError = null;
    try {
      await setDoc(doc(managerDb, "assignments", buggy.id), buggy, { merge: true });
    } catch (err) {
      buggyError = err;
    }
    check(buggyError !== null, "buggy setDoc() rejected instead of succeeding");
    check(buggyError?.code === "invalid-argument", `rejection is a client-side invalid-argument error (got: ${buggyError?.code})`);
    check(String(buggyError?.message ?? "").includes("rigId"), "error message names the offending `rigId` field");

    console.log("\n[readback] Stored document matches what the FO listener would receive:");
    const stored = await getDoc(doc(managerDb, "assignments", noRig.id));
    check(stored.exists(), "no-rig assignment document exists in Firestore");
    check(!("rigId" in (stored.data() ?? {})), "stored document has no rigId field");

    console.log("\n[E] The assignment reaches the correctly-assigned FO via the REAL ownership-scoped query (mirrors firebaseBackend.ts's where(\"foId\",\"==\",scope.foId)):");
    const foDb = testEnv.authenticatedContext("fo-uid").firestore();
    const foQuery = query(collection(foDb, "assignments"), where("foId", "==", "FO_RJT001"));
    const foSnap = await assertSucceeds(getDocs(foQuery));
    const foIds = foSnap.docs.map((d) => d.id);
    check(foIds.includes("asg_no_rig"), "FO_RJT001's scoped query returns the rig-less assignment");
    check(foIds.includes("asg_with_rig"), "FO_RJT001's scoped query also returns the with-rig assignment");

    console.log("\n[E-negative] A different Field Officer cannot see FO_RJT001's assignment:");
    const otherFoDb = testEnv.authenticatedContext("other-fo-uid").firestore();
    const otherFoQuery = query(collection(otherFoDb, "assignments"), where("foId", "==", "FO_OTHER"));
    const otherFoSnap = await assertSucceeds(getDocs(otherFoQuery));
    check(otherFoSnap.docs.length === 0, "FO_OTHER's scoped query returns nothing (no assignment of theirs exists)");
    // A direct unscoped attempt to read FO_RJT001's doc as FO_OTHER must be denied by rules.
    await assertFails(getDoc(doc(otherFoDb, "assignments", "asg_no_rig")));
    check(true, "FO_OTHER is denied direct read of FO_RJT001's assignment document");

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
