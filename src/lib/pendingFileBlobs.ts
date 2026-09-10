import { get, set, del } from "idb-keyval";

// Durable — an IndexedDB-backed handoff for a raw File selected via
// <input type="file">, not an in-memory Map (see git history for the
// prior implementation and why it was unsafe).
//
// A raw File is only ever available at selection time; by the time
// engine/workflows.ts's captureEvidence() runs, the calling component has
// already reduced it to {id, name, type, sizeBytes, localUrl}. The GAP
// between "photo picked" (stashPendingFile) and "evidence step submitted"
// (takePendingFile) is not instantaneous — a Field Officer typically
// picks several photos across a step before tapping Submit, and each
// <input capture="environment"> tap can hand off to the device's native
// camera app, backgrounding this tab. A backgrounded mobile tab can be
// reclaimed by the OS at any point in that gap. A plain in-memory Map
// does not survive that — and unlike "an in-progress, not-yet-submitted
// capture form" (which is fine to lose), by the time captureEvidence()
// needs this file, the Evidence record has ALREADY been created and
// marked status:"submitted" (a committed, persisted, terminal state) —
// losing the raw bytes at that point is real, unrecoverable evidence
// loss, not a cosmetic inconvenience. IndexedDB survives a tab reload or
// OS-triggered reclaim; a JS module-level variable does not.
const KEY_PREFIX = "pendingFile:";

export async function stashPendingFile(fileId: string, file: File): Promise<void> {
  await set(`${KEY_PREFIX}${fileId}`, file);
}

/** Retrieves and removes — a file is consumed at most once. */
export async function takePendingFile(fileId: string): Promise<File | undefined> {
  const file = (await get(`${KEY_PREFIX}${fileId}`)) as File | undefined;
  if (file !== undefined) await del(`${KEY_PREFIX}${fileId}`);
  return file;
}
