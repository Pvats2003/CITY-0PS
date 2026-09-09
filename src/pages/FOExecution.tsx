import { useEffect, useMemo, useState } from "react";
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
  Battery,
  HardDrive,
  Wifi,
  AlertTriangle,
  PlayCircle,
  StopCircle,
  ShieldAlert,
  LogOut,
  WifiOff,
  RefreshCw,
} from "lucide-react";
import { useCity } from "@/store/city";
import { todayISO, fmtTime, fmtDate, fmtHours } from "@/lib/dates";
import { checkInAssignment, startSessionForAssignment, logRigPreflightPassed } from "@/engine/workflows";
import { buildRigSummary, isDeployable } from "@/engine/rigGuardian";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/status";
import { cn } from "@/lib/utils";
import { IssueFormDialog } from "@/components/forms/IssueFormDialog";
import { RigIncidentFormDialog } from "@/components/forms/RigIncidentFormDialog";
import { PostSessionCheckDialog } from "@/components/forms/PostSessionCheckDialog";
import { useAuth } from "@/auth/AuthContext";
import { useSyncStatus } from "@/data/useSyncStatus";
import { useCollectionSyncStatus } from "@/data/useCollectionSyncStatus";
import { FoDiagnosticPanel } from "@/components/FoDiagnosticPanel";
import type { Assignment } from "@/types";

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
    console.log(
      "[CITY-OPS-DIAG] FO_STATE",
      "auth=", user ? "authed" : "unauthed",
      "profile=", user ? "present" : "missing",
      "role=", user?.role ?? null,
      "foId=", JSON.stringify(user?.foId ?? null),
      "fosSync=", fosSync.status,
      "fosCount=", data.fos.length,
      "matchedFo=", fo?.id ?? null,
      "syncError=", fosSync.error ?? null,
      "screen=", screen,
    );
  }, [fo, params.id, id, user, data.fos, fosSync.status, fosSync.hasSyncedOnce, fosSync.error, screen]);

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
          <FoDiagnosticPanel requestedFoId={id} matchedFoId={null} matchedFoName={null} fosCount={data.fos.length} fosSync={fosSync} screen={screen} />
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
          <FoDiagnosticPanel
            requestedFoId={id}
            matchedFoId={null}
            matchedFoName={null}
            fosCount={data.fos.length}
            fosSync={fosSync}
            screen={screen}
          />
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
          <FoDiagnosticPanel
            requestedFoId={id}
            matchedFoId={null}
            matchedFoName={null}
            fosCount={data.fos.length}
            fosSync={fosSync}
            screen={screen}
          />
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
        <FoDiagnosticPanel
          requestedFoId={id}
          matchedFoId={null}
          matchedFoName={null}
          fosCount={data.fos.length}
          fosSync={fosSync}
          screen={screen}
        />
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

  if (assignments.length === 0) {
    return <div className="p-8 text-center text-sm text-muted">No visits scheduled today.</div>;
  }

  return (
    <div className="p-3 space-y-2.5">
      {assignments.map((a) => {
        const biz = bizMap.get(a.businessId);
        const done = a.status === "completed";
        const active = a.status === "in_progress";
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
              </div>
            </button>
            {biz?.lat && biz?.lng && (
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${biz.lat},${biz.lng}`}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="flex items-center justify-center rounded-lg border border-border bg-surface px-3 text-primary shrink-0"
                title="Navigate"
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

function ExecutionFlow({ assignment }: { assignment: Assignment }) {
  const data = useCity();
  const business = data.businesses.find((b) => b.id === assignment.businessId);
  const rig = data.rigs.find((r) => r.id === assignment.rigId);
  const rigSummary = rig ? buildRigSummary(data, rig) : null;
  const session = data.sessions.find((s) => s.id === assignment.sessionId && s.status !== "completed") ?? (assignment.sessionId ? data.sessions.find((s) => s.id === assignment.sessionId) : undefined);
  const [checklist, setChecklist] = useState({
    confirmedBusiness: false,
    scannedRig: false,
    checkedBattery: false,
    checkedStorage: false,
    confirmedCollector: false,
    capturedEvidence: false,
  });
  const [issueOpen, setIssueOpen] = useState(false);
  const [preflightIssueOpen, setPreflightIssueOpen] = useState(false);
  const [postCheckOpen, setPostCheckOpen] = useState(false);

  if (assignment.status === "completed") {
    return (
      <div className="p-6 text-center space-y-2">
        <CheckCircle2 className="size-10 text-success mx-auto" />
        <div className="text-base font-semibold">Visit completed</div>
        <div className="text-sm text-muted">{business?.name} — nice work.</div>
      </div>
    );
  }

  if (!assignment.actualArrivalAt) {
    return (
      <div className="p-4 space-y-4">
        <Section title="ARRIVAL">
          <div className="text-sm text-muted">
            {fmtTime(assignment.plannedStart)} · {business?.area}
          </div>
          {business?.lat && business?.lng && (
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${business.lat},${business.lng}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-primary mt-2"
            >
              <Navigation2 className="size-4" /> Navigate
            </a>
          )}
        </Section>
        <Button size="lg" className="w-full h-14 text-base" onClick={() => checkInAssignment(assignment)}>
          Check In
        </Button>
      </div>
    );
  }

  if (!session) {
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

    const items: { key: keyof typeof checklist; label: string }[] = [
      { key: "confirmedBusiness", label: "Confirm business" },
      { key: "scannedRig", label: "30-second rig preflight (power, cameras, cables, storage)" },
      { key: "checkedBattery", label: "Check battery" },
      { key: "checkedStorage", label: "Check storage" },
      { key: "confirmedCollector", label: "Confirm collector" },
      { key: "capturedEvidence", label: "Capture evidence" },
    ];
    const allDone = items.every((i) => checklist[i.key]);
    return (
      <div className="p-4 space-y-4">
        <Section title="RIG PREFLIGHT">
          <div className="space-y-2.5">
            {items.map((i) => (
              <label key={i.key} className="flex items-center gap-3 py-1">
                <Checkbox checked={checklist[i.key]} onCheckedChange={(v) => setChecklist((c) => ({ ...c, [i.key]: !!v }))} />
                <span className="text-sm">{i.label}</span>
              </label>
            ))}
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
          disabled={!allDone}
          onClick={() => {
            if (rig) logRigPreflightPassed(rig.id);
            startSessionForAssignment(assignment, checklist);
          }}
        >
          <PlayCircle className="size-5" /> Start Session
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

  if (session.status === "active") {
    const elapsedSec = Math.max(0, Math.floor((Date.now() - new Date(session.startedAt).getTime()) / 1000));
    const h = String(Math.floor(elapsedSec / 3600)).padStart(2, "0");
    const m = String(Math.floor((elapsedSec % 3600) / 60)).padStart(2, "0");
    const s = String(elapsedSec % 60).padStart(2, "0");
    return (
      <div className="p-4 space-y-5">
        <div className="rounded-xl border border-border bg-surface-2/50 p-5 text-center">
          <div className="text-xs text-muted mb-1">Recording</div>
          <div className="text-4xl font-bold tabular-nums">
            {h}:{m}:{s}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <MiniStat icon={Battery} label="Battery" value={`${session.batteryPct}%`} tone={session.batteryPct < 30 ? "critical" : "default"} />
          <MiniStat icon={HardDrive} label="Storage" value={`${session.storagePct}%`} tone={session.storagePct > 85 ? "warning" : "default"} />
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2.5">
          <Wifi className={cn("size-4", session.signal === "healthy" ? "text-success" : "text-warning")} />
          <span className="text-sm">Status: {session.signal === "healthy" ? "Healthy" : "Signal intermittent"}</span>
        </div>
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
