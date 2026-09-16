// Mirrors src/lib/locationResolver.ts's LocationCandidate/LocationInput shape
// on the client. Deliberately duplicated rather than shared: this is a
// separate Node project (its own package.json/tsconfig, never bundled into
// the Vite client), and the boundary between "what the browser sends" and
// "what this function returns" is exactly the contract worth keeping
// explicit and independently readable on both sides, rather than reaching
// across a build boundary for a handful of field names.

export interface LocationResolveInput {
  businessName?: string;
  address?: string;
  city?: string;
  area?: string;
  state?: string;
  country?: string;
  existingLat?: number;
  existingLng?: number;
  mapsUrl?: string;
}

export interface LocationCandidate {
  source: "google_geocoding";
  requestedQuery: string;
  lat: number;
  lng: number;
  formattedAddress?: string;
  placeId?: string;
  resultType?: string;
  apiStatus: string;
  requestedAt: string;
  distanceFromSpreadsheetCoordsMeters?: number;
}

export interface LocationResolveResult {
  candidate?: LocationCandidate;
  status: "READY_FOR_REVIEW" | "NEEDS_REVIEW" | "NO_CANDIDATE";
  reason?: string;
}
