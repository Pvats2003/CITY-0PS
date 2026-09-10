import type { DamageCategory, DamageGroup, DiscoveryStage, IssueType, RigDeploymentStatus, RigIncidentStatus, RigReadinessStatus, Status } from "@/types";

export interface DamageCategoryMeta {
  category: DamageCategory;
  group: DamageGroup;
  label: string;
}

export const DAMAGE_CATEGORIES: DamageCategoryMeta[] = [
  // physical
  { category: "wire_broken", group: "physical", label: "Wire broken" },
  { category: "ethernet_issue", group: "physical", label: "Ethernet cable issue" },
  { category: "cable_frayed", group: "physical", label: "Cable frayed" },
  { category: "connector_damaged", group: "physical", label: "Connector damaged" },
  { category: "connector_loose", group: "physical", label: "Connector loose" },
  { category: "mount_damaged", group: "physical", label: "Mount damaged" },
  { category: "casing_damaged", group: "physical", label: "Casing damaged" },
  { category: "camera_physical_damage", group: "physical", label: "Camera broken" },
  // electrical
  { category: "power_failure", group: "electrical", label: "Power issue" },
  { category: "charging_failure", group: "electrical", label: "Charging failure" },
  { category: "battery_issue", group: "electrical", label: "Battery issue" },
  { category: "overheating", group: "electrical", label: "Overheating" },
  { category: "imu_issue", group: "electrical", label: "IMU issue" },
  // camera
  { category: "camera_not_detected", group: "camera", label: "Camera not detected" },
  { category: "camera_dropout", group: "camera", label: "Camera dropout" },
  { category: "image_problem", group: "camera", label: "Image problem" },
  { category: "lens_obstruction", group: "camera", label: "Lens obstruction" },
  // storage
  { category: "storage_full", group: "storage", label: "Storage full" },
  { category: "memory_card_problem", group: "storage", label: "Memory card problem" },
  { category: "storage_corruption", group: "storage", label: "Storage corruption" },
  // recording
  { category: "recording_wont_start", group: "recording", label: "Recording won't start" },
  { category: "recording_stopped", group: "recording", label: "Recording stopped" },
  { category: "incomplete_recording", group: "recording", label: "Incomplete recording" },
  { category: "audio_failure", group: "recording", label: "Audio failure" },
  // other
  { category: "unknown_technical", group: "other", label: "Unknown technical issue" },
  { category: "accidental_damage", group: "other", label: "Accidental damage" },
  { category: "water_damage", group: "other", label: "Water / liquid exposure" },
  { category: "missing_component", group: "other", label: "Missing component" },
];

export const DAMAGE_CATEGORY_MAP: Record<DamageCategory, DamageCategoryMeta> = Object.fromEntries(
  DAMAGE_CATEGORIES.map((m) => [m.category, m]),
) as Record<DamageCategory, DamageCategoryMeta>;

export function categoryLabel(category: DamageCategory): string {
  return DAMAGE_CATEGORY_MAP[category]?.label ?? category;
}

export function categoryGroup(category: DamageCategory): DamageGroup {
  return DAMAGE_CATEGORY_MAP[category]?.group ?? "other";
}

export const DAMAGE_GROUP_LABELS: Record<DamageGroup, string> = {
  physical: "Physical",
  electrical: "Electrical",
  camera: "Camera",
  storage: "Storage",
  recording: "Recording",
  other: "Other",
};

export const DAMAGE_GROUPS: { group: DamageGroup; label: string; categories: DamageCategory[] }[] = (
  ["physical", "electrical", "camera", "storage", "recording", "other"] as DamageGroup[]
).map((group) => ({
  group,
  label: DAMAGE_GROUP_LABELS[group],
  categories: DAMAGE_CATEGORIES.filter((m) => m.group === group).map((m) => m.category),
}));

/** Maps a damage group onto the closest existing generic IssueType, so a
 * rig incident's companion Issue is correctly counted as a device issue in
 * City Health and as "rig_issue" in the lost-hours breakdown. */
export const ISSUE_TYPE_BY_GROUP: Record<DamageGroup, IssueType> = {
  physical: "damage",
  electrical: "battery",
  camera: "rig_failure",
  storage: "storage",
  recording: "recording_failure",
  other: "damage",
};

export const DISCOVERY_STAGE_LABELS: Record<DiscoveryStage, string> = {
  preflight: "Preflight",
  setup: "Setup",
  during_recording: "During recording",
  post_session: "Post-session",
  qa: "Quality review",
  maintenance: "Maintenance",
  other: "Other",
};

export const RIG_INCIDENT_STATUS_LABELS: Record<RigIncidentStatus, string> = {
  open: "Open",
  triage: "Triage",
  inspection: "Inspection",
  repair: "Repair",
  testing: "Testing",
  resolved: "Resolved",
  cancelled: "Cancelled",
};

export const RIG_DEPLOYMENT_STATUS_LABELS: Record<RigDeploymentStatus, string> = {
  active: "Active",
  standby: "Standby",
  inspection: "Inspection",
  repair: "Repair",
  retired: "Retired",
};

export const RIG_READINESS_LABELS: Record<RigReadinessStatus, string> = {
  healthy: "Ready",
  watch: "Watch",
  inspection_required: "Inspection Required",
  do_not_deploy: "Do Not Deploy",
  in_repair: "In Repair",
};

export const RIG_READINESS_EMOJI: Record<RigReadinessStatus, string> = {
  healthy: "\u{1F7E2}",
  watch: "\u{1F7E1}",
  inspection_required: "\u{1F7E0}",
  do_not_deploy: "\u{1F534}",
  in_repair: "\u{1F527}",
};

/** Maps the 5-tier rig readiness onto the app's generic Status vocabulary,
 * for places (search results, generic badges) that only know that palette.
 * Fleet/Rig 360 use RigReadinessBadge directly for the full-fidelity label. */
export function readinessToStatus(status: RigReadinessStatus): Status {
  switch (status) {
    case "healthy":
      return "healthy";
    case "watch":
    case "inspection_required":
      return "warning";
    case "do_not_deploy":
      return "critical";
    case "in_repair":
      return "pending";
  }
}

// ---------------------------------------------------------------------------
// Deployability — "can this rig be deployed right now?" — the exact 3-tier
// vocabulary ops uses on the ground (READY / AT_RISK / BLOCKED), derived
// from real, currently-OPEN rig issues. There is no rig telemetry in this
// system (no battery/temperature/CPU/GPS/signal feed) — this is the one and
// only signal that determines deployability, by design (see
// rigGuardian.ts's deriveRigReadiness, which this taxonomy backs).
// ---------------------------------------------------------------------------

export type RigDeployability = "READY" | "AT_RISK" | "BLOCKED";

/** A rig with one of these OPEN (category is enough regardless of reported
 * severity — these damage types are never safely deployable while open) is
 * BLOCKED. Any other open issue only makes it AT_RISK — unless the FO/
 * Manager separately marked it "critical" severity, which also forces
 * BLOCKED (see deriveRigReadiness). Documented here, in one place, per the
 * operational-model spec: this list IS the "which issue types are
 * blocking" answer. */
export const BLOCKING_DAMAGE_CATEGORIES = new Set<DamageCategory>([
  "wire_broken",
  "ethernet_issue",
  "camera_physical_damage",
  "camera_not_detected",
  "power_failure",
  "recording_wont_start",
  "storage_full",
  "storage_corruption",
]);

export function isBlockingCategory(category: DamageCategory): boolean {
  return BLOCKING_DAMAGE_CATEGORIES.has(category);
}

export const RIG_DEPLOYABILITY_LABELS: Record<RigDeployability, string> = {
  READY: "Ready",
  AT_RISK: "At Risk",
  BLOCKED: "Blocked",
};

export const RIG_DEPLOYABILITY_EMOJI: Record<RigDeployability, string> = {
  READY: "\u{1F7E2}",
  AT_RISK: "\u{1F7E0}",
  BLOCKED: "\u{1F534}",
};

/** The 5-tier RigReadinessStatus stays exactly as it was (it's what
 * `rig.statusOverride` persists, so its states can't be renamed or
 * collapsed without breaking existing records) — this is purely a display
 * mapping onto the simpler 3-tier vocabulary the rest of the operational
 * model (Rig 360, Fleet/Command Center summaries, Planner) is specified in
 * terms of. `healthy` -> READY, `watch`/`inspection_required` -> AT_RISK,
 * `do_not_deploy`/`in_repair` -> BLOCKED. */
export function toDeployability(status: RigReadinessStatus): RigDeployability {
  switch (status) {
    case "healthy":
      return "READY";
    case "watch":
    case "inspection_required":
      return "AT_RISK";
    case "do_not_deploy":
    case "in_repair":
      return "BLOCKED";
  }
}
