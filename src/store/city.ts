import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { id } from "@/lib/id";
import { nowISO } from "@/lib/dates";
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
  ActivityEvent,
  DailyPlan,
  DailyReport,
  CitySettings,
} from "@/types";

export const STORAGE_KEY = "city-ops-os";
export const DATA_VERSION = 1;

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

      logActivity: (e) =>
        set((s) => {
          s.activity.unshift({ id: id("act"), at: e.at ?? nowISO(), ...e });
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

      addAssignment: (a) => {
        const item: Assignment = { ...a, id: id("asg"), createdAt: nowISO() };
        set((s) => {
          s.assignments.push(item);
        });
        get().logActivity({
          type: "assignment_created",
          entityKind: "assignment",
          entityId: item.id,
          businessId: item.businessId,
          foId: item.foId,
          summary: `Assignment created`,
        });
        return item;
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
    },
  ),
);
