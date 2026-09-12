// Regression test for the production permission-denied incident: a Field
// Officer's own execution flow (src/engine/workflows.ts's markEnRoute(),
// checkInAssignment(), startSessionForAssignment(), startInstallation(),
// completeSession()) calls updateAssignment() on every stage transition —
// FOExecution.tsx (the FO's own cockpit) triggers every one of these
// directly. Before this fix, firestore.rules' assignments/{docId} block
// granted the Field Officer `read` only, with no create/update/write grant
// at all — every one of those updates was denied with permission-denied,
// and because src/data/outbox.ts's drainOutbox() `break`s the whole drain
// loop on any non-"invalid-argument" failure, the stuck assignment entry
// (which sorts alphabetically before "evidence"/"issues"/"rigIncidents"/
// "sessions" among outbox keys) permanently blocked every other FO
// collection's writes behind it too — the exact "Sync error — Permission
// denied... N changes still waiting" production symptom.
//
// The identical gap existed on rigIncidents/{docId}: reportRigIncident()
// immediately follows its own addRigIncident() with an FO-triggered
// updateRigIncident(incident.id, { linkedIssueId }) patch, denied the same
// way (create-only grant, no update).
//
// Fix: two narrowly-scoped `update` grants — assignments/{docId} limited to
// exactly the workflow fields the FO's own actions set (never foId,
// businessId, rigId, plannedStart/plannedEnd, priority, reviewStatus, or
// any other Manager-owned field — ownership can never change hands), and
// rigIncidents/{docId} limited to linkedIssueId only.
//
// This test proves BOTH directions against the REAL firestore.rules via a
// real Firestore emulator: every field the FO's own code legitimately
// writes now succeeds, and every field/scenario it must never be able to
// touch still fails exactly as before.
//
// Run with: npm run test:assignment-fo-update-permission
// (starts+stops its own `firebase emulators:start --only firestore`)

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, updateDoc, getDoc, deleteField } from "firebase/firestore";

const EMULATOR_PORT = 8080;
const PROJECT_ID = "city-ops-fo-update-permission-test";

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

    const FO1_UID = "fo-uid-1";
    const FO1_ID = "fo1";
    const FO2_UID = "fo-uid-2";
    const FO2_ID = "fo2";
    const MANAGER_UID = "manager-uid";

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", FO1_UID), { role: "FIELD_OFFICER", foId: FO1_ID });
      await setDoc(doc(ctx.firestore(), "users", FO2_UID), { role: "FIELD_OFFICER", foId: FO2_ID });
      await setDoc(doc(ctx.firestore(), "users", MANAGER_UID), { role: "MANAGER" });
    });
    const fo1Db = testEnv.authenticatedContext(FO1_UID).firestore();
    const fo2Db = testEnv.authenticatedContext(FO2_UID).firestore();
    const managerDb = testEnv.authenticatedContext(MANAGER_UID).firestore();

    function baseAssignment(id, foId) {
      return {
        id,
        date: "2026-09-11",
        businessId: "biz1",
        foId,
        rigId: "rig1",
        plannedStart: "2026-09-11T08:00:00.000Z",
        plannedEnd: "2026-09-11T11:00:00.000Z",
        priority: "normal",
        status: "confirmed",
      };
    }

    async function seedAssignment(id, foId) {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "assignments", id), baseAssignment(id, foId));
      });
    }

    // ===================================================== ASSIGNMENTS
    console.log("\n=== ASSIGNMENTS ===");

    console.log("\n[allowed fields] own FO can update each individual workflow field:");
    const allowedFieldPatches = [
      { field: "enRouteAt", value: "2026-09-11T08:05:00.000Z" },
      { field: "actualArrivalAt", value: "2026-09-11T08:10:00.000Z" },
      { field: "actualStart", value: "2026-09-11T08:15:00.000Z" },
      { field: "actualEnd", value: "2026-09-11T10:15:00.000Z" },
      { field: "installationStartedAt", value: "2026-09-11T08:20:00.000Z" },
      { field: "sessionId", value: "ses_abc123" },
      { field: "status", value: "in_progress" },
    ];
    for (const { field, value } of allowedFieldPatches) {
      const id = `asg_allowed_${field}`;
      await seedAssignment(id, FO1_ID);
      await assertSucceeds(updateDoc(doc(fo1Db, "assignments", id), { [field]: value }));
      const stored = await getDoc(doc(fo1Db, "assignments", id));
      check(stored.data()?.[field] === value, `own FO can update '${field}' — the exact field workflows.ts writes`);
    }

    console.log("\n[allowed fields] own FO can update multiple allowed fields in one write (matches startSessionForAssignment's real patch shape):");
    const idMulti = "asg_allowed_multi";
    await seedAssignment(idMulti, FO1_ID);
    await assertSucceeds(
      updateDoc(doc(fo1Db, "assignments", idMulti), {
        status: "in_progress",
        actualArrivalAt: "2026-09-11T08:00:00.000Z",
        actualStart: "2026-09-11T08:00:00.000Z",
        sessionId: "ses_xyz",
      }),
    );
    console.log("  PASS: a realistic multi-field workflow patch (status+actualArrivalAt+actualStart+sessionId) succeeds");

    console.log("\n[forbidden fields] own FO cannot modify foId:");
    const idFoId = "asg_forbidden_foid";
    await seedAssignment(idFoId, FO1_ID);
    await assertFails(updateDoc(doc(fo1Db, "assignments", idFoId), { foId: FO2_ID }));
    console.log("  PASS: FO cannot reassign an assignment to a different FO via foId");
    await assertFails(updateDoc(doc(fo1Db, "assignments", idFoId), { status: "in_progress", foId: FO2_ID }));
    console.log("  PASS: FO cannot smuggle a foId change alongside an otherwise-allowed field");

    console.log("\n[forbidden fields] own FO cannot modify businessId:");
    const idBiz = "asg_forbidden_business";
    await seedAssignment(idBiz, FO1_ID);
    await assertFails(updateDoc(doc(fo1Db, "assignments", idBiz), { businessId: "biz_other" }));
    console.log("  PASS: FO cannot reassign an assignment to a different business");

    console.log("\n[forbidden fields] own FO cannot modify rigId:");
    const idRig = "asg_forbidden_rig";
    await seedAssignment(idRig, FO1_ID);
    await assertFails(updateDoc(doc(fo1Db, "assignments", idRig), { rigId: "rig_other" }));
    console.log("  PASS: FO cannot swap the assigned rig");

    console.log("\n[forbidden fields] own FO cannot modify priority:");
    const idPriority = "asg_forbidden_priority";
    await seedAssignment(idPriority, FO1_ID);
    await assertFails(updateDoc(doc(fo1Db, "assignments", idPriority), { priority: "high" }));
    console.log("  PASS: FO cannot change assignment priority");

    console.log("\n[forbidden fields] own FO cannot modify plannedStart/plannedEnd:");
    const idPlanned = "asg_forbidden_planned";
    await seedAssignment(idPlanned, FO1_ID);
    await assertFails(updateDoc(doc(fo1Db, "assignments", idPlanned), { plannedStart: "2026-09-11T09:00:00.000Z" }));
    await assertFails(updateDoc(doc(fo1Db, "assignments", idPlanned), { plannedEnd: "2026-09-11T12:00:00.000Z" }));
    console.log("  PASS: FO cannot change plannedStart or plannedEnd");

    console.log("\n[forbidden fields] own FO cannot modify Manager-only fields such as reviewStatus:");
    const idReview = "asg_forbidden_review";
    await seedAssignment(idReview, FO1_ID);
    await assertFails(updateDoc(doc(fo1Db, "assignments", idReview), { reviewStatus: "approved" }));
    console.log("  PASS: FO cannot set reviewStatus — that stays a Manager-only decision (reviewAssignment())");

    console.log("\n[cross-FO] FO cannot update another FO's assignment, even with only allowed fields:");
    const idOtherFo = "asg_other_fo";
    await seedAssignment(idOtherFo, FO2_ID);
    await assertFails(updateDoc(doc(fo1Db, "assignments", idOtherFo), { status: "in_progress" }));
    console.log("  PASS: FO1 cannot update FO2's assignment, even using an otherwise-allowed field");

    console.log("\n[Manager unaffected] Manager retains full write access to assignments:");
    const idManagerCheck = "asg_manager_check";
    await seedAssignment(idManagerCheck, FO1_ID);
    await assertSucceeds(updateDoc(doc(managerDb, "assignments", idManagerCheck), { priority: "high", reviewStatus: "approved" }));
    console.log("  PASS: Manager can still update any assignment field, unaffected by the FO-scoped grant");

    console.log("\n[create still denied] FO still cannot create a brand-new assignment (create grant was never added — only update):");
    await assertFails(setDoc(doc(fo1Db, "assignments", "asg_fo_created"), baseAssignment("asg_fo_created", FO1_ID)));
    console.log("  PASS: FO cannot create assignments — assignments remain Manager/Planner-authored only");

    console.log("\n[partial patch] a genuine partial patch containing ONLY an allowed field succeeds even when an UNRELATED field on the server differs from whatever the FO's stale local cache would have held — the exact production root cause this round's fix targets:");
    const idDrift = "asg_partial_patch_drift";
    await seedAssignment(idDrift, FO1_ID); // priority: "normal" (see baseAssignment())
    // Simulate a Manager changing an unrelated field server-side AFTER the
    // FO's local snapshot would have been taken — e.g. re-prioritizing the
    // visit while the FO is en route. A stale FULL-SNAPSHOT outbox entry
    // (the old, pre-fix behavior) would still be carrying priority:"normal"
    // and would get its ENTIRE write denied for touching an "affected key"
    // (priority) outside the allowed list. A genuine partial patch never
    // mentions priority at all, so this can't happen.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "assignments", idDrift), { priority: "high" });
    });
    await assertSucceeds(updateDoc(doc(fo1Db, "assignments", idDrift), { status: "in_progress" }));
    const storedDrift = await getDoc(doc(fo1Db, "assignments", idDrift));
    check(storedDrift.data()?.status === "in_progress", "the FO's own status update was applied");
    check(storedDrift.data()?.priority === "high", "the Manager's unrelated priority change (which the FO's payload never mentioned) was left completely untouched");
    console.log("  PASS: a status-only patch succeeds and doesn't clobber or get blocked by a field the FO's payload never referenced");

    console.log("\n[deletion] own FO cannot DELETE an allowed field — affectedKeys().hasOnly([...]) alone does not distinguish set vs delete, since a removed key is still an affected key:");
    for (const field of ["status", "sessionId", "actualArrivalAt", "enRouteAt", "actualStart", "actualEnd", "installationStartedAt"]) {
      const id = `asg_delete_${field}`;
      await seedAssignment(id, FO1_ID);
      // status always exists on a freshly-seeded assignment; the other six
      // don't (they're absent until an FO action first sets them) — set it
      // first via an admin write so there's something real to delete for
      // every field, not just status.
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await updateDoc(doc(ctx.firestore(), "assignments", id), { [field]: "placeholder-value" });
      });
      await assertFails(updateDoc(doc(fo1Db, "assignments", id), { [field]: deleteField() }));
    }
    console.log("  PASS: deleteField() on every one of the 7 allowed fields is denied");

    console.log("\n[deletion] deleting an allowed field cannot be smuggled alongside a legitimate update to a DIFFERENT allowed field:");
    const idSmuggleDelete = "asg_smuggle_delete";
    await seedAssignment(idSmuggleDelete, FO1_ID);
    await assertFails(updateDoc(doc(fo1Db, "assignments", idSmuggleDelete), { enRouteAt: "2026-09-11T08:05:00.000Z", status: deleteField() }));
    console.log("  PASS: a legitimate field update combined with a deletion of another allowed field is still denied as a whole");

    console.log("\n[regression] adding a brand-new allowed field (the real, common case — most of these fields don't exist until the FO's first action sets them) still succeeds after the deletion guard:");
    const idFirstSet = "asg_first_set_sessionid";
    await seedAssignment(idFirstSet, FO1_ID); // baseAssignment() never includes sessionId — this is a genuinely ADDED key, not a changed one
    await assertSucceeds(updateDoc(doc(fo1Db, "assignments", idFirstSet), { sessionId: "ses_first_time" }));
    const storedFirstSet = await getDoc(doc(fo1Db, "assignments", idFirstSet));
    check(storedFirstSet.data()?.sessionId === "ses_first_time", "setting a field for the first time (an added key, not a changed one) still works — the removedKeys() guard only blocks removal, never addition");

    // ===================================================== RIG INCIDENTS
    console.log("\n=== RIG INCIDENTS ===");

    function baseIncident(id, foId) {
      return {
        id,
        rigId: "rig1",
        foId,
        category: "unknown_technical",
        group: "technical",
        severity: "critical",
        discoveredAt: "2026-09-11T08:00:00.000Z",
        discoveryStage: "preflight",
        description: "Precheck failed",
        evidence: [],
        status: "open",
        lostHours: 2,
      };
    }
    async function seedIncident(id, foId) {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "rigIncidents", id), baseIncident(id, foId));
      });
    }

    console.log("\n[allowed field] own FO can update linkedIssueId:");
    const incLinked = "rin_allowed_linked";
    await seedIncident(incLinked, FO1_ID);
    await assertSucceeds(updateDoc(doc(fo1Db, "rigIncidents", incLinked), { linkedIssueId: "iss_abc123" }));
    const storedInc = await getDoc(doc(fo1Db, "rigIncidents", incLinked));
    check(storedInc.data()?.linkedIssueId === "iss_abc123", "linkedIssueId was actually persisted — exactly what reportRigIncident() writes");

    console.log("\n[forbidden fields] own FO cannot modify foId or other incident fields:");
    const incForbidden = "rin_forbidden_fields";
    await seedIncident(incForbidden, FO1_ID);
    await assertFails(updateDoc(doc(fo1Db, "rigIncidents", incForbidden), { foId: FO2_ID }));
    console.log("  PASS: FO cannot reassign an incident to a different FO");
    await assertFails(updateDoc(doc(fo1Db, "rigIncidents", incForbidden), { status: "resolved" }));
    console.log("  PASS: FO cannot advance the repair lifecycle status — Manager-owned (advanceRigIncidentStatus())");
    await assertFails(updateDoc(doc(fo1Db, "rigIncidents", incForbidden), { severity: "info" }));
    console.log("  PASS: FO cannot downgrade/change severity");
    await assertFails(updateDoc(doc(fo1Db, "rigIncidents", incForbidden), { linkedIssueId: "iss_x", status: "resolved" }));
    console.log("  PASS: FO cannot smuggle a forbidden field alongside the one allowed field");

    console.log("\n[cross-FO] FO cannot update another FO's incident:");
    const incOtherFo = "rin_other_fo";
    await seedIncident(incOtherFo, FO2_ID);
    await assertFails(updateDoc(doc(fo1Db, "rigIncidents", incOtherFo), { linkedIssueId: "iss_y" }));
    console.log("  PASS: FO1 cannot update FO2's rigIncident, even using the one allowed field");

    console.log("\n[Manager unaffected] Manager retains full write access to rigIncidents:");
    const incManagerCheck = "rin_manager_check";
    await seedIncident(incManagerCheck, FO1_ID);
    await assertSucceeds(updateDoc(doc(managerDb, "rigIncidents", incManagerCheck), { status: "resolved", severity: "info" }));
    console.log("  PASS: Manager can still update any rigIncident field, unaffected by the FO-scoped grant");

    console.log("\n[deletion] own FO cannot DELETE linkedIssueId:");
    const incDelete = "rin_delete_linked";
    await seedIncident(incDelete, FO1_ID);
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "rigIncidents", incDelete), { linkedIssueId: "iss_placeholder" });
    });
    await assertFails(updateDoc(doc(fo1Db, "rigIncidents", incDelete), { linkedIssueId: deleteField() }));
    console.log("  PASS: deleteField() on linkedIssueId is denied");

    console.log("\n[regression] setting linkedIssueId for the first time (the real case — reportRigIncident() sets it on a freshly-created incident that never had it) still succeeds:");
    const incFirstSet = "rin_first_set_linked";
    await seedIncident(incFirstSet, FO1_ID); // baseIncident() never includes linkedIssueId — a genuinely ADDED key
    await assertSucceeds(updateDoc(doc(fo1Db, "rigIncidents", incFirstSet), { linkedIssueId: "iss_first_time" }));
    console.log("  PASS: setting linkedIssueId for the first time still works after the deletion guard");

    console.log(
      "\n[create-time regression] reportRigIncident()'s fixed shape — the incident CREATED ONCE with linkedIssueId already embedded, never a separate update — is accepted by the create rule:",
    );
    // Mirrors the exact fix in src/engine/workflows.ts: the outbox key for
    // assignments/rigIncidents is deterministic (outbox:rigIncidents:<id>),
    // so a create immediately followed by a separate updateRigIncident()
    // call on that SAME id used to collapse onto one outbox entry — the
    // update's enqueue() (last write wins) silently clobbered the create's
    // full payload before it was ever drained, leaving only
    // {linkedIssueId} to reach Firestore: no foId, so even the CREATE rule
    // (not just update) denied it, since the target document never
    // existed. reportRigIncident() no longer does this — it creates the
    // incident exactly once, complete, with linkedIssueId already set. This
    // asserts the rules actually accept that combined shape as a CREATE
    // (setDoc against a brand-new id, security rules NOT disabled).
    const incCreateWithLink = "rin_create_with_linked_issue";
    await assertSucceeds(
      setDoc(doc(fo1Db, "rigIncidents", incCreateWithLink), {
        ...baseIncident(incCreateWithLink, FO1_ID),
        linkedIssueId: "iss_created_together",
      }),
    );
    const storedCreateWithLink = await getDoc(doc(fo1Db, "rigIncidents", incCreateWithLink));
    check(storedCreateWithLink.exists(), "the combined create+linkedIssueId document was actually created");
    check(storedCreateWithLink.data()?.linkedIssueId === "iss_created_together", "linkedIssueId survived the create, exactly as reportRigIncident() now sends it");
    check(storedCreateWithLink.data()?.foId === FO1_ID, "foId is present on the created document — what the create rule actually checks");
    check(storedCreateWithLink.data()?.category === "unknown_technical" && storedCreateWithLink.data()?.severity === "critical", "every other incident field from the create payload also persisted, not just linkedIssueId");

    // ============================================ Other collections unaffected
    console.log("\n=== Sanity: unrelated collections' rules unchanged ===");
    const evOther = "ev_sanity_check";
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "evidence", evOther), { id: evOther, foId: FO1_ID, files: [] });
    });
    await assertFails(updateDoc(doc(fo1Db, "evidence", evOther), { status: "approved" }));
    console.log("  PASS: evidence stays create-only for the FO — unaffected by this change (also exercised in tests/evidence-sync-reconciliation.emulator.mjs)");

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
