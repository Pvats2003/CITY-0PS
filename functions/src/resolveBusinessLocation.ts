import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getFirestore } from "firebase-admin/firestore";
import type { LocationCandidate, LocationResolveInput, LocationResolveResult } from "./types";

// ---------------------------------------------------------------------------
// Phase F.5.3 — resolveBusinessLocation: the ONLY place in this project that
// ever calls Google Maps Platform, and the ONLY place the Geocoding API key
// exists. Server-side only (Firebase Functions v2, callable). Never writes
// Firestore, never returns the API key, never logs it or the full request
// URL (which would contain it as a query parameter). One request resolves
// exactly one business row — no batch endpoint, no arbitrary Google URL
// forwarding, no client-controlled endpoint.
// ---------------------------------------------------------------------------

const GOOGLE_MAPS_API_KEY = defineSecret("GOOGLE_MAPS_API_KEY");

const REQUEST_TIMEOUT_MS = 8000;

/** Same formula as src/engine/execution.ts's haversineMeters — duplicated
 * rather than shared across the client/server build boundary (see types.ts
 * for why). */
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

function isBlank(s: string | undefined): boolean {
  return s == null || s.trim() === "";
}

/** Deterministic, address-shaped query — never invents a missing component.
 * Business Code is never a valid input here (the caller-side type doesn't
 * even carry one) — only real geographic/identity fields. */
function buildQuery(input: LocationResolveInput): string {
  const parts = [input.businessName, input.address, !isBlank(input.city) ? input.city : input.area, input.state, input.country ?? "India"]
    .map((p) => p?.trim())
    .filter((p): p is string => !isBlank(p));
  return parts.join(", ");
}

interface GeocodeApiResult {
  formatted_address?: string;
  place_id?: string;
  partial_match?: boolean;
  geometry?: { location?: { lat: number; lng: number }; location_type?: string };
  types?: string[];
}
interface GeocodeApiResponse {
  status: string;
  results?: GeocodeApiResult[];
  error_message?: string;
}

async function callGeocodingApi(query: string, apiKey: string): Promise<GeocodeApiResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, { signal: controller.signal });
    // Never log `url` (it carries the API key as a query parameter) — only
    // the safe, key-free query text and the resulting HTTP status.
    if (!res.ok) {
      throw new HttpsError("unavailable", `Geocoding service returned HTTP ${res.status}.`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new HttpsError("internal", "Received a malformed response from the geocoding service.");
    }
    if (typeof body !== "object" || body === null || !("status" in body)) {
      throw new HttpsError("internal", "Received a malformed response from the geocoding service.");
    }
    return body as GeocodeApiResponse;
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new HttpsError("deadline-exceeded", "Geocoding request timed out.");
    }
    throw new HttpsError("unavailable", "Could not reach the geocoding service.");
  } finally {
    clearTimeout(timeout);
  }
}

export const resolveBusinessLocation = onCall<LocationResolveInput, Promise<LocationResolveResult>>(
  { secrets: [GOOGLE_MAPS_API_KEY], timeoutSeconds: 20, memory: "256MiB" },
  async (request): Promise<LocationResolveResult> => {
    // 1. Authentication — never trust a client-provided role.
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign-in required.");
    }
    const uid = request.auth.uid;

    // 2. Authorization — read the SAME users/{uid} doc firestore.rules'
    // isManager() reads, via the Admin SDK (which bypasses rules by design,
    // exactly like every other Cloud Function). A Field Officer's own
    // request.auth is valid and authenticated, but is rejected here purely
    // on role, matching the app's existing Manager-only gate on this
    // workflow — see src/auth/RequireRole.tsx for the client-side mirror
    // (which is a UX convenience only; THIS check is the real one).
    const userDoc = await getFirestore().collection("users").doc(uid).get();
    const role = userDoc.exists ? (userDoc.data()?.role as string | undefined) : undefined;
    if (role !== "MANAGER") {
      throw new HttpsError("permission-denied", "Manager role required.");
    }

    // 3. Input validation — reject empty/meaningless queries. No arbitrary
    // Google endpoint or URL is ever accepted from the client.
    const input = request.data ?? {};
    const query = buildQuery(input);
    if (isBlank(query)) {
      throw new HttpsError("invalid-argument", "No usable business name, address, or city was provided.");
    }

    const apiKey = GOOGLE_MAPS_API_KEY.value();
    const requestedAt = new Date().toISOString();
    const response = await callGeocodingApi(query, apiKey);

    if (response.status === "ZERO_RESULTS") {
      return { status: "NO_CANDIDATE", reason: "Google returned no results for this query." };
    }
    if (response.status === "OVER_QUERY_LIMIT") {
      throw new HttpsError("resource-exhausted", "Google Geocoding quota exceeded — try again later.");
    }
    if (response.status === "REQUEST_DENIED") {
      // Never surface Google's own denial detail (it can include billing/
      // key configuration hints) — a Manager doesn't need it, and it must
      // never appear in a client-visible error.
      throw new HttpsError("failed-precondition", "The geocoding service rejected this request.");
    }
    if (response.status === "INVALID_REQUEST") {
      throw new HttpsError("invalid-argument", "Malformed geocoding request.");
    }
    if (response.status !== "OK" || !response.results || response.results.length === 0) {
      throw new HttpsError("internal", "Geocoding service returned an unexpected response.");
    }

    const results = response.results;
    const top = results[0]!;
    const loc = top.geometry?.location;
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng) || Math.abs(loc.lat) > 90 || Math.abs(loc.lng) > 180) {
      return { status: "NO_CANDIDATE", reason: "Google's result had no usable coordinate." };
    }

    const candidate: LocationCandidate = {
      source: "google_geocoding",
      requestedQuery: query,
      lat: loc.lat,
      lng: loc.lng,
      formattedAddress: top.formatted_address,
      placeId: top.place_id,
      resultType: top.types?.join(", "),
      apiStatus: response.status,
      requestedAt,
      ...(input.existingLat != null && input.existingLng != null ? { distanceFromSpreadsheetCoordsMeters: haversineMeters(input.existingLat, input.existingLng, loc.lat, loc.lng) } : {}),
    };

    // Never auto-accept: multiple plausible matches, a partial match, or a
    // low-precision (APPROXIMATE) location type all mean the Manager must
    // look at this one, not that the API "succeeded".
    const ambiguous = results.length > 1 || top.partial_match === true || top.geometry?.location_type === "APPROXIMATE";
    return { candidate, status: ambiguous ? "NEEDS_REVIEW" : "READY_FOR_REVIEW", reason: ambiguous ? (results.length > 1 ? "Google returned multiple plausible matches." : "Google flagged this as a partial or low-precision match.") : undefined };
  },
);
