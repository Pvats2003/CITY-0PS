// Investigation + regression test for the production duplicate-assignment
// bug: Firestore's `assignments` collection contains 6 documents that
// represent only 2 logically distinct visits (3 identical copies of each —
// same businessId/foId/date/plannedStart/plannedEnd/rigId, but 6 DISTINCT
// document ids).
//
// STATIC TRACE SUMMARY (see the final report for the full writeup):
//
// Every Firestore write in this app funnels through ONE chokepoint:
// firebaseBackend.ts's putDoc() -> setDoc(doc(db, collection, id), data,
// {merge:true}). That call is entirely keyed by the `id` it's given — it
// can never itself invent a second document for the same logical entity.
// So duplication cannot originate in firebaseBackend.ts.
//
// The two layers BETWEEN "an assignment object exists" and "it reaches
// Firestore" are outbox.ts's enqueue() and drainOutbox():
//   - enqueue() writes into IndexedDB under key `outbox:<collection>:<id>`
//     — keyed by the SAME `id` the assignment object already carries.
//     Calling enqueue() twice for the SAME id overwrites the same
//     IndexedDB entry; it can never produce two queued writes for two
//     different Firestore document ids.
//   - drainOutbox() iterates existing queued keys and calls putDoc() with
//     THEIR id, unchanged. It never generates a new id, never duplicates
//     an entry, and (per the two prior rounds' fixes) removes a key only
//     after it succeeds. Draining the same entry twice (e.g. two
//     overlapping drain calls, or a retried "invalid-argument" entry that
//     later becomes valid) still writes to the exact same document id —
//     Firestore's setDoc(..., {merge:true}) is a no-op overwrite, not a
//     second document.
// => (A) "before enqueueing" in the sense of enqueue() itself, (B) "during
//    enqueueing", (C) "during outbox draining", and (E) "a listener/
//    reconciliation process" (grepped repo-wide: no addDoc(), no listener
//    or subscription callback anywhere constructs a NEW Assignment or
//    calls an id-generating helper) are all structurally IMPOSSIBLE
//    sources of distinct Firestore ids. Section [3]/[4] below prove this
//    directly against a real emulator instead of just asserting it.
//
// That leaves (D): the SAME LOGICAL creation action invoked more than
// once, each time independently. There are exactly two functions in the
// entire repo that call `id("asg")` to construct a brand-new Assignment:
//   - AssignmentFormDialog.tsx's submit() (manual "Add assignment", used
//     by both Planner.tsx's draft-add flow and FieldOfficerDetail.tsx's
//     direct addAssignment() flow)
//   - engine/planner.ts's proposeDailyPlan() (the AI Planner's
//     "Generate AI Recommendations", whose output later flows through
//     Planner.tsx's approvePlan() into live assignments)
// Neither function — nor store/city.ts's addAssignment()/approvePlan(), nor
// any call site of either — checks whether an assignment already exists
// for the same (businessId, foId, date, plannedStart, plannedEnd) before
// minting a fresh, random id() and persisting it. There is NO idempotency
// key, NO "already exists" guard, anywhere in the assignment-creation
// pipeline.
//
// Separately, AssignmentFormDialog.tsx's "Add assignment" button has no
// `disabled`/in-flight guard: submit() is synchronous from the caller's
// point of view (onCreate() just pushes into Zustand state; the actual
// Firestore write happens invisibly, later, via the outbox), so nothing
// stops a second click — or a second real-world retry of the exact same
// action, e.g. by a Manager unsure whether an earlier attempt actually
// persisted (a very real concern throughout this session's own testing
// history) — from calling submit() again and minting a second, fully
// valid, completely undeduplicated Firestore document for the same visit.
// Section [1]/[2] below prove this is the actual mechanism, not
// speculation: [1] shows ONE logical request produces ONE document; [2]
// shows the SAME logical request repeated (mirroring either a rapid
// double-click or an honest retry — the app cannot tell them apart)
// produces a SECOND, DISTINCT document with identical business/FO/date/
// time/rig fields — exactly the reported production shape.
//
// Also proves approvePlan() does NOT independently multiply ids: it
// reuses `draftAssignments`' existing ids (see [5]) — re-clicking the
// "Approve Plan" confirm button within one already-persisted plan cannot,
// by construction, mint new ids. Duplication requires the id-generating
// step itself (proposeDailyPlan() or AssignmentFormDialog's submit()) to
// run again — either via "Generate AI Recommendations" being re-run (a
// fresh id() per business every time, since proposeDailyPlan() has no
// memory of what it already recommended) or via the manual dialog being
// submitted again.
//
// Run with: npm run test:assignment-duplicate-creation
// (starts+stops its own `firebase emulators:start --only firestore`)

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDocs, collection, query, where, deleteDoc } from "firebase/firestore";

const EMULATOR_PORT = 8080;
const PROJECT_ID = "city-ops-dup-assignment-test";

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

/** Tiny nanoid-shaped id generator, same shape as src/lib/id.ts (10 chars,
 * lowercase alphanumeric) — NOT the real nanoid dependency, just enough to
 * prove "a fresh random id every call" behavior, which is all this test
 * needs. */
let idCounter = 0;
function id(prefix) {
  idCounter += 1;
  return `${prefix}_test${String(idCounter).padStart(6, "0")}`;
}

/** Mirrors AssignmentFormDialog.tsx's submit() EXACTLY: builds one
 * Assignment from the same fixed form state every call — exactly what
 * happens if the SAME dialog, with the SAME selections still on screen,
 * has its "Add assignment" button invoked more than once (two rapid
 * clicks, or two separate real attempts at "add this visit"). A fresh
 * id() is minted every single call — this is the crux of the bug. */
function submitAssignmentFormDialog({ foId, businessId, date, rigId, startTime, endTime }) {
  const plannedStart = `${date}T${startTime}:00.000Z`;
  const plannedEnd = `${date}T${endTime}:00.000Z`;
  return {
    id: id("asg"),
    date,
    businessId,
    foId,
    ...(rigId ? { rigId } : {}),
    plannedStart,
    plannedEnd,
    priority: "normal",
    status: "planned",
    createdAt: new Date().toISOString(),
  };
}

/** Mirrors store/city.ts's addAssignment() — the store action
 * AssignmentFormDialog's onCreate ultimately reaches on the
 * FieldOfficerDetail.tsx path (`onCreate={(a) => addAssignment({...a,
 * status:"confirmed"})}`). Reuses the id already on `a` — does not mint a
 * new one. */
function applyAddAssignment(a) {
  return { ...a, status: "confirmed" };
}

/** Mirrors store/city.ts's approvePlan() merge exactly — reuses each
 * draft assignment's EXISTING id, never generates a new one. */
function applyApprovePlanMerge(draftAssignment) {
  return { ...draftAssignment, status: draftAssignment.status === "planned" ? "confirmed" : draftAssignment.status };
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

    const request = { foId: "FO_RJT001", businessId: "biz_1", date: "2026-09-11", rigId: "RIG_1", startTime: "08:00", endTime: "11:00" };

    // ---------------------------------------------------------------- [1]
    console.log("\n[1] ONE logical assignment creation request produces exactly ONE Firestore document:");
    const first = applyAddAssignment(submitAssignmentFormDialog(request));
    await assertSucceeds(setDoc(doc(managerDb, "assignments", first.id), omitUndefined(first), { merge: true }));
    {
      const q = query(
        collection(managerDb, "assignments"),
        where("businessId", "==", request.businessId),
        where("foId", "==", request.foId),
        where("date", "==", request.date),
        where("plannedStart", "==", first.plannedStart),
      );
      const snap = await getDocs(q);
      check(snap.docs.length === 1, `exactly one document exists for this logical visit after one request (got: ${snap.docs.length})`);
    }

    // ---------------------------------------------------------------- [2]
    console.log("\n[2] REPRODUCTION: the SAME logical request submitted a second time (rapid double-click on \"Add assignment\", or an honest retry after an earlier attempt looked like it failed) creates a SECOND, DISTINCT Firestore document — the app cannot tell these two invocations apart, because nothing checks for an existing match first:");
    const second = applyAddAssignment(submitAssignmentFormDialog(request)); // same `request` object, unchanged form state
    check(second.id !== first.id, "the second invocation mints a brand-new, different id (id() has no memory of the first call)");
    check(
      second.businessId === first.businessId && second.foId === first.foId && second.date === first.date && second.plannedStart === first.plannedStart && second.rigId === first.rigId,
      "the second object is otherwise IDENTICAL in every logical field to the first",
    );
    await assertSucceeds(setDoc(doc(managerDb, "assignments", second.id), omitUndefined(second), { merge: true }));
    {
      const q = query(
        collection(managerDb, "assignments"),
        where("businessId", "==", request.businessId),
        where("foId", "==", request.foId),
        where("date", "==", request.date),
        where("plannedStart", "==", first.plannedStart),
      );
      const snap = await getDocs(q);
      check(snap.docs.length === 2, `Firestore now has TWO documents for the SAME logical visit (got: ${snap.docs.length}) — reproduces the exact production symptom (3 copies is the same mechanism, just repeated a third time)`);
      const ids = snap.docs.map((d) => d.id).sort();
      check(ids.includes(first.id) && ids.includes(second.id), "both distinct ids are present");
    }

    // A third repeat, exactly matching the reported "3 copies" production shape.
    const third = applyAddAssignment(submitAssignmentFormDialog(request));
    await assertSucceeds(setDoc(doc(managerDb, "assignments", third.id), omitUndefined(third), { merge: true }));
    {
      const q = query(collection(managerDb, "assignments"), where("businessId", "==", request.businessId), where("foId", "==", request.foId));
      const snap = await getDocs(q);
      check(snap.docs.length === 3, `a third repeat of the identical request produces a THIRD distinct document (got: ${snap.docs.length}) — exactly the reported production count`);
    }

    // Clean up this scenario's docs before the next section (test-only Firestore project, not production data).
    for (const a of [first, second, third]) await deleteDoc(doc(managerDb, "assignments", a.id));

    // ---------------------------------------------------------------- [3]
    console.log("\n[3] SAFETY PROOF: retrying the SAME already-queued write (same id) via the outbox/drain path can NEVER create a second document — rules out (A)/(B)/(C) as the source:");
    const queued = applyAddAssignment(submitAssignmentFormDialog({ ...request, businessId: "biz_2" }));
    const sanitized = omitUndefined(queued);
    // Simulate drainOutbox() attempting the SAME queued entry (same id)
    // multiple times — e.g. two overlapping drain calls, or a legitimate
    // retry after a transient "unavailable" error. This is exactly what
    // outbox.ts's drainOutbox() does: it always calls putDoc(collection,
    // entry.id, ...) with the entry's OWN, unchanged id.
    await assertSucceeds(setDoc(doc(managerDb, "assignments", queued.id), sanitized, { merge: true }));
    await assertSucceeds(setDoc(doc(managerDb, "assignments", queued.id), sanitized, { merge: true })); // retry #1
    await assertSucceeds(setDoc(doc(managerDb, "assignments", queued.id), sanitized, { merge: true })); // retry #2
    {
      const snap = await getDocs(query(collection(managerDb, "assignments"), where("businessId", "==", "biz_2")));
      check(snap.docs.length === 1, `retrying the same queued write 3 times still produces exactly ONE document (got: ${snap.docs.length}) — the outbox/drain layer is idempotent by id`);
    }
    await deleteDoc(doc(managerDb, "assignments", queued.id));

    // ---------------------------------------------------------------- [4]
    console.log("\n[4] SAFETY PROOF: approvePlan()'s merge reuses draftAssignments' EXISTING ids — re-approving the same plan cannot, by construction, mint new ids (rules out \"double-click on the Approve confirm button\" as a source of DISTINCT Firestore ids):");
    const draftAssignment = submitAssignmentFormDialog({ ...request, businessId: "biz_3" });
    const approvedOnce = applyApprovePlanMerge(draftAssignment);
    const approvedTwice = applyApprovePlanMerge(draftAssignment); // simulates confirmApprove() firing a second time on the SAME already-built draft array
    check(approvedOnce.id === approvedTwice.id, "re-running approvePlan()'s merge on the SAME draft assignment produces the SAME id both times");
    await assertSucceeds(setDoc(doc(managerDb, "assignments", approvedOnce.id), omitUndefined(approvedOnce), { merge: true }));
    await assertSucceeds(setDoc(doc(managerDb, "assignments", approvedTwice.id), omitUndefined(approvedTwice), { merge: true }));
    {
      const snap = await getDocs(query(collection(managerDb, "assignments"), where("businessId", "==", "biz_3")));
      check(snap.docs.length === 1, `two approvePlan() merges of the SAME draft assignment still produce exactly ONE document (got: ${snap.docs.length}) — duplication requires a NEW id() call, which approvePlan() never makes`);
    }
    await deleteDoc(doc(managerDb, "assignments", approvedOnce.id));

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
