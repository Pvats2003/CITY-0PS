#!/usr/bin/env node
// -----------------------------------------------------------------------
// One-time / per-account ADMINISTRATIVE script — NOT part of the app.
//
// This is an authentication configuration change, not application data
// creation. Supabase's Third-Party Auth integration for Firebase requires
// every Firebase-issued JWT to carry a `role: "authenticated"` custom
// claim, or Supabase treats the request as the `anon` Postgres role and
// every RLS policy denies it (see this round's implementation report).
// Firebase JWTs do not carry this claim by default, and there is no
// automatic way to add it without either a Cloud Function (requires the
// Blaze plan) or this: a local script run by a human, using the Firebase
// Admin SDK, that sets the claim directly on each account.
//
// SECURITY
//   - This file is NEVER imported by any file under src/ and is NEVER
//     bundled by Vite — it is a standalone Node script, run manually from
//     a developer/admin machine, not shipped to the browser or any server.
//   - It NEVER contains a service-account key. The key lives in a JSON
//     file OUTSIDE this repository; its path is passed via the
//     FIREBASE_SERVICE_ACCOUNT_PATH environment variable.
//   - It never prints a token, a credential, or the service-account file's
//     contents — only uids and the resulting (non-secret) claims object.
//   - It ONLY ever sets `role: "authenticated"`. It never adds `foId`,
//     `MANAGER`, or `FIELD_OFFICER` to any custom claim — those stay out
//     of the Firebase JWT entirely (see this round's revised auth design).
//   - It preserves any OTHER existing custom claims on an account — it
//     merges, never overwrites wholesale.
//
// USAGE
//   Bulk backfill (run once, for every existing account):
//     FIREBASE_SERVICE_ACCOUNT_PATH=/path/outside/repo/key.json \
//       node scripts/set-supabase-role-claim.mjs
//
//   Single new account (run every time a new FO/Manager is provisioned —
//   see DEPLOYMENT.md's account-provisioning checklist):
//     FIREBASE_SERVICE_ACCOUNT_PATH=/path/outside/repo/key.json \
//       node scripts/set-supabase-role-claim.mjs --uid <new-user-uid>
//
// AFTER RUNNING
//   The affected user's browser must obtain a fresh ID token before the
//   claim takes effect — either they sign out/in again, or the app's own
//   getCurrentFirebaseIdToken() (src/auth/firebaseAuth.ts) picks it up on
//   its own the next time the SDK's normal token refresh cycle runs. Force
//   a refresh immediately (`getCurrentFirebaseIdToken(true)`, or just sign
//   out/in) if you need to verify the claim took effect right away.
//
// As a hardening step, once you've finished running this script (bulk
// backfill, plus for as long as you're provisioning new accounts), REVOKE
// the service-account key from Firebase Console → Project Settings →
// Service Accounts, so nothing continues to hold Admin SDK credentials
// once this administrative task is done.
// -----------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
if (!keyPath) {
  console.error("FIREBASE_SERVICE_ACCOUNT_PATH is not set. Point it at a service-account JSON key file OUTSIDE this repository.");
  process.exit(1);
}

// Read + parse ourselves (rather than passing the path straight to cert())
// so a malformed/missing file fails with a clear message before any
// network call, and so the key's contents never appear in a stack trace.
let serviceAccount;
try {
  serviceAccount = JSON.parse(readFileSync(keyPath, "utf8"));
} catch (err) {
  console.error(`Could not read/parse the service-account key at ${keyPath}:`, err instanceof Error ? err.message : err);
  process.exit(1);
}

initializeApp({ credential: cert(serviceAccount) });
const auth = getAuth();

const REQUIRED_CLAIM = { role: "authenticated" };

async function setClaimOn(uid) {
  const user = await auth.getUser(uid);
  const existing = user.customClaims ?? {};
  if (existing.role === "authenticated") {
    console.log(`uid=${uid} already has role: "authenticated" — no change.`);
    return;
  }
  // Merge — never overwrite whatever other custom claims (if any) already
  // exist on this account, and never add anything beyond REQUIRED_CLAIM.
  const nextClaims = { ...existing, ...REQUIRED_CLAIM };
  await auth.setCustomUserClaims(uid, nextClaims);
  console.log(`uid=${uid} claims now:`, JSON.stringify(nextClaims));
}

async function bulkBackfill() {
  let pageToken;
  let processed = 0;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of page.users) {
      await setClaimOn(user.uid);
      processed++;
    }
    pageToken = page.pageToken;
  } while (pageToken);
  console.log(`Done. Processed ${processed} account(s).`);
}

async function main() {
  const uidFlagIndex = process.argv.indexOf("--uid");
  const uidArg = uidFlagIndex !== -1 ? process.argv[uidFlagIndex + 1] : null;

  if (uidFlagIndex !== -1 && !uidArg) {
    console.error("--uid was given with no value.");
    process.exit(1);
  }

  if (uidArg) {
    await setClaimOn(uidArg);
  } else {
    console.log("No --uid given — running bulk backfill over every existing Firebase Auth account.");
    await bulkBackfill();
  }
}

main().catch((err) => {
  console.error("Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
