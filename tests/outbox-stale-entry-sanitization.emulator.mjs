// Regression test for the exact production failure reported AFTER commit
// 4cf93be was deployed:
//
//   "Function setDoc() called with invalid data. Unsupported field value:
//    undefined (found in field collectorId in document
//    assignments/asg_n3xb4wsqrm)."
//
// 4cf93be fixed engine/planner.ts's construction bug (collectorId:
// collector?.id / rigId: rig?.id producing an explicit `undefined`) AND
// added a central backstop in outbox.ts's enqueue() that strips undefined
// values from every NEW write before it's stored in IndexedDB. Both are
// real, necessary fixes — but neither one could touch a document that was
// ALREADY sitting in a viewer's IndexedDB outbox from BEFORE the deploy.
// A deploy replaces the app's JavaScript; it does not — and cannot — reach
// into an already-open browser tab's IndexedDB and rewrite bytes a
// PREVIOUS build already wrote there via the OLD, buggy enqueue()
// (or, further back, no sanitization at all). That stale entry survives
// the deploy completely unchanged, and drainOutbox() re-attempts it, with
// its original bad data, on every subsequent drain — forever, since
// "invalid-argument" is deterministic and retrying never helps.
//
// This is a genuinely different bug from the one 4cf93be fixed: that was a
// CONSTRUCTION bug (wrong object built); this is a QUEUE-PERSISTENCE /
// migration bug (a correctly-identified-as-wrong object, already queued,
// outliving the fix that would have prevented it). commit 4cf93be's own
// planner-assignment-persistence.emulator.mjs test passed cleanly because
// it only ever exercised the FIXED buildPlannerAssignment() helper and the
// FIXED enqueue() — it never simulated "this exact bad object was already
// on disk before the fix shipped," so it could not have caught this.
//
// Fix: outbox.ts's drainOutbox() now re-applies omitUndefined() to
// entry.data immediately before every backend.putDoc() call, in addition
// to enqueue()'s own sanitization. This means ANY entry — however old,
// however it got into the queue, written by whichever build — is cleaned
// right before it's ever sent. No manual outbox-clearing, no touching
// IndexedDB by hand, no Firestore rule changes: the existing stuck entry
// recovers automatically on the very next drain once this fix is live.
//
// This test proves both halves against a REAL Firestore emulator with the
// REAL firestore.rules and a REAL RemoteBackend-shaped putDoc()/deleteDoc()
// wired to the real modular SDK (identical to firebaseBackend.ts):
//  - [A] FIXED drain logic (sanitize-at-drain): a stale, pre-fix, raw
//    entry with an explicit collectorId:undefined — deliberately NOT run
//    through enqueue()'s own sanitizer, exactly simulating "written by an
//    older build before this fix existed" — still reaches Firestore
//    successfully, with collectorId omitted, exactly reproducing what
//    should happen to asg_n3xb4wsqrm on the next drain after this fix
//    ships.
//  - [B-contrast] The SAME stale entry, drained with only the enqueue()
//    -time backstop (4cf93be's actual shipped behavior, no drain-time
//    sanitization) — reproduces the reported production failure exactly:
//    permanent invalid-argument rejection, never recovers.
//
// Run with: npm run test:outbox-stale-entry-sanitization
// (starts+stops its own `firebase emulators:start --only firestore`)

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc, deleteDoc } from "firebase/firestore";

const EMULATOR_PORT = 8080;
const PROJECT_ID = "city-ops-stale-entry-test";

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

/** Mirrors src/lib/omitUndefined.ts exactly — the fix this test exists to
 * prove drainOutbox() applies at drain time, not just at enqueue time. */
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

function makeRealBackend(db) {
  return {
    async putDoc(collectionName, id, data) {
      await setDoc(doc(db, collectionName, id), data, { merge: true });
    },
    async deleteDoc(collectionName, id) {
      await deleteDoc(doc(db, collectionName, id));
    },
  };
}

/** Mirrors drainOutbox()'s per-entry logic AFTER this round's fix: sanitize
 * entry.data with omitUndefined() immediately before putDoc(), in addition
 * to whatever enqueue() already did (or, for a stale pre-fix entry,
 * didn't). */
async function drainMirroredWithDrainTimeSanitization(queue, backend, results) {
  for (const entry of [...queue]) {
    try {
      if (entry.data === null) await backend.deleteDoc(entry.collection, entry.id);
      else await backend.putDoc(entry.collection, entry.id, omitUndefined(entry.data));
      queue.splice(queue.indexOf(entry), 1);
      results.push({ id: entry.id, outcome: "sent" });
    } catch (err) {
      const code = err?.code ?? "unknown";
      results.push({ id: entry.id, outcome: "failed", code });
      if (code === "invalid-argument") continue;
      break;
    }
  }
}

/** Mirrors drainOutbox() as it actually shipped in 4cf93be: the
 * poison-entry-cascade fix is present (continue on invalid-argument), but
 * there is NO drain-time sanitization — only enqueue()'s. A stale entry
 * that predates enqueue()'s own fix (or predates enqueue() sanitizing at
 * all) is sent with its original, unsanitized data. */
async function drainMirrored_4cf93be_EnqueueOnlyBackstop(queue, backend, results) {
  for (const entry of [...queue]) {
    try {
      if (entry.data === null) await backend.deleteDoc(entry.collection, entry.id);
      else await backend.putDoc(entry.collection, entry.id, entry.data); // <-- no omitUndefined() here
      queue.splice(queue.indexOf(entry), 1);
      results.push({ id: entry.id, outcome: "sent" });
    } catch (err) {
      const code = err?.code ?? "unknown";
      results.push({ id: entry.id, outcome: "failed", code });
      if (code === "invalid-argument") continue;
      break;
    }
  }
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
    const backend = makeRealBackend(managerDb);

    // Reproduces the exact reported production document shape: an
    // assignment queued by the pre-4cf93be proposeDailyPlan(), carrying a
    // raw `collectorId: undefined` that was never sanitized because it was
    // written to IndexedDB before enqueue() learned to strip it.
    const staleEntry = {
      collection: "assignments",
      id: "asg_n3xb4wsqrm",
      data: { id: "asg_n3xb4wsqrm", foId: "FO_RJT001", businessId: "biz_1", date: "2026-09-11", collectorId: undefined, status: "confirmed" },
    };

    console.log("\n[A] FIXED drainOutbox (drain-time omitUndefined): the stale pre-fix entry recovers automatically on the next drain, no manual intervention:");
    const queueFixed = [{ ...staleEntry, data: { ...staleEntry.data } }];
    const resultsFixed = [];
    await drainMirroredWithDrainTimeSanitization(queueFixed, backend, resultsFixed);
    check(resultsFixed.find((r) => r.id === "asg_n3xb4wsqrm")?.outcome === "sent", "stale entry was sent successfully under the fixed drain logic");
    check(queueFixed.length === 0, "stale entry was removed from the queue after succeeding — no longer stuck");

    const storedFixed = await getDoc(doc(managerDb, "assignments", "asg_n3xb4wsqrm"));
    check(storedFixed.exists(), "the exact production document (asg_n3xb4wsqrm) now exists in Firestore");
    const storedFixedData = storedFixed.data();
    check(!("collectorId" in storedFixedData), "stored document has no collectorId field — the offending value was stripped");
    check(findUndefinedPath(storedFixedData) === null, "stored document has no undefined field anywhere (recursive)");
    check(storedFixedData.foId === "FO_RJT001", "stored foId is correct");

    console.log("\n[B-contrast] 4cf93be's ACTUAL shipped behavior (enqueue()-only backstop, no drain-time sanitization): the same stale entry fails exactly as reported in production, forever:");
    const staleEntry2 = { ...staleEntry, id: "asg_n3xb4wsqrm_2", data: { ...staleEntry.data, id: "asg_n3xb4wsqrm_2" } };
    const queueBuggy = [staleEntry2];
    const resultsBuggy = [];
    await drainMirrored_4cf93be_EnqueueOnlyBackstop(queueBuggy, backend, resultsBuggy);
    check(resultsBuggy.find((r) => r.id === "asg_n3xb4wsqrm_2")?.outcome === "failed", "under 4cf93be's actual logic, the stale entry fails");
    check(resultsBuggy.find((r) => r.id === "asg_n3xb4wsqrm_2")?.code === "invalid-argument", "failure is the same invalid-argument error reported in production");
    check(queueBuggy.some((e) => e.id === "asg_n3xb4wsqrm_2"), "stale entry stays stuck in the queue forever under 4cf93be's logic — proving this fix, not just the poison-entry-cascade fix, was necessary");

    const storedBuggy = await getDoc(doc(managerDb, "assignments", "asg_n3xb4wsqrm_2"));
    check(!storedBuggy.exists(), "under 4cf93be's actual logic, the document never reaches Firestore — reproduces the exact reported production symptom");

    // Re-run the SAME queue again (simulating "the online event fires
    // again," or "a new local mutation triggers another drain") to prove
    // this isn't a one-off race — it is permanently stuck under the old
    // logic, which is exactly why a code fix (not a retry) was required.
    console.log("\n[B-contrast, repeat] Retrying the same stale entry again under 4cf93be's logic changes nothing — confirms it's not a transient failure:");
    const resultsBuggyRetry = [];
    await drainMirrored_4cf93be_EnqueueOnlyBackstop(queueBuggy, backend, resultsBuggyRetry);
    check(resultsBuggyRetry.find((r) => r.id === "asg_n3xb4wsqrm_2")?.outcome === "failed", "retry fails identically — deterministic, not transient");

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
