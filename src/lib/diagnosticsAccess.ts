/** Gates visibility of FoDiagnosticPanel (build info, sync/profile
 * internals — see src/components/FoDiagnosticPanel.tsx) — developer/support
 * tooling built for production debugging, never part of the normal Field
 * Officer product experience. An FO must never see it by default.
 *
 * Two ways in, both explicit opt-in:
 *  - Local development (`npm run dev`): always on, via Vite's own DEV flag
 *    — no setup needed while building/debugging locally.
 *  - Any deployment, including production: append `?diag=1` to the URL
 *    once; the choice is remembered in localStorage for that device/browser
 *    until turned off again with `?diag=0`. This is what makes it possible
 *    to debug a real FO's real production sync/profile issue without
 *    shipping a second build — the exact scenario this panel exists for —
 *    while keeping it invisible to every FO who never opts in. */
const STORAGE_KEY = "city-ops-diagnostics-enabled";

export function isDiagnosticsEnabled(): boolean {
  if (import.meta.env.DEV) return true;
  if (typeof window === "undefined") return false;

  const params = new URLSearchParams(window.location.search);
  if (params.has("diag")) {
    const on = params.get("diag") === "1";
    try {
      window.localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
    } catch {
      // Storage unavailable (private mode, quota) — the URL param itself
      // still governs this page load; it just won't persist across visits.
    }
    return on;
  }

  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}
