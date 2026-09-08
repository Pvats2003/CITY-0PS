import { useEffect, useMemo, useState } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import {
  ChevronLeft,
  MapPin,
  Navigation2,
  CalendarClock,
  Map as MapIcon,
  ScanLine,
  Bell,
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
} from "lucide-react";
import { useCity } from "@/store/city";
import { todayISO, fmtTime } from "@/lib/dates";
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
import type { Assignment } from "@/types";

type BottomTab = "today" | "map" | "scan" | "alerts" | "profile";

export default function FOExecution() {
  const { id } = useParams();
  const data = useCity();
  const fo = data.fos.find((f) => f.id === id);
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

  if (!fo) return <Navigate to="/field-officers" replace />;

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
        <Link to={`/field-officers/${fo.id}`} className="text-xs text-primary shrink-0">
          Desktop
        </Link>
      </header>

      <main className="flex-1 overflow-y-auto pb-2">
        {tab === "today" && (
          selectedAssignment ? (
            <ExecutionFlow assignment={selectedAssignment} />
          ) : (
            <TodayList assignments={today} onSelect={setSelected} />
          )
        )}
        {tab === "map" && <MapTab assignments={today} />}
        {tab === "scan" && <ScanTab />}
        {tab === "alerts" && <AlertsTab foId={fo.id} />}
        {tab === "profile" && <ProfileTab foId={fo.id} />}
      </main>

      <nav className="grid grid-cols-5 border-t border-border shrink-0 bg-surface">
        <BottomNavItem icon={CalendarClock} label="Today" active={tab === "today"} onClick={() => { setTab("today"); }} />
        <BottomNavItem icon={MapIcon} label="Map" active={tab === "map"} onClick={() => setTab("map")} />
        <BottomNavItem icon={ScanLine} label="Scan" active={tab === "scan"} onClick={() => setTab("scan")} />
        <BottomNavItem icon={Bell} label="Alerts" active={tab === "alerts"} onClick={() => setTab("alerts")} />
        <BottomNavItem icon={UserRound} label="Profile" active={tab === "profile"} onClick={() => setTab("profile")} />
      </nav>
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
          <button
            key={a.id}
            onClick={() => onSelect(a.id)}
            className="w-full text-left rounded-lg border border-border bg-surface p-3.5 active:scale-[0.99] transition-transform"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted tabular-nums">{fmtTime(a.plannedStart)}</span>
              <StatusBadge status={done ? "completed" : active ? "active" : "pending"} />
            </div>
            <div className="text-base font-semibold mt-1">{biz?.name}</div>
            <div className="text-xs text-muted flex items-center gap-1 mt-0.5">
              <MapPin className="size-3.5" /> {biz?.area}
            </div>
          </button>
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

function MapTab({ assignments }: { assignments: Assignment[] }) {
  const data = useCity();
  const bizMap = new Map(data.businesses.map((b) => [b.id, b]));
  return (
    <div className="p-3 space-y-2">
      <div className="text-xs text-muted px-1 pb-1">No map API required — open any stop directly in your maps app.</div>
      {assignments.map((a) => {
        const biz = bizMap.get(a.businessId);
        return (
          <div key={a.id} className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <div className="text-sm font-medium">{biz?.name}</div>
              <div className="text-xs text-muted">{biz?.address}</div>
            </div>
            {biz?.lat && biz?.lng && (
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${biz.lat},${biz.lng}`}
                target="_blank"
                rel="noreferrer"
                className="text-primary shrink-0"
              >
                <Navigation2 className="size-5" />
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ScanTab() {
  return (
    <div className="p-8 text-center space-y-3">
      <ScanLine className="size-12 text-muted mx-auto" />
      <div className="text-sm text-muted">Rig scanning happens as part of the Setup checklist for each visit — open a visit from Today to scan in.</div>
    </div>
  );
}

function AlertsTab({ foId }: { foId: string }) {
  const data = useCity();
  const issues = data.issues.filter((i) => i.foId === foId && i.status !== "resolved" && i.status !== "cancelled");
  if (issues.length === 0) return <div className="p-8 text-center text-sm text-muted">No alerts. You're all clear.</div>;
  return (
    <div className="p-3 space-y-2">
      {issues.map((i) => (
        <div key={i.id} className="rounded-lg border border-border p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{i.title}</span>
            <StatusBadge status={i.severity === "critical" ? "critical" : "warning"} />
          </div>
          <div className="text-xs text-muted mt-1">{i.description}</div>
        </div>
      ))}
    </div>
  );
}

function ProfileTab({ foId }: { foId: string }) {
  const data = useCity();
  const fo = data.fos.find((f) => f.id === foId)!;
  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-3">
        <div className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary font-semibold text-lg">
          {fo.name.split(" ").map((p) => p[0]).join("").slice(0, 2)}
        </div>
        <div>
          <div className="text-base font-semibold">{fo.name}</div>
          <div className="text-xs text-muted">{fo.homeArea}</div>
        </div>
      </div>
      <div className="text-xs text-muted">{fo.phone}</div>
    </div>
  );
}
