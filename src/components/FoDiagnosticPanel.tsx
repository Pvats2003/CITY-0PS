import { useEffect, useState } from "react";
import { Copy, Check } from "lucide-react";
import { useAuth } from "@/auth/AuthContext";
import { useProfileDiag } from "@/auth/useProfileDiag";
import { BUILD_SHA, BUILD_TIME } from "@/lib/buildInfo";
import { Button } from "@/components/ui/button";
import type { CollectionSyncState } from "@/data/useCollectionSyncStatus";

/** Dynamically imported (never a static top-level import) so this panel —
 * reachable from FOExecution.tsx, which is part of the main bundle — never
 * drags firebase/app into the bundle demo mode ships. Only called when
 * !isDemoMode. */
function useFirebaseProjectId(): string | null {
  const { isDemoMode } = useAuth();
  const [projectId, setProjectId] = useState<string | null>(null);
  useEffect(() => {
    if (isDemoMode) return;
    let cancelled = false;
    import("@/auth/firebaseApp").then(({ getFirebaseApp }) => {
      try {
        const app = getFirebaseApp();
        if (!cancelled) setProjectId(app.options.projectId ?? null);
      } catch {
        // Not yet configured/initialized — leave null, not an error state.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isDemoMode]);
  return projectId;
}

/** A string is "suspicious" — worth showing character codes for — when it
 * has incidental whitespace or any non-printable-ASCII character (a
 * homoglyph, a zero-width character, anything that would look identical to
 * the correct value in a rendered UI but isn't the same bytes). */
function isSuspiciousString(raw: string): boolean {
  return raw !== raw.trim() || /[^\x20-\x7E]/.test(raw);
}

function charCodesOf(raw: string): string {
  return [...raw].map((c) => c.charCodeAt(0)).join(",");
}

function displayValue(raw: unknown): string {
  return JSON.stringify(raw) ?? "undefined";
}

function Row({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-2 shrink-0 w-32">{label}</span>
      <span className={mono ? "font-mono text-xs break-all" : "text-xs break-all"}>{value}</span>
    </div>
  );
}

export interface FoDiagnosticPanelProps {
  requestedFoId: unknown;
  matchedFoId: string | null;
  matchedFoName: string | null;
  fosCount: number;
  fosSync: CollectionSyncState;
  screen: string;
}

/** On-page diagnostic for the FO profile/foId resolution chain — added
 * because production browser console output has repeatedly proven
 * unreliable to capture (empty screenshots, collapsed objects). Every
 * value here is plain rendered text: React renders a string/number prop as
 * a DOM text node, never a collapsed console-style object, so this is
 * readable directly from any screenshot. Shown on every non-"ready" FO
 * screen (see FOExecution.tsx). Reads ONLY already-captured state
 * (profileDiag.ts, useAuth(), useCollectionSyncStatus) — makes no writes,
 * mutates nothing. */
export function FoDiagnosticPanel({ requestedFoId, matchedFoId, matchedFoName, fosCount, fosSync, screen }: FoDiagnosticPanelProps) {
  const { user, isDemoMode } = useAuth();
  const profileDiag = useProfileDiag();
  const projectId = useFirebaseProjectId();
  const [copied, setCopied] = useState(false);

  const authUid = profileDiag?.authUid ?? user?.id ?? null;
  const docId = profileDiag?.docId ?? null;
  // Explicit equality check, never assumed — doc(db, "users", uid) forces
  // this by construction in the current code, but the panel proves it from
  // the actual captured values rather than stating it.
  const uidMatch = authUid !== null && docId !== null ? authUid === docId : null;

  // Raw (pre-trim) values when available (the real Firebase path always
  // captures these); falls back to the already-processed AppUser values
  // only when no raw snapshot exists yet (demo mode, or before the first
  // read completes).
  const rawRole = profileDiag ? profileDiag.rawRole : (user?.role ?? null);
  const rawFoId = profileDiag ? profileDiag.rawFoId : (user?.foId ?? null);
  const roleSuspicious = typeof rawRole === "string" && isSuspiciousString(rawRole);
  const foIdSuspicious = typeof rawFoId === "string" && isSuspiciousString(rawFoId);

  const foIdType = typeof rawFoId;
  const foIdLength = typeof rawFoId === "string" ? rawFoId.length : -1;

  const syncErrorText = fosSync.error ? `fos: ${fosSync.error}` : "NONE";

  const copyLines = [
    `BUILD_SHA=${BUILD_SHA}`,
    `BUILD_TIME=${BUILD_TIME}`,
    `PROJECT_ID=${projectId ?? (isDemoMode ? "N/A (demo mode)" : "unknown")}`,
    `AUTH_UID=${authUid ?? "NONE"}`,
    `PROFILE_DOC_ID=${docId ?? "NONE"}`,
    `UID_MATCH=${uidMatch === null ? "N/A" : uidMatch ? "YES" : "NO"}`,
    `PROFILE_EXISTS=${profileDiag ? String(profileDiag.exists) : "N/A"}`,
    `ROLE=${displayValue(rawRole)}`,
    `FO_ID=${displayValue(rawFoId)}`,
    `FO_ID_TYPE=${foIdType}`,
    `FO_ID_LENGTH=${foIdLength}`,
    `FOS_SYNC=${fosSync.status}`,
    `FOS_COUNT=${fosCount}`,
    `MATCHED_FO_ID=${matchedFoId ?? "NONE"}`,
    `MATCHED_FO_NAME=${matchedFoName ?? "NONE"}`,
    `CURRENT_SCREEN=${screen}`,
    `SYNC_ERROR=${syncErrorText}`,
  ];

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(copyLines.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable in this context — nothing safe to fall
      // back to; the panel's own text is already selectable/readable.
    }
  }

  return (
    <div className="mt-4 w-full rounded-lg border border-border bg-surface-2 p-3 text-left">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-2 mb-1.5">City Ops Diagnostic</div>

      <Row label="Build SHA" value={BUILD_SHA} />
      <Row label="Build time" value={BUILD_TIME} />
      <Row label="Firebase project" value={projectId ?? (isDemoMode ? "N/A (demo mode)" : "loading…")} />

      <div className="h-px bg-border my-1.5" />
      <Row label="Authenticated" value={String(!!user)} />
      <Row label="Auth UID" value={authUid ?? "NONE"} />

      <div className="h-px bg-border my-1.5" />
      <Row label="Profile path" value={profileDiag?.path ?? `users/${authUid ?? "?"}`} />
      <Row label="Profile exists" value={profileDiag ? String(profileDiag.exists) : "N/A"} />
      <Row label="Profile doc ID" value={docId ?? "NONE"} />
      <Row label="Profile keys" value={profileDiag ? profileDiag.keys.join(", ") || "(none)" : "N/A"} />
      <Row
        label="UID === DOC ID"
        value={uidMatch === null ? "N/A" : uidMatch ? "YES" : "NO — Firebase Auth UID does not match the users/{uid} profile document."}
      />

      <div className="h-px bg-border my-1.5" />
      <Row label="Role" value={displayValue(rawRole)} />
      <Row label="Role type" value={typeof rawRole} />
      {roleSuspicious && typeof rawRole === "string" && <Row label="Role chars" value={charCodesOf(rawRole)} />}

      <Row label="FoId" value={displayValue(rawFoId)} />
      <Row label="FoId type" value={foIdType} />
      <Row label="FoId length" value={String(foIdLength)} />
      {foIdSuspicious && typeof rawFoId === "string" && <Row label="FoId chars" value={charCodesOf(rawFoId)} />}
      <Row label="FoId (normalized)" value={displayValue(user?.foId ?? null)} />

      <div className="h-px bg-border my-1.5" />
      <Row label="Fos synced" value={String(fosSync.hasSyncedOnce)} />
      <Row label="Fos count" value={String(fosCount)} />
      <Row label="Requested foId" value={displayValue(requestedFoId ?? null)} />
      <Row label="Matched FO id" value={matchedFoId ?? "NONE"} />
      <Row label="Matched FO name" value={matchedFoName ?? "NONE"} />

      <div className="h-px bg-border my-1.5" />
      <Row label="Current screen" value={screen} />
      <Row label="Sync error" value={syncErrorText} />

      <Button variant="secondary" size="sm" onClick={() => void handleCopy()} className="w-full mt-2.5">
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? "Copied" : "Copy diagnostic details"}
      </Button>
    </div>
  );
}
