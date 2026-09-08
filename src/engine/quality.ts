import type { QualityFlag, QualityVerdict, Session } from "@/types";

export interface AutoReviewResult {
  verdict: QualityVerdict;
  flags: QualityFlag[];
}

/** Deterministic rule-based flagging — never machine learning. Mirrors the
 * rules described in the Quality Center spec: duration shortfall, missing
 * evidence, incomplete checklist, missing end event. */
export function autoQualityReview(session: Session): AutoReviewResult {
  const flags: QualityFlag[] = [];

  if (!session.endedAt) {
    flags.push({ code: "missing_end", label: "Missing end event", detail: "Session has no recorded end time." });
    return { verdict: "warn", flags };
  }

  const actualMin = (new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 60000;
  const pct = session.plannedDurationMin > 0 ? (actualMin / session.plannedDurationMin) * 100 : 100;

  if (pct < 70) {
    flags.push({
      code: "low_duration",
      label: "Duration significantly below plan",
      detail: `Recorded ${Math.round(actualMin)}m of a planned ${session.plannedDurationMin}m (${Math.round(pct)}%).`,
    });
  } else if (pct < 88) {
    flags.push({
      code: "low_duration_minor",
      label: "Duration below target",
      detail: `Recorded ${Math.round(pct)}% of the planned duration.`,
    });
  }

  if (session.checklistSetup && !session.checklistSetup.capturedEvidence) {
    flags.push({ code: "missing_evidence", label: "Missing evidence", detail: "No evidence was captured for this session." });
  }

  if (session.checklistSetup) {
    const incomplete = Object.values(session.checklistSetup).some((v) => v === false);
    if (incomplete) {
      flags.push({ code: "incomplete_checklist", label: "Incomplete checklist", detail: "Setup checklist was not fully completed." });
    }
  }

  if (session.signal === "intermittent") {
    flags.push({ code: "signal", label: "Unusual telemetry", detail: "Signal was intermittent during the session." });
  }

  const hasSevere = flags.some((f) => f.code === "low_duration" || f.code === "missing_end" || f.code === "missing_evidence");
  const verdict: QualityVerdict = hasSevere ? "fail" : flags.length > 0 ? "warn" : "pass";

  return { verdict, flags };
}
