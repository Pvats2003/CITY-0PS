/** Accumulates the AUTHORITATIVE set of fields an FO's own workflow
 * actions actually intended to change on one record, keyed by
 * `${collection}:${id}` — traced from the exact `patch` argument each
 * mutator action (store/city.ts's updateAssignment()/updateRigIncident())
 * receives, NEVER inferred by diffing before/after store snapshots.
 *
 * Snapshot diffing was rejected deliberately: it can't tell an FO's own
 * intentional field change apart from an UNRELATED field that simply
 * drifted between the FO's locally-cached copy and the live server
 * document (e.g. a Manager changing `priority` or `reviewStatus`
 * server-side while the FO's stale local snapshot still carries the old
 * value) — and firestore.rules' assignments/rigIncidents update grants are
 * field-scoped (affectedKeys().hasOnly([...])), so an unrelated drifted
 * field showing up in the diff denies the WHOLE write, even though every
 * field the FO actually meant to change is allowed. Tracing the literal
 * mutation call's own patch object sidesteps this entirely: it can never
 * contain a field the app's own code didn't explicitly set.
 *
 * Patches ACCUMULATE (merge) across multiple local mutations to the same
 * record that happen before syncEngine.ts's local watcher gets a chance to
 * consume and durably enqueue them — e.g. markEnRoute() followed moments
 * later by checkInAssignment() on the same assignment must not lose
 * enRouteAt when actualArrivalAt is added; enqueue() is async, so this
 * window is real, not theoretical. A field is only ever removed by
 * clearPatchFields(), and only for the exact fields a specific enqueue()
 * call actually attempted — never the whole entry — so a field added to
 * the SAME record after peekPatch() was read but before that enqueue()
 * resolves (a genuine concurrent mutation) is never silently dropped,
 * regardless of which of two in-flight enqueue() calls resolves first. */

const pending = new Map<string, Record<string, unknown>>();

function key(collection: string, id: string): string {
  return `${collection}:${id}`;
}

export function recordPatch(collection: string, id: string, patch: Record<string, unknown>): void {
  const k = key(collection, id);
  pending.set(k, { ...(pending.get(k) ?? {}), ...patch });
}

/** Read-only — does not clear anything. Used to build the outbox payload
 * before attempting enqueue(); the fields are only removed afterward, by
 * clearPatchFields(), and only once that specific enqueue() succeeds. */
export function peekPatch(collection: string, id: string): Record<string, unknown> | undefined {
  return pending.get(key(collection, id));
}

/** Removes exactly the fields present in `enqueued` from the pending
 * patch for this record — not the whole entry — so a field recorded by a
 * NEWER mutation after `enqueued` was peeked (but before this call) is
 * preserved for the next attempt. Safe to call with a patch that no
 * longer matches what's pending (e.g. another concurrent call already
 * cleared some of the same fields) — only intersects with whatever is
 * actually still there. */
export function clearPatchFields(collection: string, id: string, enqueued: Record<string, unknown>): void {
  const k = key(collection, id);
  const current = pending.get(k);
  if (!current) return;
  const remaining: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(current)) {
    if (!(field in enqueued)) remaining[field] = value;
  }
  if (Object.keys(remaining).length > 0) pending.set(k, remaining);
  else pending.delete(k);
}

/** Test/reset seam only — resetSyncEngine() does NOT call this (see its
 * own comment: a signed-out account's not-yet-enqueued field intentions
 * are still real, pending writes that should still be attempted the next
 * time the engine starts, exactly like the durable syncedEvidenceOnceIds
 * record is deliberately preserved across a reset). Exists so tests can
 * start from a clean slate between scenarios. */
export function clearAllPatchesForTest(): void {
  pending.clear();
}
