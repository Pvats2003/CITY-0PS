import type { Assignment } from "@/types";

/** The fields that make two Assignment objects "the same real-world visit"
 * — deliberately exactly the six fields this round's spec names, no more,
 * no less. status/collectorId/priority/notes/etc. are NOT part of the
 * identity: editing one of those on an existing assignment is a normal
 * update, not a new visit. */
export type AssignmentIdentity = Pick<Assignment, "businessId" | "foId" | "date" | "plannedStart" | "plannedEnd" | "rigId">;

/** A stable string form of the identity. Missing rigId is folded into an
 * explicit "none" placeholder (never left out of the join) so two rig-less
 * requests for the same business/FO/time dedupe against each other, while
 * still being a DIFFERENT identity from a request that does have a rig —
 * rigId is part of the identity by explicit requirement (a rig swap must
 * never collapse into the assignment it's replacing). */
export function assignmentIdentityKey(a: AssignmentIdentity): string {
  return [a.businessId, a.foId, a.date, a.plannedStart, a.plannedEnd, a.rigId ?? "none"].join("|");
}

/** Deterministic, synchronous, dependency-free 64-bit string hash (a
 * standard two-lane variant of djb2/xor-mix, not Web Crypto's
 * subtle.digest — that's async, which would force every caller, including
 * Immer's synchronous `set()` producers in store/city.ts, to become async
 * for no real benefit). This doesn't need to be cryptographically secure,
 * only STABLE — same input produces the same output on every platform,
 * every time — and collision-resistant enough for one city's assignment
 * volume. Two lanes (h1/h2) mixed together keep the practical collision
 * risk negligible at this scale without pulling in a hashing library. */
function stableHash(input: string): string {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

/** THE single, reusable source of truth for "what id should this logical
 * assignment persist as" — a pure, deterministic function of the identity
 * fields alone, with no randomness and no read-before-write. Calling it
 * any number of times, from any number of concurrent callers, tabs, or
 * devices, for the SAME logical visit always returns the SAME id.
 *
 * That determinism is what makes it safe under concurrency in a way a
 * "query for an existing match, then mint a random id if none is found"
 * strategy structurally cannot be: a query-then-create has a real
 * check-then-act race window (two callers can both observe "nothing
 * exists yet" and both create). A deterministic id has no such window —
 * there is nothing to observe. Two callers racing to persist the same
 * visit both compute the identical id and both end up writing (via
 * firebaseBackend.ts's setDoc(..., {merge:true})) to the SAME document;
 * Firestore serializes concurrent writes to one document server-side, so
 * this can never produce two documents, no matter how the two writes
 * interleave.
 *
 * Existing production assignments keep their original random `asg_*`
 * (nanoid) ids untouched — this function only decides the id for a NEW
 * write. Every existing lookup/update/cancel/session-link path already
 * operates purely by whatever id a record carries, so a mix of old random
 * ids and new deterministic ones coexists with zero special-casing
 * anywhere else in the app. */
export function deriveAssignmentId(a: AssignmentIdentity): string {
  return `asg_${stableHash(assignmentIdentityKey(a))}`;
}
