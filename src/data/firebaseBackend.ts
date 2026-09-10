import { getFirestore, collection, doc, onSnapshot, setDoc, deleteDoc as fsDeleteDoc, query, orderBy, limit, where } from "firebase/firestore";
import { getFirebaseApp } from "@/auth/firebaseApp";
import { reportSyncError, describeError } from "./outbox";
import { setFosDiagSnapshot, getFosDiagSnapshot } from "./fosDiag";
import { OWNERSHIP_SCOPED_FO_COLLECTIONS, type CollectionName, type RemoteBackend } from "./backend";

/** The activity log is the one unbounded, high-write-frequency collection
 * (every action appends to it — see logActivity in store/city.ts, which
 * already caps the LOCAL copy at 2000 entries for the same reason). Left
 * unbounded, every client would keep the entire city's history in its
 * realtime listener forever. Capping the query bounds both the initial
 * read cost and ongoing bandwidth (Firestore cost protection — spec
 * section 17) — everything else is small enough for a single city that a
 * full-collection listener is the right, simple choice. */
const ACTIVITY_LISTEN_LIMIT = 500;

/** Firestore-backed implementation. Only ever imported when
 * isFirebaseConfigured() is true (see AuthContext/syncEngine) — never
 * pulled into the bundle path demo mode actually runs. One Firestore
 * collection per CityData array, documents keyed by the app's own ids so
 * writes are naturally idempotent (a retried write just overwrites itself).
 * Realtime listeners only bill for the initial read plus incremental
 * changes thereafter, not a full re-fetch on every update — Firestore's
 * standard, cost-efficient listen pattern. */
export const firebaseBackend: RemoteBackend = {
  subscribeCollection(name: CollectionName, cb, scope) {
    const app = getFirebaseApp();
    const db = getFirestore(app);
    // Ownership-scoped collections (assignments/sessions/issues/
    // rigIncidents) grant read via `resource.data.foId == myFoId()` in
    // firestore.rules — a rule Firestore cannot prove true for an
    // unfiltered list, since it depends on each document's own data rather
    // than only on the requester. Without a matching `where` clause the
    // ENTIRE listen is denied with permission-denied, even though every
    // document in it does belong to this FO — proven against a local
    // Firestore emulator, not inferred (see commit history). A Manager
    // subscription (scope undefined) and every non-ownership-scoped
    // collection are unaffected — they keep the original unfiltered query.
    const isFoScoped = !!scope && OWNERSHIP_SCOPED_FO_COLLECTIONS.includes(name);
    const ref =
      name === "activity"
        ? query(collection(db, name), orderBy("at", "desc"), limit(ACTIVITY_LISTEN_LIMIT))
        : isFoScoped
          ? query(collection(db, name), where("foId", "==", scope.foId))
          : collection(db, name);

    // TEMPORARY production diagnostics — primitive values only (never a
    // collapsed object a screenshot can't show the contents of). Every
    // collection this client subscribes to, not just fos: identifying
    // WHICH collection is denied is the whole point when the app subscribes
    // to several. Answers exactly what operation/path/project this client
    // issued, and, on success or failure, exactly what came back. Safe to
    // delete once resolved.
    console.log(
      "[CITY-OPS-DIAG] subscribing collection=" +
        name +
        " path=/" +
        name +
        " projectId=" +
        app.options.projectId +
        " foScoped=" +
        isFoScoped,
    );
    console.log("[CITY-OPS-DIAG] SYNC_COLLECTION", "collection=" + name, "status=subscribing", "errorCode=NONE", "errorMessage=NONE");

    return onSnapshot(
      ref,
      (snap) => {
        console.log("[CITY-OPS-DIAG] listener success collection=" + name + " count=" + snap.docs.length);
        console.log("[CITY-OPS-DIAG] SYNC_COLLECTION", "collection=" + name, "status=success", "errorCode=NONE", "errorMessage=NONE");
        if (name === "fos") {
          // Proves definitively which id each fos document actually
          // carries: the Firestore document ID (snap doc.id) is
          // deliberately NOT used for matching anywhere in this app (see
          // FOExecution.tsx) — only the app-level `id` field inside the
          // document's own data is. Captured into fosDiag.ts (not just
          // logged) so the on-page diagnostic panel can render the same
          // doc-ID/data-ID split from a screenshot, since console output
          // has repeatedly proven unreliable to capture from production.
          const records = snap.docs.map((d, i) => {
            const data = d.data() as { id?: unknown; name?: unknown };
            const dataId = data.id;
            console.log(
              "[CITY-OPS-DIAG] fos doc[" + i + "] firestoreDocId=" + d.id + " dataId=" + JSON.stringify(dataId) + " dataIdType=" + typeof dataId,
            );
            return { docId: d.id, dataId, dataIdType: typeof dataId, name: data.name };
          });
          setFosDiagSnapshot(records);
          // onSnapshot fires again on every remote change, not just once —
          // this line answers "how many times, and did a LATER snapshot
          // silently replace an earlier, correct one" (hypothesis E),
          // which a single "current state" log can never show on its own.
          const diag = getFosDiagSnapshot();
          console.log(
            "[CITY-OPS-DIAG] FOS_SNAPSHOT",
            "snapshotNumber=" + (diag?.snapshotNumber ?? -1),
            "timestamp=" + new Date(diag?.capturedAt ?? Date.now()).toISOString(),
            "documentCount=" + records.length,
            "docIds=" + JSON.stringify(records.map((r) => r.docId)),
            "dataIds=" + JSON.stringify(records.map((r) => r.dataId)),
            "names=" + JSON.stringify(records.map((r) => r.name)),
          );
        }
        cb(snap.docs.map((d) => d.data() as never));
      },
      (err) => {
        // Without this callback Firestore just drops the listener and logs
        // to the console — the collection would go silently, permanently
        // empty with no visible sign anything was wrong (the "blank UI from
        // an unhandled permission-denied error" failure mode). Route it into
        // the same per-collection SYNC ERROR surface as write failures.
        const code = (err as { code?: string }).code ?? "unknown";
        console.log("[CITY-OPS-DIAG] listener error collection=" + name + " code=" + code + " message=" + JSON.stringify(err.message));
        console.log(
          "[CITY-OPS-DIAG] SYNC_COLLECTION",
          "collection=" + name,
          "status=error",
          "errorCode=" + code,
          "errorMessage=" + JSON.stringify(err.message),
        );
        reportSyncError(name, describeError(err), code);
      },
    );
  },
  async putDoc(name, id, data) {
    const db = getFirestore(getFirebaseApp());
    await setDoc(doc(db, name, id), data, { merge: true });
  },
  async deleteDoc(name, id) {
    const db = getFirestore(getFirebaseApp());
    await fsDeleteDoc(doc(db, name, id));
  },
};
