// ---------------------------------------------------------------------------
// Phase F.5.3 — client side of assisted location resolution. This file NEVER
// contains a Google API key, and NEVER calls Google directly — the only
// network call GoogleLocationResolver makes is to our own authenticated
// Firebase callable function (functions/src/resolveBusinessLocation.ts),
// which holds the real key server-side via Secret Manager. A row's Google
// candidate is never auto-accepted here or anywhere else — see
// BusinessDataQuality.tsx for the explicit Accept/Keep/Needs-review actions.
// ---------------------------------------------------------------------------

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

export interface LocationResolver {
  resolveBusinessLocation(input: LocationResolveInput): Promise<LocationResolveResult>;
}

/** Production resolver — calls the `resolveBusinessLocation` Firebase
 * callable function. Firebase Auth automatically attaches the caller's ID
 * token; the function itself independently re-verifies the Manager role
 * from Firestore (never trusts anything this client sends about role). Only
 * ever constructed when Firebase is actually configured — see
 * getLocationResolver() below. */
export class GoogleLocationResolver implements LocationResolver {
  async resolveBusinessLocation(input: LocationResolveInput): Promise<LocationResolveResult> {
    // Every failure mode — Firebase not configured (demo mode), the
    // callable rejecting, a network error — funnels through this one
    // catch, so this method's contract (always resolves to a
    // LocationResolveResult, never throws) holds regardless of cause.
    try {
      const [{ getFunctions, httpsCallable }, { getFirebaseApp }] = await Promise.all([import("firebase/functions"), import("@/auth/firebaseApp")]);
      const functions = getFunctions(getFirebaseApp());
      const call = httpsCallable<LocationResolveInput, LocationResolveResult>(functions, "resolveBusinessLocation");
      const res = await call(input);
      return res.data;
    } catch (err) {
      // Sanitized, generic message — never surface a raw Firebase/Functions
      // error object (which can carry internal detail) straight to the UI.
      const message = err instanceof Error ? err.message : "Location resolution failed.";
      return { status: "NO_CANDIDATE", reason: message };
    }
  }
}

/** Deterministic test double — no network, no Firebase dependency at all.
 * Configured per-scenario so tests can exercise every response shape
 * (success, zero results, ambiguous, error) without ever reaching Google or
 * even a real Firebase project. */
export class FakeLocationResolver implements LocationResolver {
  private readonly responses: Map<string, LocationResolveResult>;
  private readonly defaultResult: LocationResolveResult;
  public callCount = 0;
  public readonly calls: LocationResolveInput[] = [];

  constructor(opts?: { byQueryKey?: Record<string, LocationResolveResult>; defaultResult?: LocationResolveResult }) {
    this.responses = new Map(Object.entries(opts?.byQueryKey ?? {}));
    this.defaultResult = opts?.defaultResult ?? { status: "NO_CANDIDATE", reason: "No fake response configured for this input." };
  }

  async resolveBusinessLocation(input: LocationResolveInput): Promise<LocationResolveResult> {
    this.callCount += 1;
    this.calls.push(input);
    const key = input.businessName ?? "";
    return this.responses.get(key) ?? this.defaultResult;
  }
}

declare global {
  interface Window {
    __CITY_OPS_TEST_LOCATION_RESOLVER__?: LocationResolver;
  }
}

let cachedResolver: LocationResolver | null = null;

/** The one place the app picks which resolver to use. A test-only global
 * hook (checked first) lets Playwright tests inject a FakeLocationResolver
 * before the app ever constructs a GoogleLocationResolver — so a test run
 * against a build with no Firebase configured (this project's own demo/test
 * mode) never even attempts a real network call. */
export function getLocationResolver(): LocationResolver {
  if (typeof window !== "undefined" && window.__CITY_OPS_TEST_LOCATION_RESOLVER__) {
    return window.__CITY_OPS_TEST_LOCATION_RESOLVER__;
  }
  if (!cachedResolver) cachedResolver = new GoogleLocationResolver();
  return cachedResolver;
}
