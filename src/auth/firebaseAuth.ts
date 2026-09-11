import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from "firebase/auth";
import { getFirestore, doc, getDoc } from "firebase/firestore";
import { getFirebaseApp } from "./firebaseApp";
import { setProfileDiagSnapshot } from "./profileDiag";
import type { AppUser, AuthEvent, AuthProvider, UserRole } from "./types";

interface UserDoc {
  role: UserRole;
  foId?: string;
  displayName?: string;
  createdAt?: string;
}

/** Diagnostics only — never logs email, password, or tokens. Gated on DEV so
 * production consoles stay quiet; safe to leave in since it never touches
 * credentials. */
function authLog(...args: unknown[]) {
  if (import.meta.env.DEV) console.debug("[auth]", ...args);
}


/** Common Firebase Auth error codes mapped to messages a field worker or
 * manager can actually act on, instead of the raw "Firebase: Error
 * (auth/wrong-password)." string. Falls back to the SDK's own message for
 * anything not covered here — never fabricates a reason. */
function describeAuthError(err: unknown): string {
  const code = (err as { code?: string } | undefined)?.code;
  switch (code) {
    case "auth/invalid-email":
      return "That doesn't look like a valid email address.";
    case "auth/user-disabled":
      return "This account has been disabled. Contact your administrator.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
    case "auth/invalid-login-credentials":
      return "Incorrect email or password.";
    case "auth/too-many-requests":
      return "Too many failed attempts. Wait a few minutes and try again.";
    case "auth/network-request-failed":
      return "Network error — check your connection and try again.";
    default:
      return err instanceof Error ? err.message : "Sign in failed.";
  }
}

/** Role/foId live in a `users/{uid}` Firestore doc, not in Firebase Auth
 * itself (custom claims need a privileged admin SDK we don't run here).
 * Provision that doc when you create the account — see DEPLOYMENT.md.
 *
 * Returns `null` only when the doc genuinely doesn't exist (the normal,
 * expected "not provisioned yet" case) — a real read failure (permission
 * denied, offline, rules not deployed) is left to throw so the caller can
 * tell the two apart instead of collapsing both into "signed out". The
 * `role`/`foId` fields are returned exactly as stored (not validated here)
 * — Console-provisioned data can be typo'd or wrong-cased, so the pages
 * that route on role (Login.tsx, FOLogin.tsx) are the ones that check it
 * against the known values and explain a mismatch, rather than this
 * function silently coercing or rejecting it. */
async function loadAppUser(fbUser: User): Promise<AppUser | null> {
  const db = getFirestore(getFirebaseApp());
  const docPath = `users/${fbUser.uid}`;
  const snap = await getDoc(doc(db, "users", fbUser.uid));
  authLog("users/", fbUser.uid, "exists =", snap.exists());
  // TEMPORARY production diagnostics — PRIMITIVE values only (never a
  // collapsed object a screenshot can't show the contents of). Not
  // DEV-gated, unlike authLog above: this is here to get real signal from
  // the live production site, where DEV-only logs never fire (Vite bakes
  // import.meta.env.DEV to false in a production build). Never logs email,
  // password, or tokens. Safe to delete once resolved.
  //
  // Explicit path/existence trace first — the doc path is BUILT from
  // fbUser.uid directly (doc(db, "users", fbUser.uid)), so there is no
  // code path here that could read a different uid's document; this
  // confirms that at the source rather than by inference.
  console.log("[CITY-OPS-DIAG] profile primitive values", "uid=", fbUser.uid, "path=", docPath, "exists=", snap.exists());
  if (!snap.exists()) {
    // Captured even on "doesn't exist" — an on-page diagnostic panel
    // needs to show this state too, not just the success case.
    setProfileDiagSnapshot({
      authUid: fbUser.uid,
      path: docPath,
      exists: false,
      docId: null,
      keys: [],
      rawRole: undefined,
      rawFoId: undefined,
      capturedAt: Date.now(),
    });
    return null;
  }
  const data = snap.data() as UserDoc;
  // Object.keys(data) is the actual, literal set of field names the SDK
  // read back — the one thing that definitively rules a field-name
  // mismatch (wrong case, stray whitespace, a homoglyph typed into the
  // Firebase console) in or out, which no amount of staring at the
  // console's rendered UI can.
  console.log(
    "[CITY-OPS-DIAG] profile primitive values",
    "uid=", fbUser.uid,
    "role=", JSON.stringify(data.role),
    "roleType=", typeof data.role,
    "foId=", JSON.stringify(data.foId),
    "foIdType=", typeof data.foId,
    "foIdLength=", typeof data.foId === "string" ? data.foId.length : -1,
    "keys=", JSON.stringify(Object.keys(data)),
  );
  // snap.id is the Firestore document's own id — doc(db, "users",
  // fbUser.uid) forces this to equal fbUser.uid by construction (there is
  // no code path that could substitute a different document), but it's
  // captured and compared explicitly by the diagnostic panel rather than
  // assumed, per the requirement to prove this rather than infer it.
  setProfileDiagSnapshot({
    authUid: fbUser.uid,
    path: docPath,
    exists: true,
    docId: snap.id,
    keys: Object.keys(data),
    rawRole: data.role,
    rawFoId: data.foId,
    capturedAt: Date.now(),
  });
  // Trim, don't guess: a Console-entered value can pick up incidental
  // leading/trailing whitespace (easy to introduce, invisible in the
  // Console UI, and would otherwise make an exact-match lookup fail). This
  // only normalizes whitespace on the field this app already treats as
  // authoritative — it never substitutes a different field or value.
  const role = typeof data.role === "string" ? (data.role.trim() as UserRole) : data.role;
  const foId = typeof data.foId === "string" ? data.foId.trim() || undefined : data.foId;
  const appUser: AppUser = {
    id: fbUser.uid,
    email: fbUser.email ?? "",
    role,
    foId,
    displayName: data.displayName ?? fbUser.displayName ?? undefined,
    createdAt: data.createdAt ?? new Date().toISOString(),
  };
  // Logged separately from "profile primitive values" above (which shows
  // the raw Firestore data) so a construction-stage bug — foId present in
  // data but lost while building AppUser — would show up as a mismatch
  // between these two adjacent log lines instead of being invisible.
  console.log(
    "[CITY-OPS-DIAG] AppUser constructed",
    "uid=", appUser.id,
    "role=", JSON.stringify(appUser.role),
    "foId=", JSON.stringify(appUser.foId),
    "foIdType=", typeof appUser.foId,
    "foIdLength=", typeof appUser.foId === "string" ? appUser.foId.length : -1,
    "hasFoId=", Boolean(appUser.foId),
  );
  return appUser;
}

/** The current Firebase user's ID token, for use as Supabase's Third-Party
 * Auth `accessToken` (see data/supabaseClient.ts). Uses the SDK's normal,
 * non-forced getIdToken() — Firebase's client SDK auto-refreshes the cached
 * token as it nears expiry, so this does not force a network round-trip on
 * every call. Pass `forceRefresh: true` only for the explicit, one-off case
 * of picking up a custom claim that just changed (account provisioning/
 * testing — see scripts/set-supabase-role-claim.mjs) — never as the default
 * for ordinary requests. Returns null when signed out. */
export async function getCurrentFirebaseIdToken(forceRefresh = false): Promise<string | null> {
  const auth = getAuth(getFirebaseApp());
  const user = auth.currentUser;
  if (!user) return null;
  return user.getIdToken(forceRefresh);
}

export const firebaseAuthProvider: AuthProvider = {
  onChange(cb) {
    const auth = getAuth(getFirebaseApp());
    return onAuthStateChanged(auth, (fbUser) => {
      if (!fbUser) {
        cb({ kind: "signed_out" });
        return;
      }
      loadAppUser(fbUser)
        .then((user) => {
          const event: AuthEvent = user
            ? { kind: "signed_in", user }
            : { kind: "needs_setup", email: fbUser.email ?? "", uid: fbUser.uid };
          authLog("onAuthStateChanged ->", event.kind);
          cb(event);
        })
        .catch((err) => {
          authLog("profile load failed:", (err as { code?: string } | undefined)?.code ?? err);
          cb({ kind: "error", message: err instanceof Error ? err.message : "Could not load your City Ops profile." });
        });
    });
  },
  async loginWithEmail(email, password) {
    try {
      const auth = getAuth(getFirebaseApp());
      await signInWithEmailAndPassword(auth, email, password);
      authLog("signInWithEmailAndPassword ok");
      return { ok: true };
    } catch (err) {
      authLog("signInWithEmailAndPassword failed:", (err as { code?: string } | undefined)?.code ?? err);
      return { ok: false, error: describeAuthError(err) };
    }
  },
  async logout() {
    const auth = getAuth(getFirebaseApp());
    await signOut(auth);
  },
};
