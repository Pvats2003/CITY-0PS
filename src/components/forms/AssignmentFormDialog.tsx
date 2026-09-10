import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCity } from "@/store/city";
import { buildRigSummary, isDeployable, proposeRigReplacement } from "@/engine/rigGuardian";
import { RIG_READINESS_EMOJI } from "@/engine/rigTaxonomy";
import { overlaps } from "@/engine/selectors";
import { id } from "@/lib/id";
import { isoAtTime, nowISO } from "@/lib/dates";
import type { Assignment } from "@/types";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Fixed — an assignment's date always matches the plan/day it belongs
   * to, never separately editable here (spec: "assignment date must match
   * plan date"). */
  date: string;
  /** The set of assignments to check for FO/rig double-booking against —
   * the caller's choice of live `data.assignments` or a draft plan's
   * in-progress array, so this dialog works identically for both "assign
   * something today" and "add another rig to tomorrow's draft." */
  existingAssignments: Assignment[];
  defaults?: { foId?: string; businessId?: string; rigId?: string; plannedStart?: string; plannedEnd?: string };
  /** Never writes to the store itself — the caller decides whether this
   * becomes a live Assignment (addAssignment) or another row in a draft
   * plan's array. Keeps this dialog usable from both contexts without
   * assuming which one it's in. */
  onCreate: (assignment: Assignment) => void;
}

const DEFAULT_START = "10:00";
const DEFAULT_END = "14:00";

function hhmmFromISO(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function AssignmentFormDialog({ open, onOpenChange, date, existingAssignments, defaults, onCreate }: Props) {
  const data = useCity();
  const [foId, setFoId] = useState(defaults?.foId ?? "");
  const [businessId, setBusinessId] = useState(defaults?.businessId ?? "");
  const [rigId, setRigId] = useState(defaults?.rigId ?? "");
  const [startTime, setStartTime] = useState(hhmmFromISO(defaults?.plannedStart) || DEFAULT_START);
  const [endTime, setEndTime] = useState(hhmmFromISO(defaults?.plannedEnd) || DEFAULT_END);
  const [error, setError] = useState<string | null>(null);
  // In-flight guard against rapid repeated clicks on "Add assignment"
  // before the dialog visibly closes. A ref (checked synchronously, at
  // the very top of submit()) is the actual re-entrancy guard — React's
  // `disabled` prop update is a state change that only takes effect after
  // the next render, which is too late to stop a second click event that
  // fires before that render happens. `submitting` mirrors it purely for
  // the visible disabled styling. This is defense-in-depth alongside the
  // real fix: store/city.ts's addAssignment()/approvePlan() are
  // idempotent by the assignment's logical identity, so even without this
  // guard a duplicate submission can no longer create a second Firestore
  // document — but disabling the button is still the right UX, and closes
  // the window entirely rather than relying on the data layer alone.
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFoId(defaults?.foId ?? "");
    setBusinessId(defaults?.businessId ?? "");
    setRigId(defaults?.rigId ?? "");
    setStartTime(hhmmFromISO(defaults?.plannedStart) || DEFAULT_START);
    setEndTime(hhmmFromISO(defaults?.plannedEnd) || DEFAULT_END);
    setError(null);
    submittingRef.current = false;
    setSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const rigSummaries = useMemo(
    () =>
      data.rigs
        .filter((r) => r.deploymentStatus !== "retired")
        .map((r) => buildRigSummary(data, r))
        .sort((a, b) => b.score - a.score),
    [data],
  );
  const selectedRigSummary = rigId ? rigSummaries.find((s) => s.rig.id === rigId) : undefined;
  const rigHardBlocked = selectedRigSummary ? !isDeployable(selectedRigSummary.readiness) : false;
  const rigNeedsSoftWarning = selectedRigSummary ? isDeployable(selectedRigSummary.readiness) && selectedRigSummary.readiness !== "healthy" : false;

  const plannedStart = date && startTime ? isoAtTime(date, startTime) : "";
  const plannedEnd = date && endTime ? isoAtTime(date, endTime) : "";

  const replacement =
    selectedRigSummary && (rigHardBlocked || rigNeedsSoftWarning) && plannedStart && plannedEnd
      ? proposeRigReplacement(data, date, selectedRigSummary.rig.id, plannedStart, plannedEnd)
      : null;

  function submit() {
    if (submittingRef.current) return;
    if (!foId) return setError("Select a Field Officer.");
    if (!businessId) return setError("Select a business.");
    if (!startTime || !endTime) return setError("Set a start and end time.");
    if (new Date(plannedEnd).getTime() <= new Date(plannedStart).getTime()) return setError("End time must be after start time.");

    const fo = data.fos.find((f) => f.id === foId);
    if (!fo?.active) return setError("This Field Officer is not active.");
    if (fo.unavailableDates?.includes(date)) return setError(`${fo.name} is marked unavailable on ${date}.`);

    const biz = data.businesses.find((b) => b.id === businessId);
    if (!biz?.active) return setError("This business is not active.");
    if (biz.unavailableDates?.includes(date)) return setError(`${biz.name} is marked unavailable on ${date}.`);

    if (rigId && rigHardBlocked) {
      return setError(
        `${selectedRigSummary!.rig.code} is not ready (${selectedRigSummary!.readinessReason}). ` +
          (replacement ? `Use ${replacement.rig.code} instead, or pick another rig.` : "Pick another rig."),
      );
    }

    const active = existingAssignments.filter((a) => a.status !== "cancelled" && a.status !== "rejected");
    const foConflict = active.find((a) => a.foId === foId && overlaps(a.plannedStart, a.plannedEnd, plannedStart, plannedEnd));
    if (foConflict) return setError(`${fo.name} already has an overlapping assignment at this time.`);
    if (rigId) {
      const rigConflict = active.find((a) => a.rigId === rigId && overlaps(a.plannedStart, a.plannedEnd, plannedStart, plannedEnd));
      if (rigConflict) return setError(`${selectedRigSummary!.rig.code} is already assigned to another visit at this time.`);
    }

    const assignment: Assignment = {
      id: id("asg"),
      date,
      businessId,
      foId,
      // Omit the key entirely when no rig is selected — `rigId: undefined`
      // would be a real enumerable property, and Firestore's setDoc()
      // rejects any document containing one client-side (no network call
      // even attempted) unless ignoreUndefinedProperties is set, which it
      // deliberately isn't (see src/auth/firebaseApp.ts) so malformed data
      // fails loudly instead of being silently coerced.
      ...(rigId ? { rigId } : {}),
      plannedStart,
      plannedEnd,
      priority: "normal",
      status: "planned",
      createdAt: nowISO(),
    };
    submittingRef.current = true;
    setSubmitting(true);
    onCreate(assignment);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Assign a rig</DialogTitle>
          <DialogDescription>Adds one assignment — an FO can have any number of these for the same day.</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Field Officer</Label>
            <Select value={foId || "none"} onValueChange={(v) => setFoId(v === "none" ? "" : v)}>
              <SelectTrigger>
                <SelectValue placeholder="Select FO" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" disabled>
                  Select FO
                </SelectItem>
                {data.fos.filter((f) => f.active).map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Business</Label>
            <Select value={businessId || "none"} onValueChange={(v) => setBusinessId(v === "none" ? "" : v)}>
              <SelectTrigger>
                <SelectValue placeholder="Select business" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" disabled>
                  Select business
                </SelectItem>
                {data.businesses.filter((b) => b.active).map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label>Rig</Label>
            <Select value={rigId || "none"} onValueChange={(v) => setRigId(v === "none" ? "" : v)}>
              <SelectTrigger>
                <SelectValue placeholder="No rig" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No rig</SelectItem>
                {rigSummaries.map((s) => (
                  <SelectItem key={s.rig.id} value={s.rig.id}>
                    {RIG_READINESS_EMOJI[s.readiness]} {s.rig.code} {s.readiness === "healthy" ? "· Ready" : `· ${s.score}/100`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="asg-start">Start</Label>
            <Input id="asg-start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="asg-end">End</Label>
            <Input id="asg-end" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </div>
        </div>

        {(rigHardBlocked || rigNeedsSoftWarning) && selectedRigSummary && (
          <div className="flex items-start gap-2 rounded-md border border-warning/25 bg-warning-bg px-3 py-2.5 text-sm text-warning">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div>
              <div className="font-medium">
                {selectedRigSummary.rig.code} is currently {rigHardBlocked ? "not ready" : "not fully healthy"}.
              </div>
              <div className="text-xs mt-0.5">Reason: {selectedRigSummary.readinessReason}</div>
              {replacement && (
                <div className="text-xs mt-0.5">
                  AI recommendation: use {replacement.rig.code} instead ({replacement.reasons.join(", ")}).
                </div>
              )}
              {rigHardBlocked && <div className="text-xs mt-1 font-medium">This rig cannot be assigned until it's back in service.</div>}
            </div>
          </div>
        )}

        {error && <div className="text-sm text-critical bg-critical-bg border border-critical/20 rounded-md px-3 py-2">{error}</div>}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            Add assignment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
