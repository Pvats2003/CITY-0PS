/** Accepts the normal shapes a user pastes from Google Maps: a full
 * google.com/maps (or www.google.com/maps) link, a maps.google.com link, or
 * a Google Maps share link (maps.app.goo.gl). Deliberately not stricter than
 * that — no query-param shape, no lat/lng requirement — since the whole
 * point is to take whatever the user's Maps app actually hands them when
 * they hit Share. Not a Google Maps API call: this only inspects the URL's
 * own hostname/path, so it costs nothing and needs no API key. */
export function isGoogleMapsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "maps.app.goo.gl") return true;
  if (host === "maps.google.com" || host.endsWith(".maps.google.com")) return true;
  if ((host === "google.com" || host === "www.google.com" || host.endsWith(".google.com")) && url.pathname.startsWith("/maps")) return true;
  return false;
}

/** The link to actually open for a business: the Manager's own pasted
 * Google Maps URL when set, falling back to a generated maps search link
 * from lat/lng for older/demo records that predate googleMapsUrl. Returns
 * undefined when neither is available — callers hide the "Open in Maps"
 * action entirely rather than show a dead link. */
export function businessMapsUrl(business: { googleMapsUrl?: string; lat?: number; lng?: number }): string | undefined {
  if (business.googleMapsUrl) return business.googleMapsUrl;
  if (business.lat != null && business.lng != null) {
    return `https://www.google.com/maps/search/?api=1&query=${business.lat},${business.lng}`;
  }
  return undefined;
}

/** Parses a literal lat/lng pair out of a Google Maps URL, when the URL
 * itself already embeds one — the two shapes Google's own "Share" flow
 * actually produces: "...maps?q=<lat>,<lng>" and ".../@<lat>,<lng>,<zoom>z"
 * (the second also matches inside a longer "/maps/place/.../@lat,lng,17z"
 * path). Deliberately does NOT resolve a maps.app.goo.gl short link (that
 * only reveals its target via a redirect — a network call this stays free
 * of) and does NOT attempt to geocode a place-name search URL — either
 * case returns undefined rather than a guess. Coordinates are also range-
 * validated (|lat|<=90, |lng|<=180) so a URL segment that merely looks
 * numeric (e.g. a zoom level) can't be mistaken for one. */
export function parseCoordinatesFromMapsUrl(url: string): { lat: number; lng: number } | undefined {
  const COORD_PATTERNS = [/[?&]q=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/, /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/];
  for (const pattern of COORD_PATTERNS) {
    const match = url.match(pattern);
    if (!match) continue;
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng };
    }
  }
  return undefined;
}

/** The single, deterministic way to resolve a business's real-world
 * coordinates for geographic features (City Coverage's map, backup
 * distance ranking): prefers the explicit lat/lng fields, then falls back
 * to a literal-coordinate parse of a pasted googleMapsUrl. Returns
 * undefined — never a fabricated or geocoded value — when neither source
 * carries a real coordinate pair (e.g. a maps.app.goo.gl short link, a
 * place-name search URL, or no location info at all). Callers must treat
 * undefined as "no marker for this business," never substitute a guess. */
export function resolveBusinessCoordinates(business: {
  lat?: number;
  lng?: number;
  googleMapsUrl?: string;
}): { lat: number; lng: number; source: "business" | "maps_url" } | undefined {
  if (business.lat != null && business.lng != null) return { lat: business.lat, lng: business.lng, source: "business" };
  if (business.googleMapsUrl) {
    const parsed = parseCoordinatesFromMapsUrl(business.googleMapsUrl);
    if (parsed) return { ...parsed, source: "maps_url" };
  }
  return undefined;
}
