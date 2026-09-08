import type { Assignment, AssignmentStatus, Business, CityData, Collector, FieldOfficer, Rig, Session, Status } from "@/types";

export interface EnrichedAssignment {
  assignment: Assignment;
  business?: Business;
  fo?: FieldOfficer;
  rig?: Rig;
  collector?: Collector;
  session?: Session;
}

export function enrichAssignments(data: CityData, date: string): EnrichedAssignment[] {
  const bizMap = new Map(data.businesses.map((b) => [b.id, b]));
  const foMap = new Map(data.fos.map((f) => [f.id, f]));
  const rigMap = new Map(data.rigs.map((r) => [r.id, r]));
  const colMap = new Map(data.collectors.map((c) => [c.id, c]));
  const sessMap = new Map(data.sessions.map((s) => [s.id, s]));

  return data.assignments
    .filter((a) => a.date === date)
    .map((assignment) => ({
      assignment,
      business: bizMap.get(assignment.businessId),
      fo: foMap.get(assignment.foId),
      rig: assignment.rigId ? rigMap.get(assignment.rigId) : undefined,
      collector: assignment.collectorId ? colMap.get(assignment.collectorId) : undefined,
      session: assignment.sessionId ? sessMap.get(assignment.sessionId) : undefined,
    }))
    .sort((a, b) => new Date(a.assignment.plannedStart).getTime() - new Date(b.assignment.plannedStart).getTime());
}

export function assignmentStatusToStatus(s: AssignmentStatus): Status {
  switch (s) {
    case "completed":
      return "completed";
    case "in_progress":
      return "active";
    case "planned":
    case "confirmed":
      return "pending";
    case "rejected":
    case "no_show":
      return "critical";
    case "cancelled":
      return "cancelled";
    default:
      return "unknown";
  }
}
