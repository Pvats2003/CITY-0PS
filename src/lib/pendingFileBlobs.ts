// A raw File selected via <input type="file"> is only ever available at
// selection time — by the time an EvidenceFile's metadata reaches
// engine/workflows.ts's captureEvidence(), the component that picked it has
// already reduced it to {id, name, type, sizeBytes, localUrl}. This
// transient, same-tab cache is how the real File reaches captureEvidence()
// so it can be queued for Storage upload — it never needs to survive a
// reload (an in-progress, not-yet-submitted capture form is already lost on
// reload today, an unrelated and unchanged property of this UI).
const cache = new Map<string, File>();

export function stashPendingFile(fileId: string, file: File): void {
  cache.set(fileId, file);
}

/** Retrieves and removes — a file is consumed at most once. */
export function takePendingFile(fileId: string): File | undefined {
  const file = cache.get(fileId);
  cache.delete(fileId);
  return file;
}
