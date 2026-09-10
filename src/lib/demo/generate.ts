import { id } from "@/lib/id";
import { emptyCityData } from "@/store/city";
import { mulberry32, pick, pickN, randInt, chance, type Rand } from "./rng";
import { BUSINESS_SEEDS, FO_SEEDS, COLLECTOR_NAMES, RIG_MODELS } from "./data";
import { ISSUE_TYPE_BY_GROUP, categoryGroup, categoryLabel } from "@/engine/rigTaxonomy";
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
  DamageCategory,
  RigIncident,
  RepairRecord,
  ActivityEvent,
  AssignmentStatus,
  DiscoveryStage,
  Severity,
} from "@/types";

const HISTORY_DAYS = 7; // includes today
const DEMO_REFERENCE_HOUR = 14; // "now" used for today's status mix, so the
// app always looks alive regardless of the wall-clock time it's opened.

const RIG_COUNT = 10;
// Designated "problem rigs" (spec: "3-4 out of 10 rigs experience damage").
const CABLE_REPEAT_RIG_IDX = 1; // repeated cable/physical failures -> pattern detection
const CRITICAL_TODAY_RIG_IDX = 3; // fresh critical incident discovered today -> DO NOT DEPLOY
const INSPECTION_DUE_RIG_IDX = 6; // never inspected, aging -> inspection required
const REPAIR_HISTORY_RIG_IDX = 8; // resolved incident + repair record on file
const ETHERNET_ISSUE_RIG_IDX = 5; // open ethernet cable issue -> BLOCKED
const IMU_ISSUE_RIG_IDX = 7; // open IMU issue, non-blocking -> AT_RISK

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

  // 10 rigs, all created well over a month ago so history-based scoring
  // (long healthy streak, inspection age) behaves realistically from day one.
  const rigs: Rig[] = Array.from({ length: RIG_COUNT }).map((_, i) => {
    const battery = randInt(55, 100, rand);
    const storage = randInt(10, 60, rand);
    const createdAt = new Date(Date.now() - randInt(90, 240, rand) * 86400000).toISOString();
    // Most rigs were inspected recently; the designated "needs inspection"
    // rig (index INSPECTION_DUE_RIG_IDX) is deliberately left never-inspected.
    const lastInspectionAt = i === INSPECTION_DUE_RIG_IDX ? undefined : new Date(Date.now() - randInt(4, 25, rand) * 86400000).toISOString();
    return {
      id: id("rig"),
      code: `R-${String(i + 1).padStart(2, "0")}`,
      model: pick(RIG_MODELS, rand),
      active: true,
      batteryPct: battery,
      storagePct: storage,
      deploymentStatus: "active",
      lastInspectionAt,
      lastServiceAt: lastInspectionAt,
      createdAt,
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
  rigIncidents: RigIncident[];
  repairRecords: RepairRecord[];
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
        const isResolved = chance(0.5, rand);
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
          status: isResolved ? "resolved" : "open",
          lostHours: Math.round((durationMin / 60) * 100) / 100,
          createdAt: plannedStart,
          resolvedAt: isResolved ? plannedEnd : undefined,
          resolution: isResolved ? "Rescheduled for next available window." : undefined,
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
        const noShowResolved = chance(0.6, rand);
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
          status: noShowResolved ? "resolved" : "open",
          lostHours: Math.round((durationMin / 60) * 100) / 100,
          createdAt: plannedStart,
          resolvedAt: noShowResolved ? plannedEnd : undefined,
          resolution: noShowResolved ? "Follow-up call made; visit will be rescheduled." : undefined,
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

        // Rig incident history is seeded deliberately in seedRigIncidentHistory()
        // after the day loop, so specific rigs get coherent, realistic patterns
        // instead of independent per-session dice rolls.

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

interface IncidentSeed {
  category: DamageCategory;
  severity: Severity;
  discoveredAt: string;
  discoveryStage: DiscoveryStage;
  description: string;
  resolvedAt?: string;
  resolution?: string;
  lostHours: number;
  sessionId?: string;
  businessId?: string;
  foId?: string;
}

function pushIncident(acc: Accumulators, rig: Rig, seed: IncidentSeed): RigIncident {
  const group = categoryGroup(seed.category);
  const issueId = id("iss");
  const incidentId = id("rin");

  acc.issues.push({
    id: issueId,
    type: ISSUE_TYPE_BY_GROUP[group],
    severity: seed.severity,
    title: `${rig.code}: ${categoryLabel(seed.category)}`,
    description: seed.description,
    businessId: seed.businessId,
    foId: seed.foId,
    rigId: rig.id,
    sessionId: seed.sessionId,
    owner: "You",
    status: seed.resolvedAt ? "resolved" : "open",
    lostHours: seed.lostHours,
    createdAt: seed.discoveredAt,
    resolvedAt: seed.resolvedAt,
    resolution: seed.resolution,
  });

  const incident: RigIncident = {
    id: incidentId,
    rigId: rig.id,
    sessionId: seed.sessionId,
    businessId: seed.businessId,
    foId: seed.foId,
    category: seed.category,
    group,
    severity: seed.severity,
    discoveredAt: seed.discoveredAt,
    discoveryStage: seed.discoveryStage,
    description: seed.description,
    evidence: [],
    status: seed.resolvedAt ? "resolved" : "open",
    linkedIssueId: issueId,
    lostHours: seed.lostHours,
    createdAt: seed.discoveredAt,
    resolvedAt: seed.resolvedAt,
  };
  acc.rigIncidents.push(incident);

  acc.activity.push({
    id: id("act"),
    type: "rig_incident_reported",
    at: seed.discoveredAt,
    entityKind: "rig_incident",
    entityId: incidentId,
    rigId: rig.id,
    businessId: seed.businessId,
    foId: seed.foId,
    sessionId: seed.sessionId,
    issueId,
    summary: `${rig.code}: ${categoryLabel(seed.category)} (discovered at ${seed.discoveryStage.replace("_", " ")})`,
    detail: seed.description,
  });

  return incident;
}

/** Deliberately shapes 3-4 rigs into the exact scenarios Rig Guardian is
 * built to catch, instead of leaving it to chance: a fresh unresolved
 * critical cable issue (DO NOT DEPLOY today), a repeated same-group failure
 * pattern, a never-inspected aging rig, and one fully repaired history for
 * realism. Everything else is generated by generateDay(), so most of the
 * fleet stays plainly healthy. */
function seedRigIncidentHistory(ents: BuiltEntities, acc: Accumulators, rand: Rand) {
  function sessionsFor(rigId: string): Session[] {
    return acc.sessions.filter((s) => s.rigId === rigId).sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
  }

  // (a) Cable issue, discovered a few hours ago, unresolved -> DO NOT DEPLOY.
  const cableRig = ents.rigs[CRITICAL_TODAY_RIG_IDX];
  {
    const sessions = sessionsFor(cableRig.id);
    const recent = sessions[sessions.length - 1];
    const discoveredAt = new Date();
    discoveredAt.setHours(discoveredAt.getHours() - randInt(1, 4, rand), discoveredAt.getMinutes() - randInt(0, 59, rand));
    pushIncident(acc, cableRig, {
      category: "wire_broken",
      severity: "critical",
      discoveredAt: discoveredAt.toISOString(),
      discoveryStage: recent ? "post_session" : "maintenance",
      description: `A snapped internal wire was found on ${cableRig.code} during inspection. Not safe to deploy until repaired.`,
      lostHours: 1.2,
      sessionId: recent?.id,
      businessId: recent?.businessId,
      foId: recent?.foId,
    });
  }

  // (b) Repeated same-group (camera) incidents in the last 14 days.
  const repeatRig = ents.rigs[CABLE_REPEAT_RIG_IDX];
  {
    const sessions = sessionsFor(repeatRig.id);
    const plan: { daysAgo: number; category: DamageCategory; stage: DiscoveryStage; resolved: boolean }[] = [
      { daysAgo: 9, category: "camera_dropout", stage: "preflight", resolved: true },
      { daysAgo: 6, category: "camera_not_detected", stage: "preflight", resolved: true },
      { daysAgo: 2, category: "image_problem", stage: "during_recording", resolved: false },
    ];
    plan.forEach((p, idx) => {
      const session = sessions[idx % Math.max(1, sessions.length)];
      const d = new Date();
      d.setDate(d.getDate() - p.daysAgo);
      d.setHours(10 + idx, 20, 0, 0);
      const resolvedAt = p.resolved ? new Date(d.getTime() + 3 * 3_600_000).toISOString() : undefined;
      pushIncident(acc, repeatRig, {
        category: p.category,
        severity: "warning",
        discoveredAt: d.toISOString(),
        discoveryStage: p.stage,
        description: `${categoryLabel(p.category)} reported on ${repeatRig.code}.`,
        resolvedAt,
        resolution: p.resolved ? "Reset and reseated the camera module; monitored on the next session." : undefined,
        lostHours: 0.3,
        sessionId: session?.id,
        businessId: session?.businessId,
        foId: session?.foId,
      });
    });
  }

  // (b2) Ethernet cable issue, unresolved -> BLOCKED. Showcases the
  // physical/network-cable failure mode ops actually reports in the field,
  // distinct from (a)'s snapped internal wire.
  const ethernetRig = ents.rigs[ETHERNET_ISSUE_RIG_IDX];
  {
    const sessions = sessionsFor(ethernetRig.id);
    const recent = sessions[sessions.length - 1];
    const d = new Date();
    d.setHours(d.getHours() - randInt(2, 10, rand));
    pushIncident(acc, ethernetRig, {
      category: "ethernet_issue",
      severity: "warning",
      discoveredAt: d.toISOString(),
      discoveryStage: "preflight",
      description: `${ethernetRig.code}'s ethernet cable is damaged and won't hold a connection — flagged during preflight.`,
      lostHours: 0.5,
      sessionId: recent?.id,
      businessId: recent?.businessId,
      foId: recent?.foId,
    });
  }

  // (b3) IMU issue, unresolved but non-blocking -> AT_RISK. Rig still
  // records; the FO should use it with caution until it's checked.
  const imuRig = ents.rigs[IMU_ISSUE_RIG_IDX];
  {
    const sessions = sessionsFor(imuRig.id);
    const recent = sessions[sessions.length - 1];
    const d = new Date();
    d.setHours(d.getHours() - randInt(1, 6, rand));
    pushIncident(acc, imuRig, {
      category: "imu_issue",
      severity: "attention",
      discoveredAt: d.toISOString(),
      discoveryStage: "post_session",
      description: `${imuRig.code}'s IMU is reporting drift — orientation data may be unreliable until checked.`,
      lostHours: 0,
      sessionId: recent?.id,
      businessId: recent?.businessId,
      foId: recent?.foId,
    });
  }

  // (c) INSPECTION_DUE_RIG_IDX needs no incidents — buildEntities() already
  // leaves it without a lastInspectionAt, which alone triggers the rule.

  // (d) A fully closed repair loop for realism (Retire vs Repair panel,
  // repair-turnaround metrics, "successful inspection" bonus).
  const repairRig = ents.rigs[REPAIR_HISTORY_RIG_IDX];
  {
    const sessions = sessionsFor(repairRig.id);
    const session = sessions[0];
    const d = new Date();
    d.setDate(d.getDate() - 20);
    d.setHours(15, 0, 0, 0);
    const repairedAt = new Date(d.getTime() + 2 * 86_400_000).toISOString();
    const incident = pushIncident(acc, repairRig, {
      category: "battery_issue",
      severity: "critical",
      discoveredAt: d.toISOString(),
      discoveryStage: "during_recording",
      description: `${repairRig.code} lost power mid-session; the battery would not hold charge.`,
      resolvedAt: repairedAt,
      resolution: "Battery pack replaced and load-tested.",
      lostHours: 0.9,
      sessionId: session?.id,
      businessId: session?.businessId,
      foId: session?.foId,
    });

    const repairId = id("rep_rec");
    acc.repairRecords.push({
      id: repairId,
      rigId: repairRig.id,
      incidentId: incident.id,
      diagnosis: "Battery pack no longer holds charge under load.",
      repairAction: "Replaced battery pack and tested under full recording load.",
      parts: "Battery pack (OEM)",
      beforeEvidence: [],
      afterEvidence: [],
      testChecklist: { power: true, cameras: true, cables: true, connectors: true, storage: true, recording: true, battery: true },
      testResult: "pass",
      repairedAt,
      notes: "Rig cleared for redeployment.",
      createdAt: d.toISOString(),
    });
    incident.repairRecordId = repairId;

    acc.activity.push({
      id: id("act"),
      type: "rig_repair_test_passed",
      at: repairedAt,
      entityKind: "repair",
      entityId: repairId,
      rigId: repairRig.id,
      summary: `Post-repair test passed for ${repairRig.code} — returned to service`,
    });
  }
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
    rigIncidents: [],
    repairRecords: [],
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

  seedRigIncidentHistory(entities, acc, rand);

  data.assignments = acc.assignments;
  data.sessions = acc.sessions;
  data.issues = acc.issues;
  data.qualityReviews = acc.qualityReviews;
  data.rigIncidents = acc.rigIncidents;
  data.repairRecords = acc.repairRecords;
  data.activity = acc.activity.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return data;
}
