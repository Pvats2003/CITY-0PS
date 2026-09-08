import type { DamageCategory, DamageGroup, DiscoveryStage, IssueType, RigDeploymentStatus, RigIncidentStatus, RigReadinessStatus, Status } from "@/types";

export interface DamageCategoryMeta {
  category: DamageCategory;
  group: DamageGroup;
  label: string;
}

export const DAMAGE_CATEGORIES: DamageCategoryMeta[] = [
  // physical
  { category: "wire_broken", group: "physical", label: "Wire broken" },
  { category: "cable_frayed", group: "physical", label: "Cable frayed" },
  { category: "connector_damaged", group: "physical", label: "Connector damaged" },
  { category: "connector_loose", group: "physical", label: "Connector loose" },
  { category: "mount_damaged", group: "physical", label: "Mount damaged" },
  { category: "casing_damaged", group: "physical", label: "Casing damaged" },
  { category: "camera_physical_damage", group: "physical", label: "Camera physically damaged" },
  // electrical
  { category: "power_failure", group: "electrical", label: "Power failure" },
  { category: "charging_failure", group: "electrical", label: "Charging failure" },
  { category: "battery_issue", group: "electrical", label: "Battery issue" },
  { category: "overheating", group: "electrical", label: "Overheating" },
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
