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
