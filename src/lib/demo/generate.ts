import { id } from "@/lib/id";
import { emptyCityData } from "@/store/city";
import { mulberry32, pick, pickN, randInt, chance, type Rand } from "./rng";
import { BUSINESS_SEEDS, FO_SEEDS, COLLECTOR_NAMES, RIG_MODELS } from "./data";
import type {
  CityData,
  Business,
  FieldOfficer,
  Collector,
  Rig,
  Assignment,
  Session,
  Issue,
  QualityReview,
  IssueType,
  ActivityEvent,
  AssignmentStatus,
} from "@/types";

const HISTORY_DAYS = 7; // includes today
const DEMO_REFERENCE_HOUR = 14; // "now" used for today's status mix, so the
// app always looks alive regardless of the wall-clock time it's opened.

function dateNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function at(dateISO: string, hhmm: string): string {
  return new Date(`${dateISO}T${hhmm}:00`).toISOString();
}

function addMinutesISO(iso: string, min: number): string {
  return new Date(new Date(iso).getTime() + min * 60000).toISOString();
}

function minToHHMM(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

interface BuiltEntities {
  businesses: Business[];
  fos: FieldOfficer[];
  collectors: Collector[];
  rigs: Rig[];
}

function buildEntities(rand: Rand): BuiltEntities {
  const businesses: Business[] = BUSINESS_SEEDS.map((seed, i) => ({
    id: id("biz"),
    name: seed.name,
    category: seed.category,
    area: seed.area,
    address: `${randInt(1, 220, rand)} ${seed.area} Main Road, Bengaluru`,
    lat: 12.9 + rand() * 0.15,
    lng: 77.55 + rand() * 0.2,
    contactName: pick(COLLECTOR_NAMES, rand),
    contactPhone: `+91 9${randInt(100000000, 999999999, rand)}`,
    preferredWindowStart: seed.windowed?.[0],
    preferredWindowEnd: seed.windowed?.[1],
    capacityHoursPerDay: randInt(2, 4, rand),
    notes: undefined,
    active: i < 17 || chance(0.5, rand),
    createdAt: new Date(Date.now() - randInt(30, 180, rand) * 86400000).toISOString(),
    firstVisitAt: new Date(Date.now() - randInt(20, 150, rand) * 86400000).toISOString(),
  }));

  const fos: FieldOfficer[] = FO_SEEDS.map((seed) => ({
    id: id("fo"),
    name: seed.name,
    phone: `+91 8${randInt(100000000, 999999999, rand)}`,
    homeArea: seed.homeArea,
    active: true,
    createdAt: new Date(Date.now() - randInt(60, 300, rand) * 86400000).toISOString(),
  }));

  const collectors: Collector[] = COLLECTOR_NAMES.map((name, i) => ({
    id: id("col"),
    name,
    businessId: businesses[i % businesses.length].id,
    phone: `+91 7${randInt(100000000, 999999999, rand)}`,
    active: true,
    createdAt: new Date().toISOString(),
  }));

  const rigs: Rig[] = Array.from({ length: 8 }).map((_, i) => {
    const battery = randInt(35, 100, rand);
    const storage = randInt(10, 85, rand);
    let condition: Rig["condition"] = "healthy";
    if (i === 7) condition = "offline";
    else if (battery < 45 || storage > 80) condition = "warning";
    if (i === 3 && chance(0.5, rand)) condition = "critical";
    return {
      id: id("rig"),
      code: `R-${String(i + 1).padStart(2, "0")}`,
      model: pick(RIG_MODELS, rand),
      active: condition !== "offline",
      batteryPct: battery,
      storagePct: storage,
      condition,
      lastServiceAt: new Date(Date.now() - randInt(5, 60, rand) * 86400000).toISOString(),
      createdAt: new Date(Date.now() - randInt(60, 300, rand) * 86400000).toISOString(),
    };
  });

  return { businesses, fos, collectors, rigs };
}

const ISSUE_TITLES: Partial<Record<IssueType, string>> = {
  business_rejection: "Business rejected scheduled visit",
  fo_no_show: "FO did not check in for visit",
  late_arrival: "FO arrived late to business",
  rig_failure: "Rig malfunction reported",
  battery: "Rig battery below safe threshold",
  storage: "Rig storage critically low",
  network: "Network/signal dropped during session",
  recording_failure: "Recording failed to capture properly",
  quality: "Session flagged for quality concerns",
  damage: "Equipment damage reported",
  missing_evidence: "Evidence not submitted after session",
  scheduling: "Scheduling conflict identified",
};

interface DayContext {
  date: string;
  isToday: boolean;
  refTime: string; // ISO instant used as "now" for status decisions
}

interface Accumulators {
  assignments: Assignment[];
  sessions: Session[];
  issues: Issue[];
  qualityReviews: QualityReview[];
  activity: ActivityEvent[];
}

function pushActivity(
  acc: Accumulators,
  e: Omit<ActivityEvent, "id">,
) {
  acc.activity.push({ id: id("act"), ...e });
}

function generateDay(ctx: DayContext, ents: BuiltEntities, rand: Rand, acc: Accumulators) {
  const activeBusinesses = ents.businesses.filter((b) => b.active);
  const count = randInt(3, 6, rand);
  const dayBusinesses = pickN(activeBusinesses, Math.min(count, activeBusinesses.length), rand);
  const usedRigTimes: { rigId: string; start: number; end: number }[] = [];
  const foLoad = new Map<string, number>();

  dayBusinesses.forEach((biz, idx) => {
    // pick FO with lowest load so far (simple balance)
    const fo = [...ents.fos].sort(
      (a, b) => (foLoad.get(a.id) ?? 0) - (foLoad.get(b.id) ?? 0),
    )[idx % ents.fos.length];
    foLoad.set(fo.id, (foLoad.get(fo.id) ?? 0) + 1);

    const rig = pick(
      ents.rigs.filter((r) => r.active),
      rand,
    );
    const collector = ents.collectors.find((c) => c.businessId === biz.id) ?? pick(ents.collectors, rand);

    const durationMin = randInt(75, 165, rand);
    let startMin: number;
    if (biz.preferredWindowStart && biz.preferredWindowEnd) {
      const [sh, sm] = biz.preferredWindowStart.split(":").map(Number);
      const [eh, em] = biz.preferredWindowEnd.split(":").map(Number);
      const winStart = sh * 60 + sm;
      const winEnd = Math.max(eh * 60 + em - durationMin, winStart);
      startMin = randInt(winStart, winEnd, rand);
    } else {
      startMin = randInt(8 * 60 + 30, 17 * 60, rand);
    }
    // simple non-overlap nudge for the same rig
    for (const used of usedRigTimes) {
      if (used.rigId === rig.id && startMin < used.end && startMin + durationMin > used.start) {
        startMin = used.end + 15;
      }
    }
    usedRigTimes.push({ rigId: rig.id, start: startMin, end: startMin + durationMin });

    const plannedStart = at(ctx.date, minToHHMM(startMin));
    const plannedEnd = addMinutesISO(plannedStart, durationMin);
    const priority: Assignment["priority"] = idx === 0 ? "high" : chance(0.25, rand) ? "low" : "normal";

    const assignmentId = id("asg");
    pushActivity(acc, {
      type: "assignment_created",
      at: ctx.date === ctx.date ? new Date(new Date(plannedStart).getTime() - 3600_000).toISOString() : plannedStart,
      entityKind: "assignment",
      entityId: assignmentId,
      businessId: biz.id,
      foId: fo.id,
      summary: `${fo.name} assigned to ${biz.name}`,
    });

    const isFuture = ctx.isToday && new Date(plannedStart).getTime() > new Date(ctx.refTime).getTime();
    const isCurrentlyActive =
      ctx.isToday &&
      new Date(plannedStart).getTime() <= new Date(ctx.refTime).getTime() &&
      new Date(plannedEnd).getTime() > new Date(ctx.refTime).getTime();

    let status: AssignmentStatus = "planned";
    let sessionId: string | undefined;
    let actualArrivalAt: string | undefined;
    let actualStart: string | undefined;
    let actualEnd: string | undefined;

    if (isFuture) {
      status = "planned";
    } else if (isCurrentlyActive) {
      status = "in_progress";
      const delay = chance(0.3, rand) ? randInt(5, 20, rand) : 0;
      actualArrivalAt = addMinutesISO(plannedStart, delay);
      actualStart = addMinutesISO(actualArrivalAt, randInt(3, 10, rand));
      const elapsedMin = Math.round(
        (new Date(ctx.refTime).getTime() - new Date(actualStart).getTime()) / 60000,
      );
      const battery = Math.max(18, rig.batteryPct - Math.round(elapsedMin / 6));
      const storage = Math.min(97, rig.storagePct + Math.round(elapsedMin / 10));
      const signal: Session["signal"] = chance(0.12, rand) ? "intermittent" : "healthy";
      const sess: Session = {
        id: id("ses"),
        assignmentId,
        businessId: biz.id,
        foId: fo.id,
        collectorId: collector?.id,
        rigId: rig.id,
        date: ctx.date,
        startedAt: actualStart,
        plannedDurationMin: durationMin,
        status: "active",
        batteryPct: battery,
        storagePct: storage,
        signal,
        checklistSetup: {
          confirmedBusiness: true,
          scannedRig: true,
          checkedBattery: true,
          checkedStorage: true,
          confirmedCollector: true,
          capturedEvidence: chance(0.6, rand),
        },
        createdAt: actualStart,
      };
      acc.sessions.push(sess);
      sessionId = sess.id;
      pushActivity(acc, {
        type: "fo_arrived",
        at: actualArrivalAt,
        entityKind: "assignment",
        entityId: assignmentId,
        businessId: biz.id,
        foId: fo.id,
        summary: `${fo.name} arrived at ${biz.name}`,
      });
      pushActivity(acc, {
        type: "session_started",
        at: actualStart,
        entityKind: "session",
        entityId: sess.id,
        businessId: biz.id,
        foId: fo.id,
        rigId: rig.id,
        sessionId: sess.id,
        summary: `Recording session started at ${biz.name}`,
      });
      if (battery < 30) {
        pushActivity(acc, {
          type: "battery_warning",
          at: ctx.refTime,
          entityKind: "session",
          entityId: sess.id,
          businessId: biz.id,
          rigId: rig.id,
          sessionId: sess.id,
          summary: `Rig ${rig.code} battery low (${battery}%)`,
        });
      }
      if (delay >= 15) {
        const issueId = id("iss");
        acc.issues.push({
          id: issueId,
          type: "late_arrival",
          severity: "warning",
          title: ISSUE_TITLES.late_arrival!,
          description: `${fo.name} arrived ${delay} minutes late to ${biz.name}.`,
          businessId: biz.id,
          foId: fo.id,
          assignmentId,
          owner: fo.name,
          status: "open",
          lostHours: Math.round((delay / 60) * 100) / 100,
          createdAt: actualArrivalAt,
        });
      }
    } else {
      // resolved in the past (either earlier today or a prior day)
      const outcomeRoll = rand();
      if (outcomeRoll < 0.06) {
        status = "rejected";
        const issueId = id("iss");
        acc.issues.push({
          id: issueId,
          type: "business_rejection",
          severity: "critical",
          title: ISSUE_TITLES.business_rejection!,
          description: `${biz.name} rejected the scheduled visit.`,
          businessId: biz.id,
          foId: fo.id,
          assignmentId,
          owner: "You",
          status: chance(0.5, rand) ? "resolved" : "open",
          lostHours: Math.round((durationMin / 60) * 100) / 100,
          createdAt: plannedStart,
          resolvedAt: chance(0.5, rand) ? plannedEnd : undefined,
          resolution: chance(0.5, rand) ? "Rescheduled for next available window." : undefined,
        });
        pushActivity(acc, {
          type: "business_rejected",
          at: plannedStart,
          entityKind: "assignment",
          entityId: assignmentId,
          businessId: biz.id,
          foId: fo.id,
          issueId,
          summary: `${biz.name} rejected today's visit`,
        });
      } else if (outcomeRoll < 0.11) {
        status = "no_show";
        acc.issues.push({
          id: id("iss"),
          type: "fo_no_show",
          severity: "critical",
          title: ISSUE_TITLES.fo_no_show!,
          description: `${fo.name} did not check in for the visit at ${biz.name}.`,
          businessId: biz.id,
          foId: fo.id,
          assignmentId,
          owner: fo.name,
          status: chance(0.6, rand) ? "resolved" : "open",
          lostHours: Math.round((durationMin / 60) * 100) / 100,
          createdAt: plannedStart,
        });
      } else {
        status = "completed";
        const delay = chance(0.22, rand) ? randInt(8, 45, rand) : 0;
        actualArrivalAt = addMinutesISO(plannedStart, delay);
        actualStart = addMinutesISO(actualArrivalAt, randInt(3, 10, rand));
        const achievedPct = chance(0.85, rand) ? randInt(88, 104, rand) : randInt(55, 87, rand);
        const actualDuration = Math.round((durationMin * achievedPct) / 100);
        actualEnd = addMinutesISO(actualStart, actualDuration);

        const battery = Math.max(12, rig.batteryPct - randInt(20, 55, rand));
        const storage = Math.min(98, rig.storagePct + randInt(10, 40, rand));
        const signal: Session["signal"] = chance(0.08, rand) ? "intermittent" : "healthy";

        const sess: Session = {
          id: id("ses"),
          assignmentId,
          businessId: biz.id,
          foId: fo.id,
          collectorId: collector?.id,
          rigId: rig.id,
          date: ctx.date,
          startedAt: actualStart,
          endedAt: actualEnd,
          plannedDurationMin: durationMin,
          status: "completed",
          batteryPct: battery,
          storagePct: storage,
          signal,
          checklistSetup: {
            confirmedBusiness: true,
            scannedRig: true,
            checkedBattery: true,
            checkedStorage: true,
            confirmedCollector: true,
            capturedEvidence: chance(0.9, rand),
          },
          createdAt: actualStart,
        };
        acc.sessions.push(sess);
        sessionId = sess.id;

        pushActivity(acc, {
          type: "fo_arrived",
          at: actualArrivalAt,
          entityKind: "assignment",
          entityId: assignmentId,
          businessId: biz.id,
          foId: fo.id,
          summary: `${fo.name} arrived at ${biz.name}`,
        });
        pushActivity(acc, {
          type: "session_started",
          at: actualStart,
          entityKind: "session",
          entityId: sess.id,
          businessId: biz.id,
          foId: fo.id,
          rigId: rig.id,
          sessionId: sess.id,
          summary: `Session started at ${biz.name}`,
        });
        pushActivity(acc, {
          type: "session_ended",
          at: actualEnd,
          entityKind: "session",
          entityId: sess.id,
          businessId: biz.id,
          foId: fo.id,
          rigId: rig.id,
          sessionId: sess.id,
          summary: `Session ended at ${biz.name} (${(actualDuration / 60).toFixed(1)}h recorded)`,
        });

        if (delay >= 15) {
          acc.issues.push({
            id: id("iss"),
            type: "late_arrival",
            severity: "warning",
            title: ISSUE_TITLES.late_arrival!,
            description: `${fo.name} arrived ${delay} minutes late to ${biz.name}.`,
            businessId: biz.id,
            foId: fo.id,
            assignmentId,
            owner: fo.name,
            status: "resolved",
            resolvedAt: actualEnd,
            resolution: "Noted; no further action required.",
            lostHours: Math.round((delay / 60) * 100) / 100,
            createdAt: actualArrivalAt,
          });
        }

        if (rig.condition !== "healthy" && chance(0.4, rand)) {
          const type: IssueType = rig.condition === "critical" ? "rig_failure" : "battery";
          acc.issues.push({
            id: id("iss"),
            type,
            severity: rig.condition === "critical" ? "critical" : "warning",
            title: ISSUE_TITLES[type]!,
            description: `${rig.code} showed ${type === "rig_failure" ? "a hardware fault" : "low battery"} during the session at ${biz.name}.`,
            businessId: biz.id,
            foId: fo.id,
            rigId: rig.id,
            sessionId: sess.id,
            assignmentId,
            owner: "You",
            status: chance(0.5, rand) ? "resolved" : "open",
            resolvedAt: chance(0.5, rand) ? actualEnd : undefined,
            lostHours: type === "rig_failure" ? 0.5 : 0.2,
            createdAt: actualEnd,
          });
        }

        // quality review
        const qRoll = rand();
        let verdict: QualityReview["verdict"] = "pass";
        const flags: QualityReview["flags"] = [];
        if (achievedPct < 70) {
          verdict = "fail";
          flags.push({
            code: "low_duration",
            label: "Duration significantly below plan",
            detail: `Recorded only ${achievedPct}% of the planned duration.`,
          });
        } else if (qRoll > 0.93) {
          verdict = "fail";
          flags.push({
            code: "missing_evidence",
            label: "Missing evidence",
            detail: "No evidence files were submitted for this session.",
          });
        } else if (qRoll > 0.8 || achievedPct < 88) {
          verdict = "warn";
          flags.push({
            code: "low_duration",
            label: "Duration below target",
            detail: `Recorded ${achievedPct}% of the planned duration.`,
          });
        }
        acc.qualityReviews.push({
          id: id("qa"),
          sessionId: sess.id,
          businessId: biz.id,
          foId: fo.id,
          verdict,
          flags,
          reviewedAt: verdict === "pass" ? actualEnd : undefined,
          createdAt: actualEnd,
        });
        pushActivity(acc, {
          type: verdict === "pass" ? "qa_passed" : verdict === "warn" ? "qa_warned" : "qa_failed",
          at: actualEnd,
          entityKind: "quality",
          entityId: sess.id,
          businessId: biz.id,
          foId: fo.id,
          sessionId: sess.id,
          summary: `QA ${verdict === "pass" ? "passed" : verdict === "warn" ? "flagged a warning" : "failed"} for ${biz.name} session`,
        });
      }
    }

    acc.assignments.push({
      id: assignmentId,
      date: ctx.date,
      businessId: biz.id,
      foId: fo.id,
      collectorId: collector?.id,
      rigId: rig.id,
      plannedStart,
      plannedEnd,
      actualArrivalAt,
      actualStart,
      actualEnd,
      priority,
      status,
      sessionId,
      createdAt: plannedStart,
    });
  });
}

export function generateDemoData(seed = 42): CityData {
  const rand = mulberry32(seed);
  const data = emptyCityData();
  const entities = buildEntities(rand);
  data.businesses = entities.businesses;
  data.fos = entities.fos;
  data.collectors = entities.collectors;
  data.rigs = entities.rigs;
  data.settings.onboarded = true;

  const acc: Accumulators = {
    assignments: [],
    sessions: [],
    issues: [],
    qualityReviews: [],
    activity: [],
  };

  for (let n = HISTORY_DAYS - 1; n >= 0; n--) {
    const date = dateNDaysAgo(n);
    const isToday = n === 0;
    const refTime = isToday
      ? (() => {
          const d = new Date();
          d.setHours(DEMO_REFERENCE_HOUR, 30, 0, 0);
          return d.toISOString();
        })()
      : at(date, "23:59");
    generateDay({ date, isToday, refTime }, entities, rand, acc);
  }

  data.assignments = acc.assignments;
  data.sessions = acc.sessions;
  data.issues = acc.issues;
  data.qualityReviews = acc.qualityReviews;
  data.activity = acc.activity.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return data;
}
