// Regression test for a confirmed P2 security-rules gap found during the
// full production-readiness audit: firestore.rules' issues/{docId} update
// grant allowed a Field Officer to modify ANY field on an issue they own
// (as long as it had no rigId) — the only guard was resource.data.foId ==
// myFoId() && !("rigId" in resource.data), with no field allow-list and no
// foId-immutability check on the incoming write. The app's only actual
// write path (resolveIssue() in src/store/city.ts, called from
// FOExecution.tsx and ResolveIssueDialog.tsx) only ever sets status,
// resolution, and resolvedAt — a client talking to Firestore directly
// (bypassing the app UI) could otherwise reassign foId, forge severity,
// rootCause, action, lostHours, or any other field on a record that's
// supposed to be an audit trail.
//
// Fix mirrors the existing assignments/rigIncidents pattern exactly (see
// tests/assignment-fo-update-permission.emulator.mjs): pin
// request.resource.data.foId == myFoId(), require
// diff(resource.data).removedKeys().size() == 0, and restrict
// diff(resource.data).affectedKeys() to hasOnly(["status", "resolution",
// "resolvedAt"]) — while preserving the pre-existing non-rig-issue
// restriction (!("rigId" in resource.data)).
//
// This test proves both directions against the REAL firestore.rules via a
// real Firestore emulator: every field resolveIssue() legitimately writes
// still succeeds, and every field/scenario it must never be able to touch
// is denied.
//
// Run with: npm run test:issue-fo-update-permission
// (starts+stops its own `firebase emulators:start --only firestore`)

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, updateDoc, getDoc, deleteField } from "firebase/firestore";

const EMULATOR_PORT = 8080;
const PROJECT_ID = "city-ops-issue-fo-update-permission-test";

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
    const unauthDb = testEnv.unauthenticatedContext().firestore();

    // A non-rig issue — the only kind an FO is ever granted update access
    // to at all (see the pre-existing !("rigId" in resource.data) guard).
    function baseIssue(id, foId) {
      return {
        id,
        type: "operational",
        severity: "warning",
        title: "Something went wrong",
        description: "Reported from the field.",
        businessId: "biz1",
        foId,
        sessionId: "ses1",
        assignmentId: "asg1",
        owner: "You",
        status: "open",
        lostHours: 1,
        createdAt: "2026-09-11T08:00:00.000Z",
      };
    }
    async function seedIssue(id, foId, extra = {}) {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "issues", id), { ...baseIssue(id, foId), ...extra });
      });
    }

    console.log("\n=== ISSUES — narrow FO update grant (status/resolution/resolvedAt only) ===");

    // [A] [B] [C] — allowed fields
    console.log("\n[A/B/C — allowed] own FO can update status, resolution, resolvedAt individually:");
    const allowedFieldPatches = [
      { label: "A", field: "status", value: "resolved" },
      { label: "B", field: "resolution", value: "Resolved by field officer." },
      { label: "C", field: "resolvedAt", value: "2026-09-11T09:00:00.000Z" },
    ];
    for (const { label, field, value } of allowedFieldPatches) {
      const id = `iss_allowed_${field}`;
      await seedIssue(id, FO1_ID);
      await assertSucceeds(updateDoc(doc(fo1Db, "issues", id), { [field]: value }));
      const stored = await getDoc(doc(fo1Db, "issues", id));
      check(stored.data()?.[field] === value, `[${label}] own FO can update '${field}' — exactly what resolveIssue() writes`);
    }

    console.log("\n[allowed] own FO can update all three allowed fields together in one write (matches resolveIssue()'s real patch shape):");
    const idMulti = "iss_allowed_multi";
    await seedIssue(idMulti, FO1_ID);
    await assertSucceeds(
      updateDoc(doc(fo1Db, "issues", idMulti), {
        status: "resolved",
        resolution: "Fixed on site.",
        resolvedAt: "2026-09-11T09:30:00.000Z",
      }),
    );
    console.log("  PASS: the real resolveIssue() patch shape (status+resolution+resolvedAt together) succeeds");

    // [D] foId immutability
    console.log("\n[D — forbidden] own FO cannot change foId:");
    const idFoId = "iss_forbidden_foid";
    await seedIssue(idFoId, FO1_ID);
    await assertFails(updateDoc(doc(fo1Db, "issues", idFoId), { foId: FO2_ID }));
    console.log("  PASS: [D] FO cannot reassign an issue to a different FO via foId");
    await assertFails(updateDoc(doc(fo1Db, "issues", idFoId), { status: "resolved", foId: FO2_ID }));
    console.log("  PASS: [D] FO cannot smuggle a foId change alongside an otherwise-allowed field");

    // [E] severity
    console.log("\n[E — forbidden] own FO cannot change severity:");
    const idSeverity = "iss_forbidden_severity";
    await seedIssue(idSeverity, FO1_ID);
    await assertFails(updateDoc(doc(fo1Db, "issues", idSeverity), { severity: "critical" }));
    console.log("  PASS: [E] FO cannot change severity");

    // [F] rootCause
    console.log("\n[F — forbidden] own FO cannot change rootCause:");
    const idRootCause = "iss_forbidden_rootcause";
    await seedIssue(idRootCause, FO1_ID);
    await assertFails(updateDoc(doc(fo1Db, "issues", idRootCause), { rootCause: "Forged root cause" }));
    console.log("  PASS: [F] FO cannot set/change rootCause");

    // [G] action
    console.log("\n[G — forbidden] own FO cannot change action:");
    const idAction = "iss_forbidden_action";
    await seedIssue(idAction, FO1_ID);
    await assertFails(updateDoc(doc(fo1Db, "issues", idAction), { action: "Forged action" }));
    console.log("  PASS: [G] FO cannot set/change action");

    // [H] lostHours
    console.log("\n[H — forbidden] own FO cannot change lostHours:");
    const idLostHours = "iss_forbidden_losthours";
    await seedIssue(idLostHours, FO1_ID);
    await assertFails(updateDoc(doc(fo1Db, "issues", idLostHours), { lostHours: 99 }));
    console.log("  PASS: [H] FO cannot change lostHours");

    // [I] arbitrary new field
    console.log("\n[I — forbidden] own FO cannot add an arbitrary new field:");
    const idArbitrary = "iss_forbidden_arbitrary";
    await seedIssue(idArbitrary, FO1_ID);
    await assertFails(updateDoc(doc(fo1Db, "issues", idArbitrary), { notes: "an arbitrary field the schema never defines" }));
    console.log("  PASS: [I] FO cannot add an arbitrary field not in the allow-list");
    await assertFails(updateDoc(doc(fo1Db, "issues", idArbitrary), { status: "resolved", notes: "smuggled alongside an allowed field" }));
    console.log("  PASS: [I] FO cannot smuggle an arbitrary field alongside an otherwise-allowed field");

    // [J] deletion of existing allowed fields
    console.log("\n[J — forbidden] own FO cannot DELETE an existing allowed field (removedKeys().size() == 0 guard):");
    for (const field of ["status", "resolution", "resolvedAt"]) {
      const id = `iss_delete_${field}`;
      await seedIssue(id, FO1_ID);
      // status always exists on a freshly-seeded issue; resolution/resolvedAt
      // don't (they're absent until resolveIssue() first sets them) — set a
      // placeholder via an admin write first so there's something real to
      // delete for every field, not just status.
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await updateDoc(doc(ctx.firestore(), "issues", id), { [field]: "placeholder-value" });
      });
      await assertFails(updateDoc(doc(fo1Db, "issues", id), { [field]: deleteField() }));
    }
    console.log("  PASS: [J] deleteField() on every one of the 3 allowed fields is denied");
    const idSmuggleDelete = "iss_smuggle_delete";
    await seedIssue(idSmuggleDelete, FO1_ID);
    await assertFails(updateDoc(doc(fo1Db, "issues", idSmuggleDelete), { resolution: "Fixed.", status: deleteField() }));
    console.log("  PASS: [J] a legitimate field update combined with a deletion of another allowed field is still denied as a whole");

    // [K] adding rigId
    console.log("\n[K — forbidden] own FO cannot add rigId to a non-rig issue:");
    const idAddRig = "iss_forbidden_add_rigid";
    await seedIssue(idAddRig, FO1_ID);
    await assertFails(updateDoc(doc(fo1Db, "issues", idAddRig), { rigId: "rig1" }));
    console.log("  PASS: [K] FO cannot add rigId (not in the allow-list — same denial whether or not the rig-issue guard would also apply)");

    console.log("\n[K — preserved] an issue that ALREADY has a rigId stays fully un-updatable by the FO, even for allowed fields (pre-existing rig-issue restriction unchanged):");
    const idRigIssue = "iss_rig_issue";
    await seedIssue(idRigIssue, FO1_ID, { rigId: "rig1" });
    await assertFails(updateDoc(doc(fo1Db, "issues", idRigIssue), { status: "resolved" }));
    console.log("  PASS: [K] FO cannot update status on a rig-linked issue — repair lifecycle stays Manager-owned, unaffected by this fix");

    // [L] cross-FO
    console.log("\n[L — forbidden] own FO cannot modify another FO's issue:");
    const idOtherFo = "iss_other_fo";
    await seedIssue(idOtherFo, FO2_ID);
    await assertFails(updateDoc(doc(fo1Db, "issues", idOtherFo), { status: "resolved" }));
    console.log("  PASS: [L] FO1 cannot update FO2's issue, even using an otherwise-allowed field");

    // [M] unauthenticated
    console.log("\n[M — forbidden] unauthenticated caller cannot update an issue at all:");
    const idUnauth = "iss_unauth";
    await seedIssue(idUnauth, FO1_ID);
    await assertFails(updateDoc(doc(unauthDb, "issues", idUnauth), { status: "resolved" }));
    console.log("  PASS: [M] an unauthenticated caller cannot update any issue field");

    // [N] Manager unaffected
    console.log("\n[N — unchanged] Manager retains full write access to issues:");
    const idManagerCheck = "iss_manager_check";
    await seedIssue(idManagerCheck, FO1_ID);
    await assertSucceeds(
      updateDoc(doc(managerDb, "issues", idManagerCheck), {
        severity: "critical",
        rootCause: "Manager-diagnosed root cause",
        action: "Manager-assigned action",
        lostHours: 5,
        foId: FO2_ID,
        rigId: "rig1",
      }),
    );
    console.log("  PASS: [N] Manager can still update ANY issue field (including foId/rigId/severity/rootCause/action/lostHours), unaffected by the FO-scoped grant");

    console.log("\n[regression] setting resolution/resolvedAt for the first time (the real case — resolveIssue() sets them on an issue that never had them) still succeeds:");
    const idFirstSet = "iss_first_set";
    await seedIssue(idFirstSet, FO1_ID); // baseIssue() never includes resolution/resolvedAt — genuinely ADDED keys
    await assertSucceeds(updateDoc(doc(fo1Db, "issues", idFirstSet), { status: "resolved", resolution: "Fixed.", resolvedAt: "2026-09-11T10:00:00.000Z" }));
    const storedFirstSet = await getDoc(doc(fo1Db, "issues", idFirstSet));
    check(
      storedFirstSet.data()?.resolution === "Fixed." && storedFirstSet.data()?.resolvedAt === "2026-09-11T10:00:00.000Z",
      "setting resolution/resolvedAt for the first time (added keys, not changed ones) still works — the removedKeys() guard only blocks removal, never addition",
    );

    // ============================================ Other collections unaffected
    console.log("\n=== Sanity: unrelated collections' rules unchanged ===");
    const asgOther = "asg_sanity_check";
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "assignments", asgOther), {
        id: asgOther,
        date: "2026-09-11",
        businessId: "biz1",
        foId: FO1_ID,
        rigId: "rig1",
        plannedStart: "2026-09-11T08:00:00.000Z",
        plannedEnd: "2026-09-11T11:00:00.000Z",
        priority: "normal",
        status: "confirmed",
      });
    });
    await assertSucceeds(updateDoc(doc(fo1Db, "assignments", asgOther), { status: "in_progress" }));
    console.log("  PASS: assignments' own narrow update grant is untouched by this change (also exercised in tests/assignment-fo-update-permission.emulator.mjs)");

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
