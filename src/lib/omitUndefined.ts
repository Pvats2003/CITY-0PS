/** Firestore's setDoc() rejects any document containing an explicit
 * `undefined` field value, client-side, before the write ever reaches the
 * network — the exact mechanism that lost production assignment
 * asg_vz30htm7a2 (see AssignmentFormDialog.tsx). A blank optional form
 * field constructed as `field: value || undefined` produces exactly that:
 * a real, enumerable property whose value happens to be `undefined`, not
 * an absent one.
 *
 * Wrap any object about to reach an addX()/updateX() store action (which
 * feeds the outbox, which feeds putDoc()) with this before the call — it
 * strips exactly those keys (recursively, since a nested object such as a
 * report's `data` payload can carry the same problem) and changes nothing
 * else. Deliberately NOT a global `ignoreUndefinedProperties` setting:
 * malformed data should keep failing loudly if this helper is ever
 * bypassed, not be silently coerced everywhere. */
export function omitUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => omitUndefined(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const result: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) result[key] = omitUndefined(v);
    }
    return result as T;
  }
  return value;
}
