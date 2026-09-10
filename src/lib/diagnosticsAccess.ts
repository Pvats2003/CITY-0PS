/** Gates visibility of FoDiagnosticPanel (build info, sync/profile
 * internals — see src/components/FoDiagnosticPanel.tsx) — developer
 * tooling, never part of the normal Field Officer product experience.
 *
 * Contract — exactly one input governs this, Vite's own build-time DEV
 * flag, so the answer is fixed at build time and cannot be changed at
 * runtime by anything a client can control:
 *  - Local development (`npm run dev`): always enabled.
 *  - Every built bundle — including a production deploy opened by a real
 *    Field Officer — always disabled, unconditionally.
 *
 * There is deliberately no URL query param, localStorage flag, or other
 * client-side toggle: a runtime opt-in is, by construction, something any
 * signed-in FO can also opt into. If production troubleshooting ever needs
 * this panel again, it must be reintroduced as an authenticated Manager/
 * admin-only surface (checked against the already-authenticated
 * AppUser.role, the same way every other Manager-only surface in this app
 * is gated) — never a publicly reachable flag. */
export function isDiagnosticsEnabled(): boolean {
  return import.meta.env.DEV;
}
