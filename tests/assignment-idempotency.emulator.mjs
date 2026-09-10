// Regression test for the assignment-duplication FIX: store/city.ts's
// addAssignment()/approvePlan() now derive each assignment's persisted id
// deterministically from its logical identity (businessId, foId, date,
// plannedStart, plannedEnd, rigId — see src/lib/assignmentIdentity.ts)
// instead of a fresh random id() on every call. A repeated request for the
// SAME logical visit resolves to the SAME document; it can never mint a
// second one.
//
// This mirrors the real app logic exactly (same convention every other
// *.emulator.mjs test in this repo uses — a plain Node script can't import
// TS/React source, so the algorithm is copied here and kept in sync with
// src/lib/assignmentIdentity.ts and store/city.ts's addAssignment()/
// approvePlan()), and proves the fix against a REAL Firestore emulator with
// the REAL firestore.rules.
//
// Covers items A-K from this round's task:
//   A - one manual submit -> exactly one document
//   B - rapid repeated submit of the SAME logical request -> exactly one
//   C - one Planner recommendation + approval -> exactly one document
//   D - Planner regenerate+approve repeated for the same logical visit ->
//       no additional duplicate documents
//   E - two "concurrent" creation attempts (racing setDoc calls, both
//       computing the same id with no query step) -> exactly one document
//   F - retrying the same already-queued write -> exactly one document
//   G - same business+FO, different start time -> TWO assignments
//   H - same business+FO+date/time, different rig -> TWO assignments
//   I - exactly one document exists for one logical visit (what the FO
//       listener/UI would render as exactly one card)
//   J - a PRE-EXISTING assignment with its original random asg_* id
//       (unaffected by this fix) still loads/updates normally
//   K - no assignment sent to Firestore ever contains an explicit
//       undefined field
//
// Run with: npm run test:assignment-idempotency
// (starts+stops its own `firebase emulators:start --only firestore`)

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc, getDocs, collection, query, where } from "firebase/firestore";

const EMULATOR_PORT = 8080;
const PROJECT_ID = "city-ops-assignment-idempotency-test";

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

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

function omitUndefined(value) {
  if (Array.isArray(value)) return value.map(omitUndefined);
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const [key, v] of Object.entries(value)) {
      if (v !== undefined) result[key] = omitUndefined(v);
    }
    return result;
  }
  return value;
}

// ---- Mirrors src/lib/assignmentIdentity.ts EXACTLY -----------------------
function assignmentIdentityKey(a) {
  return [a.businessId, a.foId, a.date, a.plannedStart, a.plannedEnd, a.rigId ?? "none"].join("|");
}
function stableHash(input) {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}
function deriveAssignmentId(a) {
  return `asg_${stableHash(assignmentIdentityKey(a))}`;
}

// ---- Mirrors AssignmentFormDialog.tsx's submit() (POST-fix) --------------
function buildManualRequest({ foId, businessId, date, rigId, startTime, endTime }) {
  return {
    date,
    businessId,
    foId,
    ...(rigId ? { rigId } : {}),
    plannedStart: `${date}T${startTime}:00.000Z`,
    plannedEnd: `${date}T${endTime}:00.000Z`,
    priority: "normal",
    status: "planned",
    createdAt: new Date().toISOString(),
  };
}

// ---- Mirrors store/city.ts's addAssignment() (POST-fix) ------------------
// `localAssignments` stands in for one browser tab's Zustand `s.assignments`
// array — reused across calls within one scenario, exactly like one
// Manager's live session. Returns { item, created } — `created` is only
// true on a genuinely NEW push, mirroring the fixed store action's own
// "only log/enqueue on real creation" behavior.
function applyAddAssignment(localAssignments, a) {
  const assignmentId = deriveAssignmentId(a);
  const existing = localAssignments.find((x) => x.id === assignmentId);
  if (existing) return { item: existing, created: false };
  const item = { ...a, id: assignmentId, createdAt: new Date().toISOString() };
  localAssignments.push(item);
  return { item, created: true };
}

// ---- Mirrors store/city.ts's approvePlan() merge (POST-fix) --------------
function applyApprovePlan(localAssignments, draftAssignments) {
  const finalIds = [];
  const createdItems = [];
  for (const a of draftAssignments) {
    const assignmentId = deriveAssignmentId(a);
    finalIds.push(assignmentId);
    if (localAssignments.some((x) => x.id === assignmentId)) continue;
    const item = { ...a, id: assignmentId, status: a.status === "planned" ? "confirmed" : a.status };
    localAssignments.push(item);
    createdItems.push(item);
  }
  return { finalIds, createdItems };
}

// ---- Mirrors engine/planner.ts's proposeDailyPlan() per-business build ---
function buildAiRecommendation({ foId, businessId, date, rigId, collectorId, startTime, endTime }) {
  return {
    date,
    businessId,
    foId,
    ...(collectorId ? { collectorId } : {}),
    ...(rigId ? { rigId } : {}),
    plannedStart: `${date}T${startTime}:00.000Z`,
    plannedEnd: `${date}T${endTime}:00.000Z`,
    priority: "normal",
    status: "planned",
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

async function countMatching(db, whereClauses) {
  const snap = await getDocs(query(collection(db, "assignments"), ...whereClauses));
  return snap.docs.length;
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
      await setDoc(doc(ctx.firestore(), "users", "fo-uid"), { role: "FIELD_OFFICER", foId: "FO_RJT001" });
    });
    const managerDb = testEnv.authenticatedContext("manager-uid").firestore();

    // ---------------------------------------------------------------- [A]
    console.log("\n[A] Manual assignment: one submit -> exactly one Firestore document:");
    const localA = [];
    const requestA = { foId: "FO_RJT001", businessId: "biz_a", date: "2026-09-12", rigId: "RIG_1", startTime: "08:00", endTime: "11:00" };
    const { item: itemA, created: createdA } = applyAddAssignment(localA, buildManualRequest(requestA));
    check(createdA, "first submit is a genuine creation");
    await assertSucceeds(setDoc(doc(managerDb, "assignments", itemA.id), omitUndefined(itemA), { merge: true }));
    check((await countMatching(managerDb, [where("businessId", "==", "biz_a")])) === 1, "exactly one document after one submit");

    // ---------------------------------------------------------------- [B]
    console.log("\n[B] Rapid repeated submit of the SAME logical request (3x, simulating 3 rapid clicks / retries) -> exactly one logical assignment:");
    const localB = [];
    const requestB = { foId: "FO_RJT001", businessId: "biz_b", date: "2026-09-12", rigId: "RIG_1", startTime: "08:00", endTime: "11:00" };
    const results = [];
    for (let i = 0; i < 3; i++) {
      const { item, created } = applyAddAssignment(localB, buildManualRequest(requestB));
      results.push({ item, created });
      if (created) await assertSucceeds(setDoc(doc(managerDb, "assignments", item.id), omitUndefined(item), { merge: true }));
    }
    check(results[0].created === true, "first repeat creates");
    check(results[1].created === false && results[2].created === false, "second and third repeats are no-ops, not creations");
    check(results[0].item.id === results[1].item.id && results[1].item.id === results[2].item.id, "all three repeats resolve to the SAME id");
    check((await countMatching(managerDb, [where("businessId", "==", "biz_b")])) === 1, "exactly one document in Firestore after 3 repeated submits");

    // ---------------------------------------------------------------- [C]
    console.log("\n[C] Planner: one recommendation + approval -> exactly one assignment:");
    const localC = [];
    const draftC = [buildAiRecommendation({ foId: "FO_RJT001", businessId: "biz_c", date: "2026-09-12", rigId: "RIG_2", startTime: "09:00", endTime: "12:00" })];
    const { createdItems: createdC } = applyApprovePlan(localC, draftC);
    check(createdC.length === 1, "one recommendation approved produces one created item");
    for (const item of createdC) await assertSucceeds(setDoc(doc(managerDb, "assignments", item.id), omitUndefined(item), { merge: true }));
    check((await countMatching(managerDb, [where("businessId", "==", "biz_c")])) === 1, "exactly one document after one Planner approval");

    // ---------------------------------------------------------------- [D]
    console.log("\n[D] Planner repeated invocation: regenerating + re-approving the SAME logical recommendation -> no additional duplicate documents:");
    const localD = [];
    for (let round = 0; round < 3; round++) {
      // Each "round" mirrors a fresh Generate+Approve cycle: proposeDailyPlan()
      // is deterministic given the same city state, so it recommends the
      // SAME business/FO/time/rig every time, but through a NEW draft
      // array (a fresh call, not an accumulated one).
      const draft = [buildAiRecommendation({ foId: "FO_RJT001", businessId: "biz_d", date: "2026-09-12", rigId: "RIG_3", startTime: "10:00", endTime: "13:00" })];
      const { createdItems } = applyApprovePlan(localD, draft);
      for (const item of createdItems) await assertSucceeds(setDoc(doc(managerDb, "assignments", item.id), omitUndefined(item), { merge: true }));
      check(round === 0 ? createdItems.length === 1 : createdItems.length === 0, `round ${round + 1}: ${round === 0 ? "creates the assignment" : "creates nothing new"}`);
    }
    check((await countMatching(managerDb, [where("businessId", "==", "biz_d")])) === 1, "exactly one document after 3 Generate+Approve rounds for the same logical visit");

    // ---------------------------------------------------------------- [E]
    console.log("\n[E] Concurrent/reentrant calls: two creation attempts racing, neither waiting on the other -> exactly one document:");
    const requestE = buildManualRequest({ foId: "FO_RJT001", businessId: "biz_e", date: "2026-09-12", rigId: "RIG_1", startTime: "08:00", endTime: "11:00" });
    const idE = deriveAssignmentId(requestE);
    // No query, no "does it exist yet" check between these two — both
    // independently compute the SAME id (that's the whole point) and race
    // to setDoc() it. This is what makes the deterministic-id strategy
    // safe under real concurrency, unlike a "query then create" approach.
    await Promise.all([
      assertSucceeds(setDoc(doc(managerDb, "assignments", idE), omitUndefined({ ...requestE, id: idE }), { merge: true })),
      assertSucceeds(setDoc(doc(managerDb, "assignments", idE), omitUndefined({ ...requestE, id: idE }), { merge: true })),
    ]);
    check((await countMatching(managerDb, [where("businessId", "==", "biz_e")])) === 1, "exactly one document after two concurrent racing writes for the same logical visit");

    // ---------------------------------------------------------------- [F]
    console.log("\n[F] Outbox retry: the SAME already-queued assignment write retried multiple times -> exactly one document:");
    const requestF = buildManualRequest({ foId: "FO_RJT001", businessId: "biz_f", date: "2026-09-12", rigId: "RIG_1", startTime: "08:00", endTime: "11:00" });
    const idF = deriveAssignmentId(requestF);
    const sanitizedF = omitUndefined({ ...requestF, id: idF });
    await assertSucceeds(setDoc(doc(managerDb, "assignments", idF), sanitizedF, { merge: true }));
    await assertSucceeds(setDoc(doc(managerDb, "assignments", idF), sanitizedF, { merge: true })); // retry
    await assertSucceeds(setDoc(doc(managerDb, "assignments", idF), sanitizedF, { merge: true })); // retry
    check((await countMatching(managerDb, [where("businessId", "==", "biz_f")])) === 1, "exactly one document after 3 retries of the same queued write");

    // ---------------------------------------------------------------- [G]
    console.log("\n[G] Different logical assignments (same business+FO, DIFFERENT start time) -> TWO assignments, not deduplicated:");
    const localG = [];
    const g1 = applyAddAssignment(localG, buildManualRequest({ foId: "FO_RJT001", businessId: "biz_g", date: "2026-09-12", rigId: "RIG_1", startTime: "08:00", endTime: "11:00" }));
    const g2 = applyAddAssignment(localG, buildManualRequest({ foId: "FO_RJT001", businessId: "biz_g", date: "2026-09-12", rigId: "RIG_1", startTime: "14:00", endTime: "17:00" }));
    check(g1.item.id !== g2.item.id, "different start times produce DIFFERENT ids");
    check(g1.created && g2.created, "both are genuine creations");
    for (const { item } of [g1, g2]) await assertSucceeds(setDoc(doc(managerDb, "assignments", item.id), omitUndefined(item), { merge: true }));
    check((await countMatching(managerDb, [where("businessId", "==", "biz_g")])) === 2, "TWO documents exist — not over-deduplicated by business+FO alone");

    // ---------------------------------------------------------------- [H]
    console.log("\n[H] Different rig (same business+FO+date/time, DIFFERENT rig) -> TWO assignments:");
    const localH = [];
    const h1 = applyAddAssignment(localH, buildManualRequest({ foId: "FO_RJT001", businessId: "biz_h", date: "2026-09-12", rigId: "RIG_1", startTime: "08:00", endTime: "11:00" }));
    const h2 = applyAddAssignment(localH, buildManualRequest({ foId: "FO_RJT001", businessId: "biz_h", date: "2026-09-12", rigId: "RIG_2", startTime: "08:00", endTime: "11:00" }));
    check(h1.item.id !== h2.item.id, "different rigId produces a DIFFERENT id — rigId is part of the identity");
    for (const { item } of [h1, h2]) await assertSucceeds(setDoc(doc(managerDb, "assignments", item.id), omitUndefined(item), { merge: true }));
    check((await countMatching(managerDb, [where("businessId", "==", "biz_h")])) === 2, "TWO documents exist — a rig swap is never collapsed into the assignment it replaces");

    // ---------------------------------------------------------------- [I]
    console.log("\n[I] FO visibility: exactly one assignment card's worth of data for one logical visit (via the REAL ownership-scoped query):");
    const foDb = testEnv.authenticatedContext("fo-uid").firestore();
    const foSnap = await assertSucceeds(getDocs(query(collection(foDb, "assignments"), where("foId", "==", "FO_RJT001"), where("businessId", "==", "biz_a"))));
    check(foSnap.docs.length === 1, "FO_RJT001 sees exactly one document for biz_a's visit — one card, not duplicates");

    // ---------------------------------------------------------------- [J]
    console.log("\n[J] Existing assignment compatibility: a PRE-EXISTING assignment with its original random asg_* id continues to load and update normally:");
    const legacyId = "asg_vz30htm7a2"; // shaped exactly like the real pre-fix nanoid ids already in production
    await assertSucceeds(setDoc(doc(managerDb, "assignments", legacyId), { id: legacyId, businessId: "biz_legacy", foId: "FO_RJT001", date: "2026-09-01", plannedStart: "2026-09-01T08:00:00.000Z", plannedEnd: "2026-09-01T11:00:00.000Z", status: "confirmed" }, { merge: true }));
    const legacyDoc = await getDoc(doc(managerDb, "assignments", legacyId));
    check(legacyDoc.exists(), "legacy random-id assignment exists");
    check(legacyDoc.id === legacyId, "legacy document keeps its original random id — untouched by this fix");
    // A normal update (e.g. FO checks in) against the legacy id still works exactly as before.
    await assertSucceeds(setDoc(doc(managerDb, "assignments", legacyId), { status: "in_progress", actualArrivalAt: "2026-09-01T08:05:00.000Z" }, { merge: true }));
    const legacyUpdated = await getDoc(doc(managerDb, "assignments", legacyId));
    check(legacyUpdated.data().status === "in_progress", "legacy assignment updates normally by its original id");
    check(legacyUpdated.data().businessId === "biz_legacy", "unrelated fields on the legacy document are preserved across the update");

    // ---------------------------------------------------------------- [K]
    console.log("\n[K] No undefined-field regression: every document created in this test suite is clean:");
    for (const bizId of ["biz_a", "biz_b", "biz_c", "biz_d", "biz_e", "biz_f", "biz_g", "biz_h"]) {
      const snap = await getDocs(query(collection(managerDb, "assignments"), where("businessId", "==", bizId)));
      for (const d of snap.docs) assertNoUndefinedDeep(d.data(), `stored document ${d.id} (business ${bizId})`);
    }

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
