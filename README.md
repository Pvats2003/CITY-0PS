# City Ops OS

A local-first, zero-cost city operations command center for one city manager
running field operations — businesses, field officers (FOs), collectors, and
recording rigs. No backend, no cloud, no subscription. Everything runs and
persists in your browser.

## Getting started

```bash
npm install
npm run dev
```

Open the printed local URL. On first run you can **Load Demo City** (18
businesses, 5 FOs, 8 rigs, a week of realistic operational history) or
**Start My City** from a blank slate.

## Zero-cost architecture

- **No backend, no remote database.** All data lives in `localStorage` via a
  [Zustand](https://github.com/pmndrs/zustand) store (`src/store/city.ts`).
- **No paid APIs.** No map API, no AI API, no auth service. "Open in Maps"
  uses a plain `https://www.google.com/maps/...` deep link — no key required.
- **No AI, real or fake.** Every recommendation, score, and insight in the
  product (`src/engine/`) is a deterministic, explainable rule over your own
  local data. Nothing is ever invented.
- **Works offline.** Refreshing, closing the tab, or losing your connection
  never loses data or blocks a workflow — see Settings → Import/Export for
  full JSON backup/restore.

## Where things live

- `src/types` — the data model (Business, FieldOfficer, Rig, Assignment,
  Session, Issue, QualityReview, ActivityEvent, DailyPlan, DailyReport, …)
- `src/store/city.ts` — the single persisted store and its actions
- `src/engine/` — pure, deterministic logic: city health scoring, the
  attention feed, lost-hours accounting, the daily planner + conflict
  detector, SOD/MOD/EOD report builders, and the local City Copilot query
  engine
- `src/lib/demo/` — the seeded demo-data generator
- `src/pages/` — one file per screen (Command Center, Today, Businesses,
  Field Officers + Execution Mode, Sessions, Issues, Quality, Reports,
  Analytics, Search, Settings)
- `src/components/ui/` — small local component primitives (button, card,
  dialog, tabs, select, …) built on Radix, styled to match a Linear/Stripe-
  style dark-first design system

## Building for production

```bash
npm run build
npm run preview
```

The output in `dist/` is fully static — host it anywhere, or just open
`dist/index.html` — it never talks to a server.
