// Regression test for the outbox "poison entry" cascade-failure bug found
// while investigating production assignment persistence.
//
// src/data/outbox.ts's drainOutbox() iterates queued writes in a FIXED
// lexicographic key order (`outbox:<collection>:<id>`, exactly what
// idb-keyval's keys() returns for IndexedDB) and, before this fix, stopped
// at the FIRST failure of any kind. Because a client-side Firestore SDK
// validation rejection (code "invalid-argument" — e.g. a document with an
// explicit `undefined` field, thrown before any network call) is
// deterministic, it can NEVER succeed on retry. Since the loop always
// restarts from the same first still-queued key on every subsequent drain
// attempt, a single permanently-invalid entry (e.g. one bad "assignments"
// document — 'a' sorts near the very front of the alphabet) PERMANENTLY
// blocked every other collection's valid writes queued behind it —
// "businesses", "plans", etc. — forever, with no way to recover short of
// fixing the bad entry's data.
//
// This is the confirmed mechanism behind the production symptom "Firestore
// has businesses/fos/rigs/users/activity but zero assignments" (the first
// bad assignment entry got permanently stuck) and the earlier "a second
// Business created in Manager appeared then vanished on refresh" symptom
// (the new Business's write was queued alphabetically behind the already-
// stuck assignment entry and never actually reached Firestore, even though
// it displayed fine from local/optimistic Zustand state until the next
// hard reload replaced local state with Firestore's real, business-less
// snapshot).
//
// Fix (src/data/outbox.ts's drainOutbox): on code === "invalid-argument",
// `continue` past the entry instead of `break`ing the whole loop. The
// broken entry is still never deleted (it keeps reporting a real SYNC
// ERROR for its own collection), but it no longer holds hostage every
// other collection's valid, already-correct writes.
//
// This test mirrors drainOutbox's exact catch-block decision logic (the
// same "mirror the app logic in a plain Node script, keep in sync"
// convention every other *.emulator.mjs test in this repo already uses,
// since idb-keyval requires a real browser IndexedDB this Node script
// doesn't have) against a REAL Firestore emulator with the REAL
// firestore.rules and the REAL modular setDoc() path firebaseBackend.ts's
// putDoc() uses — so the "invalid-argument" error itself is the genuine
// error the Firestore SDK throws, not a simulated one.
//
// Run with: npm run test:outbox-resilience
// (starts+stops its own `firebase emulators:start --only firestore`)

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc, deleteDoc } from "firebase/firestore";

const EMULATOR_PORT = 8080;
const PROJECT_ID = "city-ops-outbox-resilience-test";

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

/** A real RemoteBackend-shaped object wired to the actual Firestore
 * emulator via the real SDK — identical to firebaseBackend.ts's own
 * putDoc()/deleteDoc(), so failures surface exactly as they do in
 * production (a real FirebaseError with a real `.code`). */
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

/** Mirrors drainOutbox()'s per-entry try/catch decision exactly (POST-FIX):
 * on a real, online failure, "invalid-argument" continues past the entry
 * (leaving it in the queue, never deleted) while anything else still
 * breaks the whole loop, preserving ordering for genuine
 * connectivity/permission problems. `queue` is mutated in place — a
 * successfully-sent entry is removed, a failed one stays — exactly
 * mirroring idb-keyval's set()/del() semantics against the real outbox
 * store. */
async function drainMirrored(queue, backend, results) {
  // idb-keyval's keys() returns IndexedDB's own key order, which for
  // string keys is lexicographic — the queue here is pre-sorted the same
  // way the real `outbox:<collection>:<id>` keys would be.
  for (const entry of [...queue]) {
    try {
      if (entry.data === null) await backend.deleteDoc(entry.collection, entry.id);
      else await backend.putDoc(entry.collection, entry.id, entry.data);
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

/** The OLD (pre-fix) behavior — breaks on ANY failure, no exception for
 * invalid-argument — kept only to prove the contrast. */
async function drainMirroredPreFixBuggy(queue, backend, results) {
  for (const entry of [...queue]) {
    try {
      if (entry.data === null) await backend.deleteDoc(entry.collection, entry.id);
      else await backend.putDoc(entry.collection, entry.id, entry.data);
      queue.splice(queue.indexOf(entry), 1);
      results.push({ id: entry.id, outcome: "sent" });
    } catch (err) {
      const code = err?.code ?? "unknown";
      results.push({ id: entry.id, outcome: "failed", code });
      break; // <-- the bug: always stops, regardless of error type
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

    // Deliberately seeded with a raw `undefined` field, bypassing
    // outbox.ts's own enqueue()-level omitUndefined() backstop on purpose
    // — this test proves drainOutbox's resilience holds independently,
    // as defense-in-depth against ANY future invalid-argument-class
    // failure, not only this specific undefined-value bug.
    const poisonedAssignment = { collection: "assignments", id: "asg_poisoned", data: { id: "asg_poisoned", foId: "FO_1", rigId: undefined } };
    const goodBusiness = { collection: "businesses", id: "biz_good", data: { id: "biz_good", name: "Good Business", area: "Koramangala" } };
    const goodPlan = { collection: "plans", id: "plan_good", data: { id: "plan_good", date: "2026-09-11", status: "draft" } };

    console.log("\n[A] FIXED drainOutbox logic: a poisoned assignment entry does not block businesses/plans queued behind it:");
    const queueFixed = [poisonedAssignment, goodBusiness, goodPlan]; // pre-sorted: "assignments" < "businesses" < "plans"
    const resultsFixed = [];
    await drainMirrored(queueFixed, backend, resultsFixed);

    check(resultsFixed.find((r) => r.id === "asg_poisoned")?.outcome === "failed", "poisoned assignment entry failed as expected");
    check(resultsFixed.find((r) => r.id === "asg_poisoned")?.code === "invalid-argument", "poisoned entry failed with invalid-argument");
    check(resultsFixed.find((r) => r.id === "biz_good")?.outcome === "sent", "business entry queued BEHIND the poisoned one still got sent");
    check(resultsFixed.find((r) => r.id === "plan_good")?.outcome === "sent", "plan entry queued behind the poisoned one still got sent");
    check(queueFixed.some((e) => e.id === "asg_poisoned"), "poisoned entry stays in the queue (never silently dropped) so it keeps reporting a real SYNC ERROR");
    check(!queueFixed.some((e) => e.id === "biz_good"), "sent business entry was removed from the queue");
    check(!queueFixed.some((e) => e.id === "plan_good"), "sent plan entry was removed from the queue");

    const storedBiz = await getDoc(doc(managerDb, "businesses", "biz_good"));
    check(storedBiz.exists(), "business actually reached Firestore despite the poisoned entry ahead of it in the queue");
    const storedPlan = await getDoc(doc(managerDb, "plans", "plan_good"));
    check(storedPlan.exists(), "plan actually reached Firestore despite the poisoned entry ahead of it in the queue");

    console.log("\n[B-contrast] OLD (pre-fix) drainOutbox logic: the same poisoned entry permanently blocks businesses/plans behind it:");
    // Fresh Firestore docs so this contrast run doesn't reuse [A]'s results.
    const goodBusiness2 = { collection: "businesses", id: "biz_good_2", data: { id: "biz_good_2", name: "Good Business 2", area: "Indiranagar" } };
    const goodPlan2 = { collection: "plans", id: "plan_good_2", data: { id: "plan_good_2", date: "2026-09-12", status: "draft" } };
    const poisonedAssignment2 = { collection: "assignments", id: "asg_poisoned_2", data: { id: "asg_poisoned_2", foId: "FO_1", rigId: undefined } };
    const queueBuggy = [poisonedAssignment2, goodBusiness2, goodPlan2];
    const resultsBuggy = [];
    await drainMirroredPreFixBuggy(queueBuggy, backend, resultsBuggy);

    check(resultsBuggy.length === 1, "OLD logic stops after the very first failure — never even attempts business/plan");
    check(!resultsBuggy.some((r) => r.id === "biz_good_2"), "OLD logic never attempted the business entry");
    check(!resultsBuggy.some((r) => r.id === "plan_good_2"), "OLD logic never attempted the plan entry");
    check(queueBuggy.length === 3, "OLD logic leaves the ENTIRE queue stuck, not just the poisoned entry");

    const storedBiz2 = await getDoc(doc(managerDb, "businesses", "biz_good_2"));
    check(!storedBiz2.exists(), "under the OLD logic, the business never actually reached Firestore — proves this was a real data-loss bug, not just a cosmetic one");

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
