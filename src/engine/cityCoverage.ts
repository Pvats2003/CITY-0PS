import type { Business, CityData } from "@/types";
import { resolveBusinessCoordinates } from "@/lib/googleMaps";

// ---------------------------------------------------------------------------
// City Coverage — Phase B: pure derivation of map-ready geography from
// existing collections. Nothing here is persisted; every function is a
// deterministic read of already-known data, exactly like engine/insights.ts
// and engine/attention.ts. See src/lib/googleMaps.ts's
// resolveBusinessCoordinates for the coordinate precedence (Business.lat/lng,
// then a literal-coordinate googleMapsUrl) and its no-fabrication guarantee.
// ---------------------------------------------------------------------------

/** A business with a real, resolved coordinate pair. */
export interface MappableBusiness {
  business: Business;
  lat: number;
  lng: number;
  coordSource: "business" | "maps_url";
}

/** Every business with a resolvable coordinate pair — the sole feed for
 * City Coverage's map. A business without one (no lat/lng, no
 * googleMapsUrl, or a googleMapsUrl that doesn't literally carry
 * coordinates — e.g. a maps.app.goo.gl short link or a place-name search)
 * is simply omitted, never given a fabricated marker. Callers that need
 * the omitted count should compare `businesses.length` against this
 * array's length. */
export function mappableBusinesses(businesses: Business[]): MappableBusiness[] {
  const out: MappableBusiness[] = [];
  for (const business of businesses) {
    const coords = resolveBusinessCoordinates(business);
    if (coords) out.push({ business, lat: coords.lat, lng: coords.lng, coordSource: coords.source });
  }
  return out;
}

/** An FO's most recently recorded real-world position — derived from the
 * latest Evidence record that actually carries lat/lng (set only on
 * location-capturing evidence, at the moment an FO checked in — see
 * engine/workflows.ts's checkInAssignment). This is a single point-in-time
 * fact read from the FO's own evidence history, never a live GPS stream:
 * every caller must display it alongside capturedAt, never imply the FO is
 * there right now. */
export interface FoLastKnownLocation {
  foId: string;
  lat: number;
  lng: number;
  capturedAt: string;
  businessId?: string;
}

export function foLastKnownLocations(data: CityData): FoLastKnownLocation[] {
  const latestByFo = new Map<string, FoLastKnownLocation>();
  for (const evidence of data.evidence) {
    if (evidence.lat == null || evidence.lng == null) continue;
    const capturedAt = evidence.capturedAt ?? evidence.startedAt;
    if (!capturedAt) continue;
    const existing = latestByFo.get(evidence.foId);
    if (!existing || new Date(capturedAt).getTime() > new Date(existing.capturedAt).getTime()) {
      latestByFo.set(evidence.foId, { foId: evidence.foId, lat: evidence.lat, lng: evidence.lng, capturedAt, businessId: evidence.businessId });
    }
  }
  return [...latestByFo.values()];
}

export interface ProjectedPoint {
  x: number;
  y: number;
}

/** Plain equirectangular projection of lat/lng points into an SVG
 * viewBox — appropriate at city scale (a few km across), where the
 * curvature a Mercator-style projection corrects for is negligible, and
 * far simpler than pulling in a mapping library for it. Pads the bounding
 * box so edge markers aren't clipped, and falls back to centering every
 * point when the input's lat/lng span is (near) zero — a single-business
 * city, or every business sharing one coordinate — rather than dividing
 * by zero. Screen y grows downward while latitude grows northward, so the
 * y axis is flipped. */
export function projectPoints(points: { lat: number; lng: number }[], width: number, height: number, paddingPx = 24): ProjectedPoint[] {
  if (points.length === 0) return [];
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latSpan = maxLat - minLat;
  const lngSpan = maxLng - minLng;
  const innerW = Math.max(width - paddingPx * 2, 1);
  const innerH = Math.max(height - paddingPx * 2, 1);
  return points.map((p) => ({
    x: latSpan === 0 && lngSpan === 0 ? width / 2 : paddingPx + ((p.lng - minLng) / (lngSpan || 1)) * innerW,
    y: latSpan === 0 && lngSpan === 0 ? height / 2 : paddingPx + (1 - (p.lat - minLat) / (latSpan || 1)) * innerH,
  }));
}
