# City Ops OS — Deployment Guide

City Ops OS runs in one of two modes, decided entirely by whether the
`VITE_FIREBASE_*` environment variables are set:

- **Demo mode** (default, no env vars set): everything lives in this
  browser's `localStorage`. Zero external network requests. Login offers
  two no-password demo identities (Manager / Field Officer). This is what
  ships if you deploy the app with no configuration at all.
- **Production mode** (all six `VITE_FIREBASE_*` vars set): a shared
  Firebase project backs authentication and data, with an offline queue so
  Field Officers keep working without a connection.

Nothing here has been deployed for you — this session has no Firebase
account, no hosting account, and no credentials. Everything below is code
and configuration ready to use; you provide the accounts.

## 1. Create a free Firebase project

1. Go to the [Firebase console](https://console.firebase.google.com) and
   create a new project (the free **Spark** plan is enough for a single
   city's operation — generous free quotas on Auth and Firestore reads/
   writes for this scale of usage).
2. In **Build → Authentication**, enable the **Email/Password** sign-in
   provider.
3. In **Build → Firestore Database**, create a database (production mode,
   pick a region close to your users).
4. In **Project settings → General → Your apps**, add a **Web app** and
   copy the six config values it gives you (`apiKey`, `authDomain`,
   `projectId`, `storageBucket`, `messagingSenderId`, `appId`).

## 2. Configure environment variables

Copy `.env.example` to `.env` and fill in the six values from step 1.4:

```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
```

All six must be present or the app silently stays in demo mode (see
`src/auth/config.ts`). `.env` is gitignored — never commit real values.

## 3. Deploy Firestore security rules

`firestore.rules` (repo root) is written and reviewed, but has never been
applied to a live project — there's no way to do that without a real
project. Once you have one:

```
npm install -g firebase-tools
firebase login
firebase init firestore   # point it at firestore.rules, keep default indexes
firebase deploy --only firestore:rules
```

## 4. Create user accounts and link roles

Firebase Auth only proves *who* someone is — their *role* (`MANAGER` or
`FIELD_OFFICER`) and, for Field Officers, which `FieldOfficer` record they
are, live in a `users/{uid}` Firestore document (see
`src/auth/firebaseAuth.ts`). For each person:

1. **Authentication → Users → Add user** — create their email/password.
2. Copy their generated **User UID**.
3. **Firestore Database → Start collection `users`** → document ID = that
   UID → add fields:
   - `role`: `"MANAGER"` or `"FIELD_OFFICER"` (string)
   - `foId`: (Field Officers only) the `id` of their `FieldOfficer` record
     — visible in the Manager app's Field Officers page, or in Firestore
     under the `fos` collection once a manager has added them
   - `displayName`: optional string

There's no admin UI for this in the app itself (deliberately — this is a
small, one-time setup step per person, not a feature worth building for a
handful of accounts). A manager only needs to do this once per new hire.

## 5. Deploy the app

The app is a static Vite build — any free static host works (Vercel,
Netlify, Firebase Hosting, Cloudflare Pages, GitHub Pages). Example with
Vercel or Netlify: connect the repo, set the build command to `npm run
build`, output directory `dist`, and add the six `VITE_FIREBASE_*`
environment variables in the host's dashboard (not in the repo).

```
npm run build   # outputs dist/
```

Manager URL: `https://<your-domain>/` (redirects to `/dashboard` after
login). Field Officer URL: `https://<your-domain>/fo` — this is also the
PWA's `start_url`, so "Add to Home Screen" on an FO's phone opens straight
into their own Today view.

## 6. Testing the sync engine without a live Firebase project

This session verified the entire offline-queue/sync contract (enqueue while
offline, survive reload, drain on reconnect, remote→local merge) against an
in-memory mock backend, not a live Firestore project — there was no way to
exercise a real one here. The seam used for that is
`window.__CITY_OPS_TEST_BACKEND__` (see `src/data/syncEngine.ts`): if set
before the app boots, it's used instead of the real Firebase/local choice.
It does nothing for real users — nothing in the shipped app ever sets it —
but it's there if you want to re-run the same kind of test, or write your
own, against a fake backend before trusting a live one.

## Known limitations

- **The Firebase auth/data path is written and reviewed, not live-tested.**
  Everything demo-mode-reachable (routing, roles, Rig Guardian, planner,
  reports, the FO app, the offline queue's logic) has been verified
  end-to-end in a real browser. The actual network calls to Firestore/
  Firebase Auth have not — there is no project to call.
- **No admin UI for provisioning users.** Intentional for this scale (see
  step 4) — worth building if the roster grows past a handful of people.
- **`firestore.rules` has never been deployed or tested against real
  traffic.** Review it yourself before relying on it in production.
- **Single Firebase project only.** No multi-city/multi-tenant support —
  out of scope per the "one small city" brief.
