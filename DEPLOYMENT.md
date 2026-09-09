# City Ops OS — Deployment Guide

City Ops OS runs in one of two modes, decided entirely by whether the six
`VITE_FIREBASE_*` environment variables are set at build time:

- **Demo mode** (default, no env vars set): everything lives in this
  browser's `localStorage`. Zero external network requests. Login offers
  two no-password demo identities (Manager / Field Officer). Demo-data
  actions (Onboarding's "Load Demo City", Settings' "Reset Demo Data") are
  the only way data gets in.
- **Production mode** (all six vars set): a shared Firebase project backs
  authentication and data, with an offline queue so Field Officers keep
  working without a connection. **Demo-data actions are hidden entirely in
  this mode** — production starts clean and only gets data a manager adds.

Nothing has been deployed as part of this work — this environment has no
Firebase account, no Firebase CLI authentication, and no hosting account.
Firebase CLI tooling (`firebase-tools`) is installed in the repo so you can
run every command below yourself; running `firebase projects:list` here
returns `Failed to authenticate, have you run firebase login?` — that's the
exact point where a human with a real Google account has to take over.

---

## 1. Firebase project setup

1. Go to the [Firebase console](https://console.firebase.google.com) and
   create a new project. The free **Spark** plan's quotas are generous for
   a single city's operation.
2. In **Project settings → General → Your apps**, add a **Web app** and
   copy the six config values it gives you.

## 2. Auth setup

In **Build → Authentication → Sign-in method**, enable **Email/Password**.
That's the only provider this app uses — no OAuth, no phone auth, nothing
else needed.

## 3. Firestore setup

In **Build → Firestore Database**, create a database (production mode,
pick a region close to your users). One collection is created per existing
data type (`businesses`, `fos`, `rigs`, `assignments`, `sessions`, `issues`,
`rigIncidents`, `repairRecords`, `activity`, etc.) — documents keyed by the
app's own generated ids, so nothing needs to be pre-created; the app
creates documents as data is added.

## 4. Rules deployment

`firestore.rules` (repo root) enforces the Manager/Field-Officer split:
Managers get broad read/write; Field Officers can read what they need for
their own assigned work and write only their own sessions/issues/rig
incidents — never city administration data. **Its syntax has been verified
locally** (this session ran `firebase emulators:start --only firestore
--project=demo-cityops-local`, which loads and compiles the rules file
with no live project or login required — it started cleanly). It has
**not** been deployed to a real project; nobody here has credentials to do
that. Once you're authenticated:

```
npm install -g firebase-tools   # or use the one already in this repo's devDependencies
firebase login
firebase use --add              # pick the project you created in step 1
firebase deploy --only firestore:rules
```

A `firebase.json` is already in the repo pointing at `firestore.rules` and
declaring the hosting config for step 10.

## 5. Environment variables

Copy `.env.example` to `.env` and fill in the six values from step 1.2:

```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
```

All six must be present (checked in `src/auth/config.ts`) or the app stays
in demo mode. `.env` is gitignored — never commit real values. When
deploying, set these as build-time environment variables in your hosting
provider's dashboard, not in the repository.

## 6. User provisioning

Firebase Auth only proves *who* someone is. Their *role* (`MANAGER` or
`FIELD_OFFICER`) and, for Field Officers, which `FieldOfficer` record they
are, live in a `users/{uid}` Firestore document (`src/auth/firebaseAuth.ts`).
For each person:

1. **Authentication → Users → Add user** — create their email/password.
2. Copy their generated **User UID**.
3. **Firestore Database → Start collection `users`** → document ID = that
   UID → fields:
   - `role`: `"MANAGER"` or `"FIELD_OFFICER"` (string)
   - `foId`: (Field Officers only) the `id` of their `FieldOfficer` record,
     visible in the Manager app's Field Officers page
   - `displayName`: optional string

No admin UI for this exists in the app — deliberately, for a handful of
accounts a one-time manual step per person is simpler than building and
maintaining an admin screen.

## 7. Demo vs. production

Covered above — the short version: unset env vars → demo, all six set →
production, and production mode actively hides every demo-data action so
a live city database can never accidentally receive seeded/fake data.
Reset demo data anytime by clearing this browser's localStorage, or (in
demo mode only) Settings → Data → Reset Demo Data.

## 8. Local development

```
npm install
npm run dev
```

Runs demo mode unless a `.env` with real Firebase config exists locally.

## 9. Production build

```
npm run build
```

Outputs a static site to `dist/`, plus a generated service worker
(`dist/sw.js`) and manifest (`dist/manifest.webmanifest`) for the FO PWA.
Verified clean in this session: no TypeScript errors, no build errors.

## 10. Deployment

**Firebase Hosting** (recommended — keeps everything in one project/console):

```
firebase deploy --only hosting
```

`firebase.json` already configures `public: "dist"` and a SPA rewrite
(`**` → `/index.html`) so refreshing on `/dashboard` or `/fo` works instead
of 404ing. Any other static host (Vercel, Netlify, Cloudflare Pages) works
identically — just make sure it has the same SPA-fallback rewrite and the
six env vars set.

Manager URL: `https://<project-id>.web.app/` (also `/dashboard`). Field
Officer URL: `https://<project-id>.web.app/fo` — also the PWA's
`start_url`.

## 11. FO PWA installation

On an Android phone, in Chrome: open the FO URL → menu → **Add to Home
Screen** (or the automatic install prompt). It installs standalone, opens
straight to `/fo`, and works with the app icon and theme color already
configured in `vite.config.ts`. Verified in this session (see PWA section
of the acceptance report) against a local production build via `vite
preview` — manifest, service worker registration, icons, and a full
app-shell reload while offline all passed.

## 12. Offline behavior

The FO app keeps working with no connection: opening assignments,
preflight, starting/ending a session, reporting an issue — every action
saves to this device immediately (IndexedDB outbox, `src/data/outbox.ts`)
and shows an **Offline** banner rather than silently pretending to sync.
Reconnecting drains the queue automatically. Verified against a mock
backend (no live Firestore project exists in this environment) — see
Sync behavior below for what that proves and doesn't.

## 13. Sync behavior

- Local changes are diffed (not the whole dataset — see `src/data/
  syncEngine.ts`) and pushed as soon as they land in the outbox, not on a
  polling loop.
- The activity log is the one collection capped at the query level (most
  recent 500 events) in `src/data/firebaseBackend.ts`, since it's the only
  genuinely unbounded, high-write-frequency collection — everything else
  is small enough for one city that a full-collection listener is fine.
- Three real states are shown, never faked: **Offline** (queued, will send
  later), **Syncing** (pending count > 0, currently online), **Sync error**
  (a write was actually rejected while online — permission denied, backend
  unavailable — surfaced with the real error, never silently dropped or
  claimed successful). A small dot next to "System Status" in the Manager
  sidebar reflects the same real state (green/blue/amber/red).
- **What's verified vs. not**: the enqueue → survive-reload → drain-on-
  reconnect → no-duplicate-writes contract is verified end-to-end against
  an in-memory mock backend (`window.__CITY_OPS_TEST_BACKEND__`, a test-
  only seam that does nothing for real users). The actual network calls to
  a live Firestore project — real cross-device sync, real permission-denied
  handling against real rules — are **not** verified; there is no live
  project to test against here.

## 14. Backup / export

Unchanged from the original single-user build: Settings → Data has JSON
backup/restore and CSV export for businesses/sessions/issues, independent
of demo or production mode and of any paid service.

## 15. Troubleshooting

| Symptom | Likely cause |
|---|---|
| App stays in demo mode after setting env vars | One of the six `VITE_FIREBASE_*` vars is missing or misspelled — all six are required (`src/auth/config.ts`). Rebuild after changing `.env` (Vite bakes these in at build time). |
| Login page has no email/password fields, only demo buttons | You're still in demo mode — see above. |
| Firestore reads fail from the FO app | Check `firestore.rules` was actually deployed (`firebase deploy --only firestore:rules`) and that the FO's `users/{uid}` doc has the right `foId`. |
| New user can log in but sees "No field officer profile found" | Their `users/{uid}` doc is missing, has the wrong `role`, or its `foId` doesn't match an existing `FieldOfficer` record. |
| `firebase` commands fail with "have you run firebase login?" | Expected until you authenticate: `firebase login`, then `firebase use --add` to select your project. |
| Refreshing `/dashboard` or `/fo` 404s on your host | Your static host isn't rewriting all paths to `/index.html` (SPA fallback). Firebase Hosting's config in `firebase.json` already does this. |

## Known limitations

- **The Firebase Auth/Firestore path is written, reviewed, and rules-
  syntax-checked, but not live-tested.** No Firebase account or project
  exists in this environment.
- **No live cross-device test has been run.** That requires the app to be
  actually deployed against a real project first.
- No admin UI for provisioning users (see section 6) — worth building if
  the roster grows past a handful of people.
- Single Firebase project only — no multi-city/multi-tenant support, out
  of scope per the "one small city" brief.
