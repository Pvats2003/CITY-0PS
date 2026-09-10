import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { id } from "@/lib/id";
import { nowISO } from "@/lib/dates";
import { omitUndefined } from "@/lib/omitUndefined";
import { deriveAssignmentId } from "@/lib/assignmentIdentity";
import type {
  CityData,
  Business,
  FieldOfficer,
  Collector,
  Rig,
  Assignment,
  Session,
  Evidence,
  Issue,
  QualityReview,
  CorrectiveAction,
  RigIncident,
  RepairRecord,
  ActivityEvent,
  DailyPlan,
  DailyReport,
  CitySettings,
} from "@/types";

export const STORAGE_KEY = "city-ops-os";
// Bumped for Rig Guardian: Rig/RigIncident/RepairRecord shapes changed
// (dropped `condition`, added deploymentStatus + incident/repair tracking).
// Older persisted state is incompatible, so it's discarded on load rather
// than risk the new engine crashing on missing fields.
export const DATA_VERSION = 2;

export const DEFAULT_SETTINGS: CitySettings = {
  cityName: "My City",
  workingHoursStart: "08:00",
  workingHoursEnd: "19:00",
  defaultSessionDurationMin: 120,
  recordingHoursTargetPerDay: 10,
  theme: "dark",
  onboarded: false,
};

export function emptyCityData(): CityData {
  return {
    version: DATA_VERSION,
    settings: { ...DEFAULT_SETTINGS },
    businesses: [],
    fos: [],
    collectors: [],
    rigs: [],
    assignments: [],
    sessions: [],
    evidence: [],
    issues: [],
    qualityReviews: [],
    correctiveActions: [],
    rigIncidents: [],
    repairRecords: [],
    activity: [],
    plans: [],
    reports: [],
  };
}

interface CityActions {
  // settings / lifecycle
  updateSettings: (patch: Partial<CitySettings>) => void;
  loadData: (data: CityData) => void;
  clearAllData: () => void;
  /** Sync engine only (src/data/syncEngine.ts) — replaces one collection
   * wholesale with the backend's current document set. Not for UI use. */
  mergeRemoteCollection: (collection: keyof CityData, docs: unknown[]) => void;

  // activity log
  logActivity: (e: Omit<ActivityEvent, "id" | "at"> & { at?: string }) => void;

  // business
  addBusiness: (b: Omit<Business, "id" | "createdAt">) => Business;
  updateBusiness: (id: string, patch: Partial<Business>) => void;
  removeBusiness: (id: string) => void;

  // FO
  addFO: (f: Omit<FieldOfficer, "id" | "createdAt">) => FieldOfficer;
  updateFO: (id: string, patch: Partial<FieldOfficer>) => void;
  removeFO: (id: string) => void;

  // collector
  addCollector: (c: Omit<Collector, "id" | "createdAt">) => Collector;
  updateCollector: (id: string, patch: Partial<Collector>) => void;

  // rig
  addRig: (r: Omit<Rig, "id" | "createdAt">) => Rig;
  updateRig: (id: string, patch: Partial<Rig>) => void;

  // rig incidents / repairs (Rig Guardian)
  addRigIncident: (i: Omit<RigIncident, "id" | "createdAt">) => RigIncident;
  updateRigIncident: (id: string, patch: Partial<RigIncident>) => void;
  addRepairRecord: (r: Omit<RepairRecord, "id" | "createdAt">) => RepairRecord;
  updateRepairRecord: (id: string, patch: Partial<RepairRecord>) => void;

  // assignment
  addAssignment: (a: Omit<Assignment, "id" | "createdAt">) => Assignment;
  updateAssignment: (id: string, patch: Partial<Assignment>) => void;
  removeAssignment: (id: string) => void;

  // session
  addSession: (s: Omit<Session, "id" | "createdAt">) => Session;
  updateSession: (id: string, patch: Partial<Session>) => void;

  // evidence
  addEvidence: (e: Omit<Evidence, "id" | "createdAt">) => Evidence;
  updateEvidence: (id: string, patch: Partial<Evidence>) => void;

  // issues
  addIssue: (i: Omit<Issue, "id" | "createdAt">) => Issue;
  updateIssue: (id: string, patch: Partial<Issue>) => void;
  resolveIssue: (id: string, resolution: string) => void;

  // quality
  addQualityReview: (q: Omit<QualityReview, "id" | "createdAt">) => QualityReview;
  updateQualityReview: (id: string, patch: Partial<QualityReview>) => void;
  addCorrectiveAction: (c: Omit<CorrectiveAction, "id" | "createdAt">) => CorrectiveAction;
  updateCorrectiveAction: (id: string, patch: Partial<CorrectiveAction>) => void;

  // plans
  addPlan: (p: Omit<DailyPlan, "id" | "createdAt">) => DailyPlan;
  updatePlan: (id: string, patch: Partial<DailyPlan>) => void;
  /** The ONLY action that turns a plan's draftAssignments into real,
   * FO-visible Assignment records — the draft -> approved boundary the
   * product principle requires a deliberate Manager action to cross. A
   * no-op if the plan has no draftAssignments (already approved, or
   * doesn't exist). Preserves each draft assignment's id verbatim, so
   * conflict/recommendation references created against the draft remain
   * valid after approval. */
  approvePlan: (planId: string, approvedBy?: string) => void;

  // reports
  addReport: (r: Omit<DailyReport, "id" | "generatedAt">) => DailyReport;
}

export type CityStore = CityData & CityActions;

export const useCity = create<CityStore>()(
  persist(
    immer((set, get) => ({
      ...emptyCityData(),

      updateSettings: (patch) =>
        set((s) => {
          Object.assign(s.settings, patch);
        }),

      loadData: (data) =>
        set((s) => {
          Object.assign(s, data);
        }),

      clearAllData: () =>
        set((s) => {
          Object.assign(s, emptyCityData());
        }),

      mergeRemoteCollection: (collection, docs) =>
        set((s) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (s as any)[collection] = docs;
        }),

      // omitUndefined: logActivity is called from dozens of sites across
      // the app, many passing an optional field (businessId, foId, rigId,
      // sessionId, issueId, detail, ...) that's frequently absent —
      // Firestore's setDoc() rejects an explicit undefined value, so it
      // must be stripped once, centrally, here (src/lib/omitUndefined.ts),
      // rather than at every individual call site.
      logActivity: (e) =>
        set((s) => {
          s.activity.unshift(omitUndefined({ id: id("act"), at: e.at ?? nowISO(), ...e }));
          if (s.activity.length > 2000) s.activity.length = 2000;
        }),

      addBusiness: (b) => {
        const item: Business = { ...b, id: id("biz"), createdAt: nowISO() };
        set((s) => {
          s.businesses.push(item);
        });
        get().logActivity({
          type: "note",
          entityKind: "business",
          entityId: item.id,
          businessId: item.id,
          summary: `${item.name} added to city`,
        });
        return item;
      },
      updateBusiness: (bid, patch) =>
        set((s) => {
          const b = s.businesses.find((x) => x.id === bid);
          if (b) Object.assign(b, patch);
        }),
      removeBusiness: (bid) =>
        set((s) => {
          s.businesses = s.businesses.filter((x) => x.id !== bid);
        }),

      addFO: (f) => {
        const item: FieldOfficer = { ...f, id: id("fo"), createdAt: nowISO() };
        set((s) => {
          s.fos.push(item);
        });
        return item;
      },
      updateFO: (fid, patch) =>
        set((s) => {
          const f = s.fos.find((x) => x.id === fid);
          if (f) Object.assign(f, patch);
        }),
      removeFO: (fid) =>
        set((s) => {
          s.fos = s.fos.filter((x) => x.id !== fid);
        }),

      addCollector: (c) => {
        const item: Collector = { ...c, id: id("col"), createdAt: nowISO() };
        set((s) => {
          s.collectors.push(item);
        });
        return item;
      },
      updateCollector: (cid, patch) =>
        set((s) => {
          const c = s.collectors.find((x) => x.id === cid);
          if (c) Object.assign(c, patch);
        }),

      addRig: (r) => {
        const item: Rig = { ...r, id: id("rig"), createdAt: nowISO() };
        set((s) => {
          s.rigs.push(item);
        });
        return item;
      },
      updateRig: (rid, patch) =>
        set((s) => {
          const r = s.rigs.find((x) => x.id === rid);
          if (r) Object.assign(r, patch);
        }),

      addRigIncident: (i) => {
        const item: RigIncident = { ...i, id: id("rin"), createdAt: nowISO() };
        set((s) => {
          s.rigIncidents.push(item);
        });
        return item;
      },
      updateRigIncident: (rid, patch) =>
        set((s) => {
          const r = s.rigIncidents.find((x) => x.id === rid);
          if (r) Object.assign(r, patch);
        }),
      addRepairRecord: (r) => {
        const item: RepairRecord = { ...r, id: id("rep_rec"), createdAt: nowISO() };
        set((s) => {
          s.repairRecords.push(item);
        });
        return item;
      },
      updateRepairRecord: (rrid, patch) =>
        set((s) => {
          const r = s.repairRecords.find((x) => x.id === rrid);
          if (r) Object.assign(r, patch);
        }),

      // Idempotent by construction: the persisted id is a DETERMINISTIC
      // function of the assignment's logical identity (businessId, foId,
      // date, plannedStart, plannedEnd, rigId — see
      // src/lib/assignmentIdentity.ts), never a fresh random id(). A
      // repeated call for the same logical visit (a rapid double-click, a
      // retry after an earlier attempt looked like it failed, two tabs
      // racing) always computes the SAME id and, finding it already
      // present, is a no-op — it does NOT overwrite the existing record,
      // so any real progress since creation (status, actualArrivalAt,
      // sessionId, ...) is never clobbered by a stale resubmission. This
      // is what fixed the production bug where the same manual "Add
      // assignment" request, retried across this session's testing, had
      // created 3 separate Firestore documents for one visit — every
      // existing random `asg_*` id from before this fix keeps working
      // unchanged, since lookups/updates only ever operate on whatever id
      // a record carries.
      addAssignment: (a) => {
        const assignmentId = deriveAssignmentId(a);
        let created = false;
        let result: Assignment | undefined;
        set((s) => {
          const existing = s.assignments.find((x) => x.id === assignmentId);
          if (existing) {
            result = existing;
            return;
          }
          const item: Assignment = { ...a, id: assignmentId, createdAt: nowISO() };
          s.assignments.push(item);
          result = item;
          created = true;
        });
        if (created && result) {
          get().logActivity({
            type: "assignment_created",
            entityKind: "assignment",
            entityId: result.id,
            businessId: result.businessId,
            foId: result.foId,
            summary: `Assignment created`,
          });
        }
        return result!;
      },
      updateAssignment: (aid, patch) =>
        set((s) => {
          const a = s.assignments.find((x) => x.id === aid);
          if (a) Object.assign(a, patch);
        }),
      removeAssignment: (aid) =>
        set((s) => {
          s.assignments = s.assignments.filter((x) => x.id !== aid);
        }),

      addSession: (sess) => {
        const item: Session = { ...sess, id: id("ses"), createdAt: nowISO() };
        set((s) => {
          s.sessions.push(item);
        });
        return item;
      },
      updateSession: (sid, patch) =>
        set((s) => {
          const sess = s.sessions.find((x) => x.id === sid);
          if (sess) Object.assign(sess, patch);
        }),

      addEvidence: (e) => {
        const item: Evidence = { ...e, id: id("ev"), createdAt: nowISO() };
        set((s) => {
          s.evidence.push(item);
        });
        return item;
      },
      updateEvidence: (eid, patch) =>
        set((s) => {
          const e = s.evidence.find((x) => x.id === eid);
          if (e) Object.assign(e, patch);
        }),

      addIssue: (i) => {
        const item: Issue = { ...i, id: id("iss"), createdAt: nowISO() };
        set((s) => {
          s.issues.push(item);
        });
        get().logActivity({
          type: "issue_reported",
          entityKind: "issue",
          entityId: item.id,
          businessId: item.businessId,
          foId: item.foId,
          rigId: item.rigId,
          issueId: item.id,
          summary: `Issue reported: ${item.title}`,
        });
        return item;
      },
      updateIssue: (iid, patch) =>
        set((s) => {
          const i = s.issues.find((x) => x.id === iid);
          if (i) Object.assign(i, patch);
        }),
      resolveIssue: (iid, resolution) => {
        set((s) => {
          const i = s.issues.find((x) => x.id === iid);
          if (i) {
            i.status = "resolved";
            i.resolution = resolution;
            i.resolvedAt = nowISO();
          }
        });
        const issue = get().issues.find((x) => x.id === iid);
        if (issue) {
          get().logActivity({
            type: "issue_resolved",
            entityKind: "issue",
            entityId: issue.id,
            businessId: issue.businessId,
            foId: issue.foId,
            issueId: issue.id,
            summary: `Issue resolved: ${issue.title}`,
          });
        }
      },

      addQualityReview: (q) => {
        const item: QualityReview = { ...q, id: id("qa"), createdAt: nowISO() };
        set((s) => {
          s.qualityReviews.push(item);
        });
        return item;
      },
      updateQualityReview: (qid, patch) =>
        set((s) => {
          const q = s.qualityReviews.find((x) => x.id === qid);
          if (q) Object.assign(q, patch);
        }),
      addCorrectiveAction: (c) => {
        const item: CorrectiveAction = { ...c, id: id("ca"), createdAt: nowISO() };
        set((s) => {
          s.correctiveActions.push(item);
        });
        return item;
      },
      updateCorrectiveAction: (cid, patch) =>
        set((s) => {
          const c = s.correctiveActions.find((x) => x.id === cid);
          if (c) Object.assign(c, patch);
        }),

      addPlan: (p) => {
        const item: DailyPlan = { ...p, id: id("plan"), createdAt: nowISO() };
        set((s) => {
          s.plans.push(item);
        });
        return item;
      },
      updatePlan: (pid, patch) =>
        set((s) => {
          const p = s.plans.find((x) => x.id === pid);
          if (p) Object.assign(p, patch);
        }),

      // Same idempotency guarantee as addAssignment (see its comment): each
      // draft assignment's FINAL, persisted id is derived deterministically
      // from its logical identity, not the temporary id() it was given
      // when the draft was built (by AssignmentFormDialog's manual-add flow
      // or engine/planner.ts's proposeDailyPlan()). Approving the SAME
      // logical plan more than once — a rapid double-click on "Approve
      // Plan", or a Manager re-running "Generate AI Recommendations" +
      // "Approve" for a date they'd already approved because an earlier
      // attempt looked like it had failed — recomputes the SAME ids for
      // each assignment and finds them already present, so no additional
      // Firestore documents are ever created. Different logical
      // assignments (a different time slot, a different rig) still get
      // their own distinct ids and are never collapsed together — the
      // identity key is the full six-field tuple, not just business+FO.
      approvePlan: (planId, approvedBy) => {
        const plan = get().plans.find((p) => p.id === planId);
        if (!plan?.draftAssignments?.length) return;
        const now = nowISO();
        const draft = plan.draftAssignments;
        const finalAssignmentIds: string[] = [];
        set((s) => {
          for (const a of draft) {
            const assignmentId = deriveAssignmentId(a);
            finalAssignmentIds.push(assignmentId);
            if (s.assignments.some((x) => x.id === assignmentId)) continue;
            // status "planned" -> "confirmed": the plan is no longer a
            // proposal, it's what the FO will actually execute tomorrow.
            s.assignments.push({ ...a, id: assignmentId, status: a.status === "planned" ? "confirmed" : a.status });
          }
          const p = s.plans.find((x) => x.id === planId);
          if (p) {
            p.status = "approved";
            p.assignmentIds = finalAssignmentIds;
            p.approvedBy = approvedBy;
            p.approvedAt = now;
            p.publishedAt = now;
            p.updatedAt = now;
          }
        });
        get().logActivity({
          type: "plan_published",
          entityKind: "plan",
          entityId: planId,
          summary: `Plan for ${plan.date} approved (${draft.length} assignment${draft.length === 1 ? "" : "s"})`,
        });
      },

      addReport: (r) => {
        const item: DailyReport = { ...r, id: id("rep"), generatedAt: nowISO() };
        set((s) => {
          s.reports.push(item);
        });
        return item;
      },
    })),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      version: DATA_VERSION,
      migrate: (persisted, version) => {
        if (version < DATA_VERSION) return emptyCityData();
        return persisted;
      },
    },
  ),
);
