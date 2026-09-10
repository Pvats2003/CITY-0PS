import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import {
  ChevronLeft,
  MapPin,
  Navigation2,
  CalendarClock,
  Radio,
  UserRound,
  CheckCircle2,
  Circle,
  AlertTriangle,
  PlayCircle,
  StopCircle,
  ShieldAlert,
  LogOut,
  WifiOff,
  RefreshCw,
  Camera,
  Lock,
  ClipboardCheck,
  Store,
  Cpu,
} from "lucide-react";
import { useCity } from "@/store/city";
import { todayISO, fmtTime, fmtDate, fmtHours } from "@/lib/dates";
import {
  checkInAssignment,
  startSessionForAssignment,
  markEnRoute,
  captureLocationEvidence,
  captureStepEvidence,
  submitPrecheck,
  startInstallation,
  completeInstallationVerification,
} from "@/engine/workflows";
import { buildRigSummary, isDeployable, proposeRigReplacement } from "@/engine/rigGuardian";
import { toDeployability } from "@/engine/rigTaxonomy";
import { deriveExecutionStage, evidenceCompleteness, PRECHECK_ITEMS, INSTALLATION_ITEMS } from "@/engine/execution";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/status";
import { RigDeployabilityBadge } from "@/components/rigs/RigDeployabilityBadge";
import { cn } from "@/lib/utils";
import { id as genId } from "@/lib/id";
import { stashPendingFile } from "@/lib/pendingFileBlobs";
import { businessMapsUrl } from "@/lib/googleMaps";
import { IssueFormDialog } from "@/components/forms/IssueFormDialog";
import { RigIncidentFormDialog } from "@/components/forms/RigIncidentFormDialog";
import { PostSessionCheckDialog } from "@/components/forms/PostSessionCheckDialog";
import { useAuth } from "@/auth/AuthContext";
import { useSyncStatus } from "@/data/useSyncStatus";
import { useCollectionSyncStatus } from "@/data/useCollectionSyncStatus";
import { useFosDiag } from "@/data/useFosDiag";
import { FoDiagnosticPanel } from "@/components/FoDiagnosticPanel";
import { isDiagnosticsEnabled } from "@/lib/diagnosticsAccess";
import type { Assignment, EvidenceFile } from "@/types";

type BottomTab = "today" | "sessions" | "issues" | "profile";

/** The complete FO-resolution state machine, in the exact order it's
 * evaluated: no signed-in user at all first (defensive — RequireRole
 * already prevents reaching this component without one, in practice);
 * then a live sync error on `fos` (checked before "loading" — a denied
 * listener never delivers a snapshot, so checking loading first would
 * mask the error behind an infinite spinner forever); then still-loading;
 * then a profile missing foId; then a foId that doesn't match any loaded
 * FieldOfficer; then success. */
type FoScreen = "profile-missing" | "permission-error" | "loading" | "foId-missing" | "fo-not-found" | "ready";

export default function FOExecution() {
  // /field-officers/:id/execute (manager preview) supplies id via the URL;
  // /fo (the FO's own login) has no id param — it's resolved from their
  // authenticated identity instead.
  const params = useParams();
  const { user, logout } = useAuth();
  const id = params.id ?? user?.foId;
  const data = useCity();
  // The application identity is FieldOfficer.id (the app-level foId, e.g.
  // "FO_RJT001"), never the Firestore document ID — firebaseBackend.ts's
  // subscribeCollection maps snapshots via d.data(), which discards d.id
  // entirely, so a document's own Firestore doc ID is never even available
  // here to match against by mistake.
  const fo = data.fos.find((f) => f.id === id);
  // Scoped to the ONE collection this page actually depends on — a denied
  // listener on a collection this page never reads (Manager-only or
  // otherwise) must never surface here. See useCollectionSyncStatus.ts /
  // outbox.ts's per-collection error map.
  const fosSync = useCollectionSyncStatus("fos");
  const fosDiag = useFosDiag();
  // Developer/support tooling only — never part of the normal FO product
  // experience. See src/lib/diagnosticsAccess.ts for how to opt in.
  const diagnosticsEnabled = isDiagnosticsEnabled();
  const date = todayISO();
  const [tab, setTab] = useState<BottomTab>("today");
  const [selected, setSelected] = useState<string | null>(null);
  const [, forceTick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const bizMap = new Map(data.businesses.map((b) => [b.id, b]));
  const today = useMemo(
    () => data.assignments.filter((a) => a.foId === id && a.date === date).sort((a, b) => new Date(a.plannedStart).getTime() - new Date(b.plannedStart).getTime()),
    [data.assignments, id, date],
  );

  // One of exactly six values — see the doc comment on FoScreen below.
  // Order matters and mirrors the render order further down: a live error
  // is checked before "loading" (a denied listener never delivers a
  // snapshot, so checking loading first would mask the error behind an
  // infinite spinner forever), and !user.foId before !fo (fo can only be
  // undefined "for a good reason" once we know which reason).
  const screen: FoScreen = params.id
    ? "ready" // manager-preview path renders its own not-found redirect below; not part of this state machine
    : !user
      ? "profile-missing"
      : fosSync.error
        ? "permission-error"
        : fosSync.status === "loading"
          ? "loading"
          : !user.foId
            ? "foId-missing"
            : !fo
              ? "fo-not-found"
              : "ready";

  // TEMPORARY production diagnostics — PRIMITIVE values only, never a
  // collapsed object a screenshot can't show the contents of. Fires once
  // per real change (not on the 1s tick above), only for the FO's own
  // login (never the manager-preview path). A second "FO resolution" entry
  // shortly after the first is expected and NOT a bug: fosSync and `user`
  // are two independently-updating signals (one from syncEngine's
  // synced-collections/error tracking, one from AuthContext), so a
  // snapshot arriving and an auth-state settling land as two separate
  // React state updates, each satisfying this effect's own dependency
  // change — not React StrictMode (which does not double-invoke effects in
  // a production build) and not a duplicate subscription. Never logs
  // passwords, tokens, or credentials. Safe to delete once resolved.
  useEffect(() => {
    if (params.id) return;
    console.log(
      "[CITY-OPS-DIAG] FO resolution",
      "t=", Math.round(performance.now()),
      "uid=", user?.id ?? null,
      "role=", user?.role ?? null,
      "requestedFoId=", JSON.stringify(id ?? null),
      "requestedFoIdType=", typeof id,
      "hasFoId=", Boolean(user?.foId),
      "fosCount=", data.fos.length,
      "matchedFoId=", fo?.id ?? null,
      "hasSyncedOnce=", fosSync.hasSyncedOnce,
      "syncError=", fosSync.error ?? null,
    );

    // The exact operands of `f.id === id` below, dumped as primitives
    // before the comparison runs — never summarized as an Object/Array, so
    // a screenshot of the console (or the on-page panel, which renders the
    // same data — see FoDiagnosticPanel's candidates section) shows exactly
    // what each fos record's app-level id is, not what we assume it is.
    const requestedFoId = user?.foId;
    console.log(
      "[CITY-OPS-DIAG] FO_MATCH_INPUT",
      "requestedFoId=" + JSON.stringify(requestedFoId),
      "requestedFoIdType=" + typeof requestedFoId,
      "fosCount=" + data.fos.length,
      "fosIds=" + JSON.stringify(data.fos.map((f) => f.id)),
      "fosIdTypes=" + JSON.stringify(data.fos.map((f) => typeof f.id)),
      "fosNames=" + JSON.stringify(data.fos.map((f) => f.name)),
    );
    data.fos.forEach((f, i) => {
      console.log(
        "[CITY-OPS-DIAG] FO_CANDIDATE",
        "index=" + i,
        "dataId=" + JSON.stringify(f.id),
        "dataIdType=" + typeof f.id,
        "dataIdLength=" + (typeof f.id === "string" ? f.id.length : -1),
        "name=" + JSON.stringify(f.name),
        "exactEqual=" + (f.id === requestedFoId),
        "trimEqual=" +
          (typeof f.id === "string" && typeof requestedFoId === "string" && f.id.trim() === requestedFoId.trim()),
      );
    });
    const exactMatch = fo !== undefined;
    const trimMatch = data.fos.some(
      (f) => typeof f.id === "string" && typeof requestedFoId === "string" && f.id.trim() === requestedFoId.trim(),
    );
    console.log(
      "[CITY-OPS-DIAG] FO_STATE",
      "auth=", user ? "authed" : "unauthed",
      "profile=", user ? "present" : "missing",
      "role=", user?.role ?? null,
      "foId=", JSON.stringify(user?.foId ?? null),
      "fosSync=", fosSync.status,
      "fosCount=", data.fos.length,
      "fosIds=", JSON.stringify(data.fos.map((f) => f.id)),
      "fosDocIds=", JSON.stringify(fosDiag?.records.map((r) => r.docId) ?? []),
      "fosNames=", JSON.stringify(data.fos.map((f) => f.name)),
      "matchedFo=", fo?.id ?? null,
      "exactMatch=", exactMatch,
      "trimMatch=", trimMatch,
      "syncError=", fosSync.error ?? null,
      "screen=", screen,
    );
  }, [fo, params.id, id, user, data.fos, fosSync.status, fosSync.hasSyncedOnce, fosSync.error, screen, fosDiag]);

  if (!fo) {
    // Manager preview of a specific FO that no longer exists.
    if (params.id) return <Navigate to="/field-officers" replace />;

    // Defensive: RequireRole already guarantees a signed-in user before
    // this component ever renders, so this should be unreachable in
    // practice — kept as its own explicit branch (rather than falling into
    // the foId-missing/fo-not-found text below, which would render an
    // awkward "undefined") since the diagnostic panel now explicitly
    // supports this state and a real bug that somehow reached it deserves
    // a clear message, not a broken one.
    if (screen === "profile-missing") {
      return (
        <div className="min-h-dvh flex flex-col items-center justify-center gap-3 bg-background text-foreground max-w-md mx-auto border-x border-border p-6 text-center">
          <UserRound className="size-10 text-muted" />
          <div className="text-base font-semibold">No signed-in account found</div>
          <p className="text-sm text-muted">Your session doesn't have an authenticated profile. Try signing in again.</p>
          <Link to="/fo/login" className="text-sm text-primary hover:underline">
            Go to sign in
          </Link>
          {diagnosticsEnabled && (
            <FoDiagnosticPanel requestedFoId={id} matchedFoId={null} matchedFoName={null} fosCount={data.fos.length} fosSync={fosSync} screen={screen} />
          )}
        </div>
      );
    }

    if (screen === "permission-error") {
      return (
        <div className="min-h-dvh flex flex-col items-center justify-center gap-3 bg-background text-foreground max-w-md mx-auto border-x border-border p-6 text-center">
          <ShieldAlert className="size-10 text-critical" />
          <div className="text-base font-semibold">Couldn't load your field officer data</div>
          <p className="text-sm text-muted">{fosSync.error ?? "A sync error is preventing your profile from loading."}</p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => window.location.reload()}>
              <RefreshCw className="size-4" /> Retry
            </Button>
            <Button variant="secondary" onClick={() => logout()}>
              <LogOut className="size-4" /> Sign out
            </Button>
          </div>
          {diagnosticsEnabled && (
            <FoDiagnosticPanel
              requestedFoId={id}
              matchedFoId={null}
              matchedFoName={null}
              fosCount={data.fos.length}
              fosSync={fosSync}
              screen={screen}
            />
          )}
        </div>
      );
    }

    // The fos collection hasn't delivered its first snapshot yet — this is
    // NOT "not found," it's "don't know yet." Concluding "not configured"
    // here (as the code used to) is exactly what made a correct foId look
    // broken during the brief (or, before the syncEngine fix, permanent)
    // window before the first snapshot arrives.
    if (screen === "loading") {
      return (
        <div className="min-h-dvh flex flex-col items-center justify-center gap-3 bg-background text-foreground max-w-md mx-auto border-x border-border p-6 text-center">
          <RefreshCw className="size-8 text-muted animate-spin" />
          <div className="text-base font-semibold">Loading your field officer profile…</div>
          <p className="text-sm text-muted">Syncing with your city's data.</p>
          {diagnosticsEnabled && (
            <FoDiagnosticPanel
              requestedFoId={id}
              matchedFoId={null}
              matchedFoName={null}
              fosCount={data.fos.length}
              fosSync={fosSync}
              screen={screen}
            />
          )}
        </div>
      );
    }

    // Loaded (or demo mode, where sync doesn't apply) and genuinely not
    // found. Logged-in FO whose users/{uid} doc doesn't resolve to a real
    // FieldOfficer record — either foId was never set, or it was set to an
    // id that doesn't match anyone in the loaded city. Distinct messages so
    // whoever provisioned the account knows exactly what to fix.
    const reason =
      screen === "foId-missing"
        ? "Your account's users/{uid} profile doesn't have a foId set."
        : `Your account's foId ("${user?.foId}") doesn't match any field officer in this city.`;
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-3 bg-background text-foreground max-w-md mx-auto border-x border-border p-6 text-center">
        <UserRound className="size-10 text-muted" />
        <div className="text-base font-semibold">Field Officer profile not configured</div>
        <p className="text-sm text-muted">{reason} Ask your administrator to check it in Firestore, or your manager to confirm your assignment.</p>
        <Button variant="secondary" onClick={() => logout()}>
          <LogOut className="size-4" /> Sign out
        </Button>
        {diagnosticsEnabled && (
          <FoDiagnosticPanel
            requestedFoId={id}
            matchedFoId={null}
            matchedFoName={null}
            fosCount={data.fos.length}
            fosSync={fosSync}
            screen={screen}
          />
        )}
      </div>
    );
  }

  const selectedAssignment = today.find((a) => a.id === selected);

  return (
    <div className="min-h-dvh flex flex-col bg-background text-foreground max-w-md mx-auto border-x border-border">
      <header className="flex items-center gap-2 h-14 px-3 border-b border-border shrink-0">
        {selectedAssignment ? (
          <button onClick={() => setSelected(null)} className="p-2 -ml-2 rounded-md hover:bg-surface-2">
            <ChevronLeft className="size-5" />
          </button>
        ) : (
          <div className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary font-semibold text-xs">
            {fo.name.split(" ").map((p) => p[0]).join("").slice(0, 2)}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate">{selectedAssignment ? bizMap.get(selectedAssignment.businessId)?.name : fo.name}</div>
          <div className="text-[11px] text-muted">{selectedAssignment ? "Visit" : "Field Officer Cockpit"}</div>
        </div>
        {params.id ? (
          <Link to={`/field-officers/${fo.id}`} className="text-xs text-primary shrink-0">
            Desktop
          </Link>
        ) : (
          <button onClick={() => logout()} className="p-2 -mr-2 rounded-md hover:bg-surface-2 text-muted shrink-0" title="Sign out">
            <LogOut className="size-4" />
          </button>
        )}
      </header>

      <SyncStatusBanner />

      {!params.id && diagnosticsEnabled && (
        <div className="px-3 pt-2">
          <FoDiagnosticPanel requestedFoId={id} matchedFoId={fo.id} matchedFoName={fo.name} fosCount={data.fos.length} fosSync={fosSync} screen={screen} />
        </div>
      )}

      <main className="flex-1 overflow-y-auto pb-2">
        {tab === "today" && (
          selectedAssignment ? (
            <ExecutionFlow assignment={selectedAssignment} />
          ) : (
            <TodayList assignments={today} onSelect={setSelected} />
          )
        )}
        {tab === "sessions" && <SessionsTab foId={fo.id} />}
        {tab === "issues" && <IssuesTab foId={fo.id} />}
        {tab === "profile" && <ProfileTab foId={fo.id} isPreview={!!params.id} />}
      </main>

      <nav className="grid grid-cols-4 border-t border-border shrink-0 bg-surface">
        <BottomNavItem icon={CalendarClock} label="Today" active={tab === "today"} onClick={() => { setTab("today"); }} />
        <BottomNavItem icon={Radio} label="Sessions" active={tab === "sessions"} onClick={() => setTab("sessions")} />
        <BottomNavItem icon={AlertTriangle} label="Issues" active={tab === "issues"} onClick={() => setTab("issues")} />
        <BottomNavItem icon={UserRound} label="Profile" active={tab === "profile"} onClick={() => setTab("profile")} />
      </nav>
    </div>
  );
}

/** Real status only (spec: never fake real-time). Silent in demo mode —
 * there's no shared backend to report on, so nothing is shown rather than
 * a misleading "online" indicator. */
function SyncStatusBanner() {
  const { status, pendingCount, errorMessage } = useSyncStatus();
  if (status === "disabled" || status === "online") return null;
  if (status === "offline") {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-warning-bg border-b border-warning/20 text-xs text-warning">
        <WifiOff className="size-3.5 shrink-0" />
        Offline — changes saved on this device. Will sync automatically when connection returns.
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-critical-bg border-b border-critical/20 text-xs text-critical">
        <ShieldAlert className="size-3.5 shrink-0" />
        Sync error — {errorMessage ?? "a change could not be saved."} {pendingCount} change{pendingCount === 1 ? "" : "s"} still waiting.
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-info-bg border-b border-info/20 text-xs text-info">
      <RefreshCw className="size-3.5 shrink-0 animate-spin" />
      Sync pending — {pendingCount} change{pendingCount === 1 ? "" : "s"} waiting to upload.
    </div>
  );
}

function BottomNavItem({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col items-center justify-center gap-0.5 py-2.5 min-h-[52px] text-[11px] font-medium",
        active ? "text-primary" : "text-muted",
      )}
    >
      <Icon className="size-5" />
      {label}
    </button>
  );
}

function TodayList({ assignments, onSelect }: { assignments: Assignment[]; onSelect: (id: string) => void }) {
  const data = useCity();
  const bizMap = new Map(data.businesses.map((b) => [b.id, b]));
  const rigMap = new Map(data.rigs.map((r) => [r.id, r]));

  if (assignments.length === 0) {
    return <div className="p-8 text-center text-sm text-muted">No visits scheduled today.</div>;
  }

  return (
    <div className="p-3 space-y-2.5">
      <div className="text-xs font-medium text-muted px-0.5">
        {assignments.length} ASSIGNMENT{assignments.length === 1 ? "" : "S"}
      </div>
      {assignments.map((a) => {
        const biz = bizMap.get(a.businessId);
        const rig = a.rigId ? rigMap.get(a.rigId) : undefined;
        const done = a.status === "completed";
        const active = a.status === "in_progress";
        const mapsUrl = biz ? businessMapsUrl(biz) : undefined;
        return (
          <div key={a.id} className="flex items-stretch gap-2">
            <button
              onClick={() => onSelect(a.id)}
              className="flex-1 text-left rounded-lg border border-border bg-surface p-3.5 active:scale-[0.99] transition-transform min-w-0"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted tabular-nums">{fmtTime(a.plannedStart)}</span>
                <StatusBadge status={done ? "completed" : active ? "active" : "pending"} />
              </div>
              <div className="text-base font-semibold mt-1 truncate">{biz?.name}</div>
              <div className="text-xs text-muted flex items-center gap-1 mt-0.5">
                <MapPin className="size-3.5" /> {biz?.area}
                {rig && <span className="text-muted-2">· {rig.code}</span>}
              </div>
            </button>
            {mapsUrl && (
              <a
                href={mapsUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="flex items-center justify-center rounded-lg border border-border bg-surface px-3 text-primary shrink-0"
                title="Open in Google Maps"
              >
                <Navigation2 className="size-4" />
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PhotoCapture({ label, files, onChange }: { label: string; files: EvidenceFile[]; onChange: (files: EvidenceFile[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  function handleFiles(fl: FileList | null) {
    if (!fl || fl.length === 0) return;
    const items: EvidenceFile[] = Array.from(fl).map((f) => {
      const id = genId("file");
      stashPendingFile(id, f);
      return {
        id,
        name: f.name,
        type: f.type || "image/jpeg",
        sizeBytes: f.size,
        localUrl: URL.createObjectURL(f),
        capturedAt: new Date().toISOString(),
        uploadStatus: "local_only",
      };
    });
    onChange([...files, ...items]);
  }
  const allUploaded = files.length > 0 && files.every((f) => f.uploadStatus == null || f.uploadStatus === "uploaded");
  const anyPending = files.some((f) => f.uploadStatus === "local_only" || f.uploadStatus === "uploading");
  const anyFailed = files.some((f) => f.uploadStatus === "upload_failed");

  return (
    <div className="flex items-center gap-2">
      <input ref={inputRef} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => handleFiles(e.target.files)} />
      <Button type="button" variant="secondary" size="sm" onClick={() => inputRef.current?.click()}>
        <Camera className="size-3.5" /> {label} {files.length > 0 ? `(${files.length})` : ""}
      </Button>
      {allUploaded && <CheckCircle2 className="size-4 text-success" />}
      {!allUploaded && anyFailed && (
        <span className="text-[11px] text-critical flex items-center gap-1">
          <ShieldAlert className="size-3.5" /> Upload failed — retrying
        </span>
      )}
      {!allUploaded && !anyFailed && anyPending && (
        <span className="text-[11px] text-muted flex items-center gap-1">
          <RefreshCw className="size-3.5 animate-spin" /> Pending upload
        </span>
      )}
    </div>
  );
}

function EvidenceProgress({ assignment }: { assignment: Assignment }) {
  const data = useCity();
  const completeness = useMemo(() => evidenceCompleteness(assignment, data.evidence), [assignment, data.evidence]);
  return (
    <div className="rounded-lg border border-border bg-surface-2/50 p-3 text-xs">
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-medium">EVIDENCE</span>
        <span className="tabular-nums text-muted">
          {completeness.completeCount} / {completeness.totalCount} COMPLETE
        </span>
      </div>
      <div className="space-y-1">
        {completeness.slots.map((s) => (
          <div key={s.key} className="flex items-center gap-1.5">
            {s.present ? <CheckCircle2 className="size-3.5 text-success shrink-0" /> : <Circle className="size-3.5 text-muted-2 shrink-0" />}
            <span className={s.present ? "text-foreground" : "text-muted"}>{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ExecutionFlow({ assignment }: { assignment: Assignment }) {
  const data = useCity();
  const business = data.businesses.find((b) => b.id === assignment.businessId);
  const rig = data.rigs.find((r) => r.id === assignment.rigId);
  const rigSummary = rig ? buildRigSummary(data, rig) : null;
  const session = data.sessions.find((s) => s.id === assignment.sessionId && s.status !== "completed") ?? (assignment.sessionId ? data.sessions.find((s) => s.id === assignment.sessionId) : undefined);
  const assignmentEvidence = useMemo(() => data.evidence.filter((e) => e.assignmentId === assignment.id), [data.evidence, assignment.id]);
  const stage = useMemo(() => deriveExecutionStage(assignment, data.evidence, session), [assignment, data.evidence, session]);

  const [issueOpen, setIssueOpen] = useState(false);
  const [preflightIssueOpen, setPreflightIssueOpen] = useState(false);
  const [postCheckOpen, setPostCheckOpen] = useState(false);
  const [locBusy, setLocBusy] = useState(false);
  const [locError, setLocError] = useState<string | null>(null);
  const [arrivalPhotos, setArrivalPhotos] = useState<EvidenceFile[]>([]);
  const [precheckChecklist, setPrecheckChecklist] = useState<Record<string, boolean>>({});
  const [precheckPhotos, setPrecheckPhotos] = useState<EvidenceFile[]>([]);
  const [installPhotos, setInstallPhotos] = useState<EvidenceFile[]>([]);
  const [cablePhotos, setCablePhotos] = useState<EvidenceFile[]>([]);
  const [finalPhotos, setFinalPhotos] = useState<EvidenceFile[]>([]);
  const [installChecklist, setInstallChecklist] = useState<Record<string, boolean>>({});
  const [verifyChecklist, setVerifyChecklist] = useState<Record<string, boolean>>({});
  const [completionPhotos, setCompletionPhotos] = useState<EvidenceFile[]>([]);

  function handleArrive() {
    setLocBusy(true);
    setLocError(null);
    checkInAssignment(assignment);
    if (!navigator.geolocation) {
      captureLocationEvidence(assignment, business, 0, 0);
      setLocBusy(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        captureLocationEvidence(assignment, business, pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
        setLocBusy(false);
      },
      (err) => {
        setLocBusy(false);
        setLocError(err.message || "Could not get your location. Check location permissions and try again.");
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  // Only recheck requests the FO hasn't already responded to — once a
  // replacement is submitted (replacesEvidenceId set), the original stays
  // "recheck_requested" forever (append-only history) but must stop
  // prompting for another retake; the Manager reviewing the new submission
  // is what actually clears the request.
  const recheckEvidence = assignmentEvidence.filter(
    (e) => e.status === "recheck_requested" && !assignmentEvidence.some((other) => other.replacesEvidenceId === e.id),
  );
  if (assignment.reviewStatus === "recheck_requested" && recheckEvidence.length > 0) {
    return (
      <div className="p-4 space-y-4">
        <div className="rounded-xl border border-warning/30 bg-warning-bg p-5 text-center space-y-1">
          <AlertTriangle className="size-8 text-warning mx-auto" />
          <div className="text-base font-bold text-warning">ACTION REQUIRED</div>
          <div className="text-sm">{business?.name}{rig ? ` · ${rig.code}` : ""}</div>
        </div>
        {recheckEvidence.map((e) => (
          <div key={e.id} className="rounded-lg border border-border p-3 space-y-2">
            <div className="text-xs font-semibold text-muted">{e.type.replace(/_/g, " ")}</div>
            <div className="text-sm">Manager request: {e.reviewNote || "Please resubmit this evidence."}</div>
            <PhotoCapture
              label="Retake photo"
              files={[]}
              onChange={(files) => captureStepEvidence(assignment, e.type, files, undefined, e.id)}
            />
          </div>
        ))}
        <div className="text-xs text-muted text-center">Original evidence is kept on record — your new submission is added alongside it.</div>
      </div>
    );
  }

  if (assignment.reviewStatus === "recheck_requested" && recheckEvidence.length === 0) {
    // Every requested item has a resubmission on record — nothing left for
    // the FO to do; only the Manager's next review can clear this status.
    return (
      <div className="p-4 space-y-4">
        <div className="rounded-xl border border-info/30 bg-info-bg p-5 text-center space-y-1">
          <ClipboardCheck className="size-8 text-info mx-auto" />
          <div className="text-base font-bold text-info">RESUBMITTED</div>
          <div className="text-sm">{business?.name} — waiting on your Manager to review the new evidence.</div>
        </div>
        <EvidenceProgress assignment={assignment} />
      </div>
    );
  }

  if (assignment.reviewStatus === "approved" || stage === "approved") {
    return (
      <div className="p-6 text-center space-y-2">
        <CheckCircle2 className="size-10 text-success mx-auto" />
        <div className="text-base font-semibold">Approved</div>
        <div className="text-sm text-muted">{business?.name} — nice work.</div>
      </div>
    );
  }

  if (stage === "ready_for_review") {
    return (
      <div className="p-4 space-y-4">
        <div className="rounded-xl border border-info/30 bg-info-bg p-5 text-center space-y-1">
          <ClipboardCheck className="size-8 text-info mx-auto" />
          <div className="text-base font-bold text-info">READY FOR REVIEW</div>
          <div className="text-sm">{business?.name} — waiting on your Manager.</div>
        </div>
        <EvidenceProgress assignment={assignment} />
      </div>
    );
  }

  if (assignment.status === "completed" && stage === "completion") {
    return (
      <div className="p-4 space-y-4">
        <Section title="COMPLETION EVIDENCE">
          <div className="text-sm text-muted mb-2">Add the remaining evidence before this visit is ready for review.</div>
          <PhotoCapture label="Completion photo" files={completionPhotos} onChange={setCompletionPhotos} />
        </Section>
        <EvidenceProgress assignment={assignment} />
        <Button
          size="lg"
          className="w-full h-14 text-base"
          disabled={completionPhotos.length === 0}
          onClick={() => captureStepEvidence(assignment, "SESSION_END", completionPhotos)}
        >
          <CheckCircle2 className="size-5" /> Submit Evidence
        </Button>
      </div>
    );
  }

  if (stage === "assigned" || stage === "en_route" || !assignment.actualArrivalAt) {
    return (
      <div className="p-4 space-y-4">
        <Section title="ARRIVAL">
          <div className="text-sm text-muted">
            {fmtTime(assignment.plannedStart)} · {business?.area}
          </div>
          {business && businessMapsUrl(business) && (
            <div className="mt-3 rounded-lg border border-border bg-surface-2 p-3 space-y-2">
              <div className="text-xs font-semibold text-muted flex items-center gap-1.5">📍 Business Location</div>
              <Button asChild size="sm" variant="secondary" className="w-full">
                <a href={businessMapsUrl(business)} target="_blank" rel="noreferrer">
                  <Navigation2 className="size-4" /> Open in Google Maps
                </a>
              </Button>
            </div>
          )}
          {rig && rigSummary && (
            <div className="mt-3 rounded-lg border border-border bg-surface-2 p-3 flex items-center justify-between gap-2">
              <div>
                <div className="text-xs font-semibold text-muted">Your Rig</div>
                <div className="text-sm font-medium">{rig.code}</div>
              </div>
              <RigDeployabilityBadge status={toDeployability(rigSummary.readiness)} />
            </div>
          )}
        </Section>
        {!assignment.enRouteAt && (
          <Button variant="secondary" className="w-full h-12" onClick={() => markEnRoute(assignment)}>
            I'm on my way
          </Button>
        )}
        <Button size="lg" className="w-full h-14 text-base" disabled={locBusy} onClick={handleArrive}>
          {locBusy ? "Getting location…" : "I'm at Location"}
        </Button>
        {locError && (
          <div className="rounded-md border border-warning/25 bg-warning-bg px-3 py-2 text-xs text-warning space-y-1.5">
            <div>{locError}</div>
            <button className="underline" onClick={handleArrive}>
              Retry
            </button>
          </div>
        )}
      </div>
    );
  }

  if (stage === "arrived") {
    const location = assignmentEvidence.filter((e) => e.type === "LOCATION").sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    const verified = location?.metadata?.verified === true;
    return (
      <div className="p-4 space-y-4">
        <Section title="LOCATION">
          {location ? (
            <div className={cn("rounded-lg border p-3 text-sm flex items-center gap-2", verified ? "border-success/30 bg-success-bg text-success" : "border-warning/30 bg-warning-bg text-warning")}>
              {verified ? <CheckCircle2 className="size-4 shrink-0" /> : <AlertTriangle className="size-4 shrink-0" />}
              <span>
                {verified ? "LOCATION VERIFIED" : "LOCATION MISMATCH"} — {(location.metadata?.message as string) ?? "location recorded"}
              </span>
            </div>
          ) : (
            <div className="text-sm text-muted">Location captured.</div>
          )}
        </Section>
        <Section title="ARRIVAL PHOTO">
          <PhotoCapture label="Take arrival photo" files={arrivalPhotos} onChange={setArrivalPhotos} />
        </Section>
        <Button
          size="lg"
          className="w-full h-14 text-base"
          disabled={arrivalPhotos.length === 0}
          onClick={() => captureStepEvidence(assignment, "ARRIVAL", arrivalPhotos)}
        >
          Continue to Rig Precheck
        </Button>
      </div>
    );
  }

  if (stage === "location_verified" || stage === "precheck") {
    const latestPrecheck = assignmentEvidence.filter((e) => e.type === "RIG_PRECHECK").sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    if (rigSummary && !isDeployable(rigSummary.readiness)) {
      return (
        <div className="p-4 space-y-4">
          <div className="rounded-xl border border-critical/30 bg-critical-bg p-5 text-center space-y-2">
            <ShieldAlert className="size-10 text-critical mx-auto" />
            <div className="text-base font-bold text-critical">THIS RIG SHOULD NOT BE DEPLOYED</div>
            <div className="text-sm text-critical/90">
              {rig?.code}: {rigSummary.readinessReason}
            </div>
          </div>
          <Button size="lg" variant="destructive" className="w-full h-14 text-base" onClick={() => setPreflightIssueOpen(true)}>
            <AlertTriangle className="size-5" /> Report Rig Issue
          </Button>
          <div className="text-xs text-muted text-center">Contact dispatch for a replacement rig before starting this visit.</div>
          {rig && (
            <RigIncidentFormDialog
              open={preflightIssueOpen}
              onOpenChange={setPreflightIssueOpen}
              rigId={rig.id}
              defaultDiscoveryStage="preflight"
              defaults={{ businessId: assignment.businessId, foId: assignment.foId, assignmentId: assignment.id }}
            />
          )}
        </div>
      );
    }

    if (latestPrecheck && latestPrecheck.metadata?.passed === false && latestPrecheck.status !== "rejected") {
      const replacement = assignment.rigId ? proposeRigReplacement(data, assignment.date, assignment.rigId, assignment.plannedStart, assignment.plannedEnd) : null;
      return (
        <div className="p-4 space-y-4">
          <div className="rounded-xl border border-critical/30 bg-critical-bg p-5 text-center space-y-2">
            <ShieldAlert className="size-10 text-critical mx-auto" />
            <div className="text-base font-bold text-critical">RIG PRECHECK FAILED</div>
            <div className="text-sm text-critical/90">{rig?.code} — an issue has been reported to your Manager.</div>
          </div>
          {replacement && (
            <div className="rounded-lg border border-info/30 bg-info-bg p-3 text-sm text-info">
              AI recommendation: {replacement.rig.code} is ready ({replacement.reasons.join(", ")}). Your Manager will confirm a replacement.
            </div>
          )}
          <div className="text-xs text-muted text-center">Execution is blocked until your Manager assigns a ready rig.</div>
        </div>
      );
    }

    const allCriticalDone = PRECHECK_ITEMS.filter((i) => i.critical).every((i) => precheckChecklist[i.key]);
    return (
      <div className="p-4 space-y-4">
        <Section title={`RIG PRECHECK — ${rig?.code ?? "No rig"}`}>
          <div className="space-y-2.5">
            {PRECHECK_ITEMS.map((i) => (
              <label key={i.key} className="flex items-center gap-3 py-1">
                <Checkbox checked={!!precheckChecklist[i.key]} onCheckedChange={(v) => setPrecheckChecklist((c) => ({ ...c, [i.key]: !!v }))} />
                <span className="text-sm">{i.label}</span>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 mt-3">
            <PhotoCapture label="Rig photo" files={precheckPhotos} onChange={setPrecheckPhotos} />
          </div>
          {rig && (
            <button className="text-xs text-critical mt-3 flex items-center gap-1.5" onClick={() => setPreflightIssueOpen(true)}>
              <AlertTriangle className="size-3.5" /> Something's wrong with this rig
            </button>
          )}
        </Section>
        <Button
          size="lg"
          className="w-full h-14 text-base"
          onClick={() => submitPrecheck(assignment, precheckChecklist, precheckPhotos, allCriticalDone ? undefined : "Precheck failed — see checklist.")}
        >
          <ClipboardCheck className="size-5" /> Submit Precheck
        </Button>
        {rig && (
          <RigIncidentFormDialog
            open={preflightIssueOpen}
            onOpenChange={setPreflightIssueOpen}
            rigId={rig.id}
            defaultDiscoveryStage="preflight"
            defaults={{ businessId: assignment.businessId, foId: assignment.foId, assignmentId: assignment.id }}
          />
        )}
      </div>
    );
  }

  if (stage === "rig_ready") {
    return (
      <div className="p-4 space-y-4">
        <div className="rounded-xl border border-success/30 bg-success-bg p-5 text-center space-y-1">
          <CheckCircle2 className="size-8 text-success mx-auto" />
          <div className="text-base font-bold text-success">RIG READY</div>
          <div className="text-sm">{rig?.code} passed precheck.</div>
        </div>
        <Button size="lg" className="w-full h-14 text-base" onClick={() => startInstallation(assignment)}>
          Start Installation
        </Button>
      </div>
    );
  }

  if (stage === "installation") {
    const allCriticalDone = INSTALLATION_ITEMS.filter((i) => i.critical).every((i) => installChecklist[i.key]);
    const photosDone = installPhotos.length > 0 && cablePhotos.length > 0 && finalPhotos.length > 0;
    return (
      <div className="p-4 space-y-4">
        <Section title="INSTALLATION">
          <div className="space-y-2.5">
            {INSTALLATION_ITEMS.map((i) => (
              <label key={i.key} className="flex items-center gap-3 py-1">
                <Checkbox checked={!!installChecklist[i.key]} onCheckedChange={(v) => setInstallChecklist((c) => ({ ...c, [i.key]: !!v }))} />
                <span className="text-sm">{i.label}</span>
              </label>
            ))}
          </div>
          <div className="flex flex-col gap-2 mt-3">
            <PhotoCapture label="Installation photo" files={installPhotos} onChange={setInstallPhotos} />
            <PhotoCapture label="Cable routing photo" files={cablePhotos} onChange={setCablePhotos} />
            <PhotoCapture label="Final setup photo" files={finalPhotos} onChange={setFinalPhotos} />
          </div>
        </Section>
        <Button
          size="lg"
          className="w-full h-14 text-base"
          disabled={!allCriticalDone || !photosDone}
          onClick={() => {
            captureStepEvidence(assignment, "INSTALLATION", installPhotos);
            captureStepEvidence(assignment, "CABLE_SETUP", cablePhotos);
            captureStepEvidence(assignment, "FINAL_SETUP", finalPhotos);
          }}
        >
          Submit Installation
        </Button>
      </div>
    );
  }

  if (stage === "installation_verified") {
    const items = [
      { key: "installed", label: "Rig installed correctly" },
      { key: "positioned", label: "Camera/sensor positioned correctly" },
      { key: "secured", label: "Cables secured" },
      { key: "powered", label: "Power confirmed" },
      { key: "complete", label: "Setup complete" },
    ];
    const allDone = items.every((i) => verifyChecklist[i.key]);
    return (
      <div className="p-4 space-y-4">
        <Section title="INSTALLATION VERIFIED">
          <div className="text-sm text-muted mb-2">Confirm before starting the session.</div>
          <div className="space-y-2.5">
            {items.map((i) => (
              <label key={i.key} className="flex items-center gap-3 py-1">
                <Checkbox checked={!!verifyChecklist[i.key]} onCheckedChange={(v) => setVerifyChecklist((c) => ({ ...c, [i.key]: !!v }))} />
                <span className="text-sm">{i.label}</span>
              </label>
            ))}
          </div>
        </Section>
        <Button
          size="lg"
          className="w-full h-14 text-base"
          disabled={!allDone}
          onClick={() => {
            // Only unlocked here — arrival verified, precheck passed,
            // installation completed, and installation evidence all
            // already required to reach this stage (spec Phase 10).
            completeInstallationVerification(assignment);
            startSessionForAssignment(assignment);
          }}
        >
          <PlayCircle className="size-5" /> Start Session
        </Button>
      </div>
    );
  }

  if (stage === "session") {
    // Defensive only — deriveExecutionStage only ever returns "session" when
    // session?.status === "active", so this is unreachable in practice; kept
    // so TypeScript can narrow `session` below without a non-null assertion.
    if (!session) {
      return (
        <div className="p-4 space-y-4">
          <div className="rounded-lg border border-border bg-surface-2/50 p-4 text-sm text-muted flex items-center gap-2">
            <Lock className="size-4" /> Session locked — complete installation verification first.
          </div>
        </div>
      );
    }
    const elapsedSec = Math.max(0, Math.floor((Date.now() - new Date(session.startedAt).getTime()) / 1000));
    const h = String(Math.floor(elapsedSec / 3600)).padStart(2, "0");
    const m = String(Math.floor((elapsedSec % 3600) / 60)).padStart(2, "0");
    const s = String(elapsedSec % 60).padStart(2, "0");
    const plannedSec = session.plannedDurationMin * 60;
    const progressPct = plannedSec > 0 ? Math.min(100, Math.round((elapsedSec / plannedSec) * 100)) : 0;
    return (
      <div className="p-4 space-y-5">
        <div className="rounded-xl border border-border bg-surface-2/50 p-5 text-center">
          <div className="text-xs text-muted mb-1">Recording</div>
          <div className="text-4xl font-bold tabular-nums">
            {h}:{m}:{s}
          </div>
          <div className="text-xs text-muted mt-1">
            {progressPct}% of planned {session.plannedDurationMin}m
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <MiniStat icon={Store} label="Business" value={business?.name ?? "—"} tone="default" />
          <MiniStat icon={Cpu} label="Rig" value={rig?.code ?? "No rig"} tone="default" />
        </div>
        {rigSummary && rigSummary.openIncidents.length > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-warning/25 bg-warning-bg px-3 py-2.5 text-sm text-warning">
            <AlertTriangle className="size-4 shrink-0" />
            {rigSummary.openIncidents.length} open rig issue{rigSummary.openIncidents.length === 1 ? "" : "s"} on {rig?.code}
          </div>
        )}
        <EvidenceProgress assignment={assignment} />
        <Button variant="secondary" className="w-full h-12" onClick={() => setIssueOpen(true)}>
          <AlertTriangle className="size-4" /> Report Issue
        </Button>
        <Button size="lg" variant="destructive" className="w-full h-14 text-base" onClick={() => setPostCheckOpen(true)}>
          <StopCircle className="size-5" /> End Session
        </Button>
        <IssueFormDialog
          open={issueOpen}
          onOpenChange={setIssueOpen}
          defaults={{ businessId: assignment.businessId, foId: assignment.foId, rigId: assignment.rigId, sessionId: session.id, assignmentId: assignment.id }}
        />
        <PostSessionCheckDialog open={postCheckOpen} onOpenChange={setPostCheckOpen} session={session} />
      </div>
    );
  }

  // session ended, assignment not yet marked completed (edge case) — show completion confirmation
  if (!session) {
    return <div className="p-8 text-center text-sm text-muted">In progress…</div>;
  }
  return (
    <div className="p-4 space-y-4">
      <Section title="COMPLETE VISIT">
        <div className="space-y-2 text-sm">
          <CompletionRow label="Evidence" done={!!session.checklistSetup?.capturedEvidence} />
          <CompletionRow label="Duration" done={!!session.endedAt} />
          <CompletionRow label="End time" done={!!session.endedAt} />
        </div>
        <Textarea placeholder="Notes (optional)" className="mt-3" rows={3} />
      </Section>
      <Button size="lg" className="w-full h-14 text-base" onClick={() => setPostCheckOpen(true)}>
        <CheckCircle2 className="size-5" /> Complete Visit
      </Button>
      <PostSessionCheckDialog open={postCheckOpen} onOpenChange={setPostCheckOpen} session={session} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-semibold text-muted mb-2 tracking-wide">{title}</div>
      {children}
    </div>
  );
}

function MiniStat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone: "default" | "critical" | "warning";
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted mb-1">
        <Icon className="size-3.5" /> {label}
      </div>
      <div className={cn("text-lg font-semibold tabular-nums", tone === "critical" ? "text-critical" : tone === "warning" ? "text-warning" : "text-foreground")}>
        {value}
      </div>
    </div>
  );
}

function CompletionRow({ label, done }: { label: string; done: boolean }) {
  return (
    <div className="flex items-center gap-2">
      {done ? <CheckCircle2 className="size-4 text-success" /> : <Circle className="size-4 text-muted-2" />}
      {label}
    </div>
  );
}

function SessionsTab({ foId }: { foId: string }) {
  const data = useCity();
  const bizMap = new Map(data.businesses.map((b) => [b.id, b]));
  const sessions = useMemo(
    () => data.sessions.filter((s) => s.foId === foId).sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()),
    [data.sessions, foId],
  );
  if (sessions.length === 0) return <div className="p-8 text-center text-sm text-muted">No sessions recorded yet.</div>;
  return (
    <div className="p-3 space-y-2">
      {sessions.map((s) => {
        const biz = bizMap.get(s.businessId);
        const hours = s.endedAt ? (new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 3_600_000 : null;
        return (
          <div key={s.id} className="rounded-lg border border-border bg-surface p-3.5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">{biz?.name ?? "Unknown business"}</span>
              <StatusBadge status={s.status === "active" ? "active" : s.status === "completed" ? "completed" : "pending"} />
            </div>
            <div className="text-xs text-muted mt-1 flex items-center gap-2">
              <span>{fmtDate(s.date)}</span>
              <span>·</span>
              <span>{fmtTime(s.startedAt)}</span>
              {hours !== null && (
                <>
                  <span>·</span>
                  <span>{fmtHours(hours)} recorded</span>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function IssuesTab({ foId }: { foId: string }) {
  const data = useCity();
  const resolveIssue = useCity((s) => s.resolveIssue);
  const issues = useMemo(
    () => data.issues.filter((i) => i.foId === foId).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [data.issues, foId],
  );
  const open = issues.filter((i) => i.status !== "resolved" && i.status !== "cancelled");
  const resolved = issues.filter((i) => i.status === "resolved" || i.status === "cancelled");
  if (issues.length === 0) return <div className="p-8 text-center text-sm text-muted">No issues reported. You're all clear.</div>;
  return (
    <div className="p-3 space-y-4">
      {open.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold text-muted px-1">OPEN ({open.length})</div>
          {open.map((i) => (
            <div key={i.id} className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{i.title}</span>
                <StatusBadge status={i.severity === "critical" ? "critical" : "warning"} />
              </div>
              <div className="text-xs text-muted mt-1">{i.description}</div>
              {/* FOs can resolve their own non-rig issues (e.g. a late-arrival
                  note) — rig issues always go through the repair lifecycle,
                  never a one-tap dismiss, to keep Rig Guardian's integrity. */}
              {!i.rigId && (
                <button
                  onClick={() => resolveIssue(i.id, "Resolved by field officer.")}
                  className="text-xs text-primary mt-2 hover:underline"
                >
                  Mark resolved
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {resolved.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold text-muted px-1">RESOLVED ({resolved.length})</div>
          {resolved.map((i) => (
            <div key={i.id} className="rounded-lg border border-border p-3 opacity-60">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{i.title}</span>
                <StatusBadge status="completed" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProfileTab({ foId, isPreview }: { foId: string; isPreview: boolean }) {
  const data = useCity();
  const fo = data.fos.find((f) => f.id === foId)!;
  const { user, isDemoMode, logout } = useAuth();
  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary font-semibold text-lg">
          {fo.name.split(" ").map((p) => p[0]).join("").slice(0, 2)}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <div className="text-base font-semibold">{fo.name}</div>
            <span className="rounded-full bg-primary/10 text-primary text-[10px] font-medium px-2 py-0.5">
              Field Officer
            </span>
          </div>
          <div className="text-xs text-muted">{fo.homeArea}</div>
        </div>
      </div>
      <div className="text-xs text-muted">{fo.phone}</div>

      <div className="rounded-lg border border-border p-3 text-xs text-muted space-y-1">
        <div className="flex items-center justify-between">
          <span>Signed in as</span>
          <span className="text-foreground">{user?.email ?? "—"}</span>
        </div>
        <div className="flex items-center justify-between">
          <span>Role</span>
          <span className="text-foreground">Field Officer</span>
        </div>
        <div className="flex items-center justify-between">
          <span>Mode</span>
          <span className="text-foreground">{isDemoMode ? "Demo (this device only)" : "Production"}</span>
        </div>
      </div>

      {!isPreview && (
        <Button variant="secondary" className="w-full" onClick={() => logout()}>
          <LogOut className="size-4" /> Sign out
        </Button>
      )}
    </div>
  );
}
