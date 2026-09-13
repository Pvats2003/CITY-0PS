import { useEffect, useState } from "react";
import { getOutboxDiagSnapshot, type OutboxDiagSnapshot } from "./outboxDiag";
import { onOutboxChange } from "./outbox";
import { onMediaOutboxChange } from "./mediaOutbox";

const EMPTY: OutboxDiagSnapshot = { firestoreEntries: [], mediaEntries: [], pendingEvidence: [] };

/** Live view of the production-safe outbox/queue diagnostic snapshot,
 * refreshed on every outbox or media-outbox change — same subscription
 * pattern as useSyncStatus.ts. Read-only. */
export function useOutboxDiag(): OutboxDiagSnapshot {
  const [snapshot, setSnapshot] = useState<OutboxDiagSnapshot>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void getOutboxDiagSnapshot().then((s) => {
        if (!cancelled) setSnapshot(s);
      });
    };
    refresh();
    const unsub = onOutboxChange(refresh);
    const unsubMedia = onMediaOutboxChange(refresh);
    return () => {
      cancelled = true;
      unsub();
      unsubMedia();
    };
  }, []);

  return snapshot;
}
