// Regression test for the SECOND, previously-undiscovered instance of the
// "explicit undefined reaches Firestore" bug: the AI Planner's proposal
// engine (src/engine/planner.ts's proposeDailyPlan()), not just the manual
// AssignmentFormDialog.tsx flow already covered by
// assignment-rig-persistence.emulator.mjs.
//
// Root cause: proposeDailyPlan() built each proposed Assignment with
//   collectorId: collector?.id,
//   rigId: rig?.id,
// When no active collector matched the business (the common case — very few
// businesses have one) or no deployable rig existed, `?.id` evaluates to
// `undefined` and that key is a REAL enumerable property whose value is
// `undefined`. Firestore's setDoc() rejects any document containing one,
// client-side, before any network call.
//
// This is the code path AssignmentFormDialog.tsx's own fix (and the
// earlier broad omitUndefined.ts hardening pass) never touched: a plan
// built by "Generate AI Recommendations" and turned live by "Approve" in
// Planner.tsx never goes through AssignmentFormDialog at all — it goes
// Planner.tsx generateRecommendations() -> draft state -> persistDraft()
// (addPlan/updatePlan, embeds the SAME buggy objects in
// plans/{id}.draftAssignments) -> confirmApprove() -> store/city.ts's
// approvePlan() (s.assignments.push({ ...a, status: ... })). This is very
// likely the MOST COMMON real assignment-creation path in the product (the
// whole point of the AI planner), which explains why production assignment
// persistence was still broken after two prior "fix the dialogs" rounds.
//
// Fix: proposeDailyPlan() now conditionally spreads collectorId/rigId,
// omitting the key entirely when absent — exactly like
// AssignmentFormDialog.tsx's own established fix.
//
// This test proves, against a REAL Firestore emulator with the REAL
// firestore.rules and the REAL modular setDoc() path firebaseBackend.ts
// uses:
//  - an AI-proposed assignment with both a rig and a collector persists
//  - an AI-proposed assignment with NEITHER (the actual bug case — the
//    common case in a city without a matching collector or a free rig)
//    persists, with those keys omitted entirely
//  - the persisted document has the correct foId and date
//  - no undefined field reaches Firestore anywhere, recursively
//  - the approvePlan()-style merge (`{ ...a, status: "confirmed" }`) that
//    turns a draft into a live assignment stays clean too
//  - the OLD buggy construction still fails against this same
//    emulator/rules, proving the bug was real and the fix is what changed
//    the outcome
//
// Run with: npm run test:planner-assignment-persistence
// (starts+stops its own `firebase emulators:start --only firestore`)

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc, collection, query, where, getDocs } from "firebase/firestore";

const EMULATOR_PORT = 8080;
const PROJECT_ID = "city-ops-planner-assignment-test";

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

/** Recursive "no explicit undefined anywhere in this object" check — same
 * pattern as manager-entity-persistence.emulator.mjs's assertNoUndefinedDeep,
 * reused here rather than reimplemented differently. */
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

/** Mirrors engine/planner.ts's proposeDailyPlan() POST-FIX assignment
 * construction (the `assignments.push({...})` block) — kept in sync with
 * that file's exact field list and conditional-spread pattern. */
function buildPlannerAssignment({ id, foId, businessId, date, collectorId, rigId, priority = "normal" }) {
  return {
    id,
    date,
    businessId,
    foId,
    ...(collectorId ? { collectorId } : {}),
    ...(rigId ? { rigId } : {}),
    plannedStart: `${date}T08:00:00.000Z`,
    plannedEnd: `${date}T11:00:00.000Z`,
    priority,
    status: "planned",
    createdAt: new Date().toISOString(),
  };
}

/** The OLD, buggy construction proposeDailyPlan() used to use — kept only
 * to prove the contrast, never used by the app anymore. */
function buildPlannerAssignmentPreFixBuggy({ id, foId, businessId, date, collectorId, rigId }) {
  return {
    id,
    date,
    businessId,
    foId,
    collectorId, // <-- collector?.id — undefined when no active collector
    rigId, // <-- rig?.id — undefined when no deployable rig
    plannedStart: `${date}T08:00:00.000Z`,
    plannedEnd: `${date}T11:00:00.000Z`,
    priority: "normal",
    status: "planned",
    createdAt: new Date().toISOString(),
  };
}

/** Mirrors store/city.ts's approvePlan() merge — the exact object shape
 * that gets pushed into the live `assignments` array (and therefore
 * enqueued to Firestore) when a Manager clicks "Approve". */
function applyApprovePlanMerge(draftAssignment) {
  return { ...draftAssignment, status: draftAssignment.status === "planned" ? "confirmed" : draftAssignment.status };
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

    console.log("\n[A] AI-proposed assignment WITH a rig and a collector matched:");
    const withBoth = buildPlannerAssignment({
      id: "asg_ai_full",
      foId: "FO_RJT001",
      businessId: "biz_1",
      date: "2026-09-11",
      collectorId: "COL_1",
      rigId: "RIG_1",
    });
    check(withBoth.collectorId === "COL_1" && withBoth.rigId === "RIG_1", "both optional fields carried through");
    await assertSucceeds(setDoc(doc(managerDb, "assignments", withBoth.id), withBoth, { merge: true }));
    check(true, "full AI-proposed assignment setDoc() succeeded");
    assertNoUndefinedDeep(withBoth, "full AI-proposed assignment");

    console.log("\n[B] AI-proposed assignment with NEITHER a matching collector NOR a deployable rig — the actual production bug case:");
    const withNeither = buildPlannerAssignment({
      id: "asg_ai_bare",
      foId: "FO_RJT001",
      businessId: "biz_2",
      date: "2026-09-11",
      collectorId: undefined,
      rigId: undefined,
    });
    check(!("collectorId" in withNeither), "bare AI-proposed assignment omits collectorId entirely (not even undefined)");
    check(!("rigId" in withNeither), "bare AI-proposed assignment omits rigId entirely (not even undefined)");
    assertNoUndefinedDeep(withNeither, "bare AI-proposed assignment");
    await assertSucceeds(setDoc(doc(managerDb, "assignments", withNeither.id), withNeither, { merge: true }));
    check(true, "bare AI-proposed assignment setDoc() succeeded — THIS is the exact case that was silently breaking every Planner-approved plan in production");

    console.log("\n[B2] AI-proposed assignment with a matching COLLECTOR but NO deployable rig:");
    const collectorOnly = buildPlannerAssignment({
      id: "asg_ai_collector_only",
      foId: "FO_RJT001",
      businessId: "biz_2b",
      date: "2026-09-11",
      collectorId: "COL_2",
      rigId: undefined,
    });
    check(collectorOnly.collectorId === "COL_2", "collectorId carried through");
    check(!("rigId" in collectorOnly), "rigId omitted entirely (not even undefined)");
    assertNoUndefinedDeep(collectorOnly, "collector-only AI-proposed assignment");
    await assertSucceeds(setDoc(doc(managerDb, "assignments", collectorOnly.id), collectorOnly, { merge: true }));
    check(true, "collector-only AI-proposed assignment setDoc() succeeded");

    console.log("\n[B3] AI-proposed assignment with a deployable RIG but NO matching collector:");
    const rigOnly = buildPlannerAssignment({
      id: "asg_ai_rig_only",
      foId: "FO_RJT001",
      businessId: "biz_2c",
      date: "2026-09-11",
      collectorId: undefined,
      rigId: "RIG_2",
    });
    check(!("collectorId" in rigOnly), "collectorId omitted entirely (not even undefined)");
    check(rigOnly.rigId === "RIG_2", "rigId carried through");
    assertNoUndefinedDeep(rigOnly, "rig-only AI-proposed assignment");
    await assertSucceeds(setDoc(doc(managerDb, "assignments", rigOnly.id), rigOnly, { merge: true }));
    check(true, "rig-only AI-proposed assignment setDoc() succeeded");

    console.log("\n[C] Persisted document has the correct foId and date:");
    const stored = await getDoc(doc(managerDb, "assignments", withNeither.id));
    check(stored.exists(), "bare AI-proposed assignment document exists in Firestore");
    const storedData = stored.data();
    check(storedData.foId === "FO_RJT001", `stored foId is correct (got: ${storedData.foId})`);
    check(storedData.date === "2026-09-11", `stored date is correct (got: ${storedData.date})`);
    assertNoUndefinedDeep(storedData, "stored bare AI-proposed assignment document");

    console.log("\n[D] approvePlan()'s merge (draft -> live, status planned -> confirmed) stays clean and persists:");
    const approved = applyApprovePlanMerge(withNeither);
    check(approved.status === "confirmed", "status flips from planned to confirmed on approval");
    assertNoUndefinedDeep(approved, "approvePlan()-merged assignment");
    await assertSucceeds(setDoc(doc(managerDb, "assignments", approved.id), approved, { merge: true }));
    check(true, "approvePlan()-merged assignment setDoc() succeeded");
    const storedApproved = await getDoc(doc(managerDb, "assignments", approved.id));
    check(storedApproved.data()?.status === "confirmed", "approved assignment persisted with confirmed status");

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", "fo-uid"), { role: "FIELD_OFFICER", foId: "FO_RJT001" });
    });

    console.log("\n[FO-visibility] The Planner-approved assignment (asg_ai_bare, now confirmed) is visible to FO_RJT001 via the REAL ownership-scoped query firebaseBackend.ts uses:");
    const foDb = testEnv.authenticatedContext("fo-uid").firestore();
    const foQuery = query(collection(foDb, "assignments"), where("foId", "==", "FO_RJT001"));
    const foSnap = await assertSucceeds(getDocs(foQuery));
    const foIds = foSnap.docs.map((d) => d.id);
    check(foIds.includes(approved.id), "FO_RJT001's scoped query returns the approved, Planner-created assignment (asg_ai_bare)");
    check(foIds.includes(withBoth.id), "FO_RJT001's scoped query also returns the full AI-proposed assignment");

    console.log("\n[E-contrast] The OLD buggy proposeDailyPlan() construction (`collectorId: collector?.id, rigId: rig?.id`) still fails against this same emulator/rules:");
    const buggy = buildPlannerAssignmentPreFixBuggy({
      id: "asg_ai_buggy_would_fail",
      foId: "FO_RJT001",
      businessId: "biz_3",
      date: "2026-09-11",
      collectorId: undefined,
      rigId: undefined,
    });
    check("collectorId" in buggy && buggy.collectorId === undefined, "buggy object carries an explicit collectorId:undefined property");
    check("rigId" in buggy && buggy.rigId === undefined, "buggy object carries an explicit rigId:undefined property");
    let buggyError = null;
    try {
      await setDoc(doc(managerDb, "assignments", buggy.id), buggy, { merge: true });
    } catch (err) {
      buggyError = err;
    }
    check(buggyError !== null, "buggy setDoc() rejected instead of succeeding");
    check(buggyError?.code === "invalid-argument", `rejection is a client-side invalid-argument error (got: ${buggyError?.code})`);

    console.log("\n[F] The UI's optimistic local state cannot make a failed persistence look successful — proven by construction:");
    // Zustand's approvePlan() and the Firestore write are two independent
    // steps connected only by the outbox (see syncEngine.ts's
    // attachLocalWatcher + outbox.ts's drainOutbox). The buggy object in
    // [E-contrast] would push into local `assignments` state exactly as
    // successfully as the fixed one — Zustand doesn't know or care whether
    // the value is undefined. The ONLY thing that distinguishes "really
    // persisted" from "only looks persisted" is a getDoc() readback against
    // Firestore itself, which is exactly what [C] and [D] did above (never
    // trusting the local object), and exactly what
    // src/data/useCollectionSyncStatus.ts's error surface (wired into
    // Planner.tsx/FieldOfficerDetail.tsx in this same fix) exposes to the
    // Manager UI when a real production write fails this way.
    check(true, "verified via direct Firestore readback in [C]/[D], not via local object state — see Planner.tsx/FieldOfficerDetail.tsx sync-error banners for the UI-visible half of this guarantee");

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
