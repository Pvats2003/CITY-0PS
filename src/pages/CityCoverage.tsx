import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MapPin, Store, Users, AlertTriangle } from "lucide-react";
import { useCity } from "@/store/city";
import { PageHeader } from "@/components/shared/PageHeader";
import { KpiCard } from "@/components/shared/KpiCard";
import { EmptyState } from "@/components/shared/EmptyState";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { todayISO, fmtDateTime } from "@/lib/dates";
import {
  mappableBusinesses,
  foLastKnownLocations,
  projectPoints,
  cityBusinessStatuses,
  CITY_STATUS_META,
  formatLocationAge,
  type CityBusinessStatus,
} from "@/engine/cityCoverage";

const VIEW_WIDTH = 640;
const VIEW_HEIGHT = 420;
const STATUS_FILTERS: Array<CityBusinessStatus | "all"> = ["all", "assigned", "at_risk", "completed", "unavailable", "unassigned"];

const STATUS_BADGE_VARIANT: Record<CityBusinessStatus, "success" | "warning" | "critical" | "info" | "neutral" | "default"> = {
  assigned: "info",
  at_risk: "warning",
  completed: "success",
  unavailable: "critical",
  unassigned: "neutral",
  unknown: "default",
};

type Selection = { kind: "business"; id: string } | { kind: "fo"; id: string } | null;

/** Manager-only operational map — Phase C ("operational layers"): business
 * markers carry a transparent, evidence-backed status (see
 * engine/cityCoverage.ts's deriveBusinessStatus — every status/reason is
 * traced to a real Assignment/Issue/Business field, never a spreadsheet-
 * only concept), and FOs get their own, visually distinct marker sourced
 * ONLY from their latest valid location Evidence — always labeled "last
 * known location" with a captured-at age, never "live". No marker is ever
 * fabricated: a business without resolvable coordinates, or an FO with no
 * valid location evidence, simply has no marker.
 *
 * No assignment is ever read-written here — every value shown is a pure
 * read via useCity(); there is no mutation path on this page at all. */
export default function CityCoverage() {
  const data = useCity();
  const navigate = useNavigate();
  const today = todayISO();

  const [statusFilter, setStatusFilter] = useState<CityBusinessStatus | "all">("all");
  const [showBusinesses, setShowBusinesses] = useState(true);
  const [showFos, setShowFos] = useState(true);
  const [selection, setSelection] = useState<Selection>(null);

  const statuses = useMemo(() => cityBusinessStatuses(data, today), [data, today]);
  const allMappable = useMemo(() => mappableBusinesses(data.businesses), [data.businesses]);
  const missingLocationCount = data.businesses.length - allMappable.length;

  const visibleBusinesses = useMemo(() => {
    if (!showBusinesses) return [];
    return allMappable.filter((m) => statusFilter === "all" || statuses.get(m.business.id)?.status === statusFilter);
  }, [allMappable, statusFilter, statuses, showBusinesses]);

  const allFoLocations = useMemo(() => foLastKnownLocations(data), [data]);
  const visibleFoLocations = showFos ? allFoLocations : [];
  const foById = useMemo(() => new Map(data.fos.map((f) => [f.id, f])), [data.fos]);
  const bizById = useMemo(() => new Map(data.businesses.map((b) => [b.id, b])), [data.businesses]);

  const points = useMemo(
    () =>
      projectPoints(
        [...visibleBusinesses.map((m) => ({ lat: m.lat, lng: m.lng })), ...visibleFoLocations.map((f) => ({ lat: f.lat, lng: f.lng }))],
        VIEW_WIDTH,
        VIEW_HEIGHT,
      ),
    [visibleBusinesses, visibleFoLocations],
  );
  const businessPoints = points.slice(0, visibleBusinesses.length);
  const foPoints = points.slice(visibleBusinesses.length);

  const statusCounts = useMemo(() => {
    const counts: Record<CityBusinessStatus, number> = { assigned: 0, at_risk: 0, completed: 0, unavailable: 0, unassigned: 0, unknown: 0 };
    for (const result of statuses.values()) counts[result.status]++;
    return counts;
  }, [statuses]);

  const selectedBusiness = selection?.kind === "business" ? bizById.get(selection.id) : undefined;
  const selectedBusinessStatus = selectedBusiness ? statuses.get(selectedBusiness.id) : undefined;
  const selectedFoLocation = selection?.kind === "fo" ? allFoLocations.find((f) => f.foId === selection.id) : undefined;
  const selectedFo = selectedFoLocation ? foById.get(selectedFoLocation.foId) : undefined;
  const selectedFoBusiness = selectedFoLocation?.businessId ? bizById.get(selectedFoLocation.businessId) : undefined;

  return (
    <div className="pb-10">
      <PageHeader title="City Coverage" subtitle="Manager-only operational map of businesses and field officers' last known locations." />

      <div className="px-4 md:px-6 pt-5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard label="Businesses" value={data.businesses.length} icon={Store} />
        <KpiCard label="On Map" value={allMappable.length} icon={MapPin} tone="success" />
        <KpiCard label="Missing Location" value={missingLocationCount} icon={MapPin} tone={missingLocationCount > 0 ? "warning" : "default"} />
        <KpiCard label="At Risk" value={statusCounts.at_risk} icon={AlertTriangle} tone={statusCounts.at_risk > 0 ? "warning" : "default"} />
        <KpiCard label="FOs Located" value={allFoLocations.length} icon={Users} sub={`of ${data.fos.length} field officer${data.fos.length === 1 ? "" : "s"}`} />
      </div>

      <div className="px-4 md:px-6 pt-5 flex flex-wrap items-center justify-between gap-3">
        <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as CityBusinessStatus | "all")}>
          <TabsList>
            {STATUS_FILTERS.map((s) => (
              <TabsTrigger key={s} value={s}>
                {s === "all" ? "All" : CITY_STATUS_META[s].label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-4 text-xs">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <Switch checked={showBusinesses} onCheckedChange={setShowBusinesses} data-testid="toggle-businesses-layer" />
            Businesses
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <Switch checked={showFos} onCheckedChange={setShowFos} data-testid="toggle-fo-layer" />
            Field Officers
          </label>
        </div>
      </div>

      <div className="px-4 md:px-6 pt-4 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        <Card>
          {visibleBusinesses.length === 0 && visibleFoLocations.length === 0 ? (
            <EmptyState
              icon={MapPin}
              title="Nothing to show on the map"
              description="Adjust the filters above, or add a location to a business to place it on the map. City Coverage never invents a marker for a business or field officer that doesn't have one."
            />
          ) : (
            <div className="p-4">
              <svg viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} className="w-full h-auto rounded-md bg-surface-2 border border-border" role="img" aria-label="City Coverage map">
                {visibleBusinesses.map((m, i) => {
                  const p = businessPoints[i];
                  const status = statuses.get(m.business.id);
                  const meta = CITY_STATUS_META[status?.status ?? "unknown"];
                  const isSelected = selection?.kind === "business" && selection.id === m.business.id;
                  return (
                    <g
                      key={m.business.id}
                      data-testid="city-coverage-business-marker"
                      data-business-id={m.business.id}
                      data-coord-source={m.coordSource}
                      data-status={status?.status}
                      role="button"
                      tabIndex={0}
                      aria-label={`${m.business.name} — ${meta.label}`}
                      onClick={() => setSelection({ kind: "business", id: m.business.id })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelection({ kind: "business", id: m.business.id });
                        }
                      }}
                      className="cursor-pointer outline-none"
                    >
                      <title>{`${m.business.name} — ${meta.label}`}</title>
                      <circle cx={p.x} cy={p.y} r={isSelected ? 8 : 6} className={cn(meta.dot.replace("bg-", "fill-"), "stroke-surface")} strokeWidth={isSelected ? 2.5 : 1.5} />
                    </g>
                  );
                })}
                {visibleFoLocations.map((f, i) => {
                  const p = foPoints[i];
                  const fo = foById.get(f.foId);
                  const isSelected = selection?.kind === "fo" && selection.id === f.foId;
                  const half = isSelected ? 7 : 5;
                  return (
                    <g
                      key={f.foId}
                      data-testid="city-coverage-fo-marker"
                      data-fo-id={f.foId}
                      role="button"
                      tabIndex={0}
                      aria-label={`${fo?.name ?? "Field Officer"} — last known location`}
                      onClick={() => setSelection({ kind: "fo", id: f.foId })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelection({ kind: "fo", id: f.foId });
                        }
                      }}
                      className="cursor-pointer outline-none"
                    >
                      <title>{`${fo?.name ?? "Field Officer"} — last known location`}</title>
                      {/* A rotated square (diamond), never a circle — keeps FO
                          markers unambiguously distinct from business
                          markers by shape, not color alone. */}
                      <rect x={p.x - half} y={p.y - half} width={half * 2} height={half * 2} transform={`rotate(45 ${p.x} ${p.y})`} className="fill-primary stroke-surface" strokeWidth={isSelected ? 2.5 : 1.5} />
                    </g>
                  );
                })}
              </svg>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-3 text-xs text-muted" data-testid="city-coverage-legend">
                {(Object.keys(CITY_STATUS_META) as CityBusinessStatus[])
                  .filter((s) => s !== "unknown")
                  .map((s) => (
                    <span key={s} className="flex items-center gap-1.5">
                      <span className={cn("inline-block size-2.5 rounded-full", CITY_STATUS_META[s].dot)} />
                      {CITY_STATUS_META[s].label}
                    </span>
                  ))}
                <span className="flex items-center gap-1.5">
                  <span className="inline-block size-2 bg-primary" style={{ transform: "rotate(45deg)" }} />
                  Field Officer (last known location)
                </span>
              </div>
              <div className="text-xs text-muted mt-2">
                {visibleBusinesses.length} business{visibleBusinesses.length === 1 ? "" : "es"} · {visibleFoLocations.length} field officer{visibleFoLocations.length === 1 ? "" : "s"} shown — straight-line
                positions only, not a routed street map.
              </div>
            </div>
          )}
        </Card>

        <Card>
          <div className="p-4">
            {!selection && <div className="text-sm text-muted">Select a marker to see details.</div>}

            {selectedBusiness && selectedBusinessStatus && (
              <div className="space-y-3" data-testid="city-coverage-business-detail">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm font-semibold">{selectedBusiness.name}</div>
                  <Badge variant={STATUS_BADGE_VARIANT[selectedBusinessStatus.status]}>{CITY_STATUS_META[selectedBusinessStatus.status].label}</Badge>
                </div>
                {(selectedBusiness.area || selectedBusiness.address) && (
                  <div className="text-xs text-muted">{[selectedBusiness.area, selectedBusiness.address].filter(Boolean).join(" · ")}</div>
                )}
                {selectedBusiness.category && <div className="text-xs text-muted">{selectedBusiness.category}</div>}
                {selectedBusinessStatus.reason && <div className="text-xs">{selectedBusinessStatus.reason}</div>}
                <div className="grid grid-cols-2 gap-2 text-xs pt-1 border-t border-border">
                  <div>
                    <div className="text-muted">Rigs today</div>
                    <div className="font-medium tabular-nums">{selectedBusinessStatus.rigCount}</div>
                  </div>
                  <div>
                    <div className="text-muted">Assignments today</div>
                    <div className="font-medium tabular-nums">{selectedBusinessStatus.assignmentIds.length}</div>
                  </div>
                  {selectedBusinessStatus.targetHours > 0 && (
                    <>
                      <div>
                        <div className="text-muted">Target hours</div>
                        <div className="font-medium tabular-nums">{selectedBusinessStatus.targetHours}h</div>
                      </div>
                      <div>
                        <div className="text-muted">Recorded</div>
                        <div className="font-medium tabular-nums">{selectedBusinessStatus.recordedHours.toFixed(1)}h</div>
                      </div>
                    </>
                  )}
                </div>
                <Button size="sm" variant="secondary" onClick={() => navigate(`/businesses/${selectedBusiness.id}`)}>
                  Open Business 360
                </Button>
              </div>
            )}

            {selectedFo && selectedFoLocation && (
              <div className="space-y-3" data-testid="city-coverage-fo-detail">
                <div className="text-sm font-semibold">{selectedFo.name}</div>
                <div>
                  <div className="text-xs font-medium text-muted">Last known location</div>
                  <div className="text-xs mt-0.5">
                    {fmtDateTime(selectedFoLocation.capturedAt)} · {formatLocationAge(selectedFoLocation.capturedAt)}
                  </div>
                </div>
                {selectedFoBusiness && <div className="text-xs text-muted">Recorded near {selectedFoBusiness.name}</div>}
                <Button size="sm" variant="secondary" onClick={() => navigate(`/field-officers/${selectedFo.id}`)}>
                  Open FO profile
                </Button>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
