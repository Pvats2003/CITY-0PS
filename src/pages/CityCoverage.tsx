import { useMemo, useState } from "react";
import { MapPin, Store } from "lucide-react";
import { useCity } from "@/store/city";
import { PageHeader } from "@/components/shared/PageHeader";
import { KpiCard } from "@/components/shared/KpiCard";
import { EmptyState } from "@/components/shared/EmptyState";
import { Card } from "@/components/ui/card";
import { mappableBusinesses, projectPoints } from "@/engine/cityCoverage";

const VIEW_WIDTH = 640;
const VIEW_HEIGHT = 420;

/** Manager-only operational map — Phase B ("City Coverage engine + map
 * skeleton"): plain, neutral markers proving the coordinate-resolution and
 * projection pipeline (see engine/cityCoverage.ts), positioned by real
 * business coordinates only. Status-colored markers, the FO location
 * layer, the selected-business detail panel, and filters are deliberately
 * NOT part of this phase — see the phased plan this feature is being built
 * under. Gated Manager-only purely by mounting inside ManagerApp.tsx,
 * which itself only renders under RequireRole("MANAGER") — no separate
 * gating mechanism invented here. */
export default function CityCoverage() {
  const data = useCity();
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const mappable = useMemo(() => mappableBusinesses(data.businesses), [data.businesses]);
  const missingLocationCount = data.businesses.length - mappable.length;

  const points = useMemo(() => projectPoints(mappable, VIEW_WIDTH, VIEW_HEIGHT), [mappable]);

  return (
    <div className="pb-10">
      <PageHeader title="City Coverage" subtitle="Manager-only operational map of businesses and their known locations." />

      <div className="px-4 md:px-6 pt-5 grid grid-cols-2 sm:grid-cols-3 gap-3">
        <KpiCard label="Businesses" value={data.businesses.length} icon={Store} />
        <KpiCard label="On Map" value={mappable.length} icon={MapPin} tone="success" />
        <KpiCard
          label="Missing Location"
          value={missingLocationCount}
          icon={MapPin}
          tone={missingLocationCount > 0 ? "warning" : "default"}
          sub={missingLocationCount > 0 ? "No coordinates or Maps link on file" : undefined}
        />
      </div>

      <div className="px-4 md:px-6 pt-5">
        <Card>
          {mappable.length === 0 ? (
            <EmptyState
              icon={MapPin}
              title="No mappable business locations yet"
              description="Add a Google Maps link or coordinates to a business to place it on the map. City Coverage never invents a location for a business that doesn't have one."
            />
          ) : (
            <div className="p-4">
              <svg
                viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
                className="w-full h-auto rounded-md bg-surface-2 border border-border"
                role="img"
                aria-label="City Coverage map"
              >
                {mappable.map((m, i) => {
                  const p = points[i];
                  const hovered = hoveredId === m.business.id;
                  return (
                    <g
                      key={m.business.id}
                      data-testid="city-coverage-marker"
                      data-business-id={m.business.id}
                      data-coord-source={m.coordSource}
                      onMouseEnter={() => setHoveredId(m.business.id)}
                      onMouseLeave={() => setHoveredId((cur) => (cur === m.business.id ? null : cur))}
                    >
                      <title>{m.business.name}</title>
                      <circle cx={p.x} cy={p.y} r={hovered ? 7 : 5} className="fill-primary stroke-surface" strokeWidth={1.5} />
                    </g>
                  );
                })}
              </svg>
              <div className="text-xs text-muted mt-2">
                {mappable.length} of {data.businesses.length} business{data.businesses.length === 1 ? "" : "es"} shown — straight-line positions only, not a routed street map.
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
