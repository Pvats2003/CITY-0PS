import { getFirestore, collection, doc, onSnapshot, setDoc, deleteDoc as fsDeleteDoc, query, orderBy, limit } from "firebase/firestore";
import { getFirebaseApp } from "@/auth/firebaseApp";
import type { CollectionName, RemoteBackend } from "./backend";

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
  subscribeCollection(name: CollectionName, cb) {
    const db = getFirestore(getFirebaseApp());
    const ref =
      name === "activity" ? query(collection(db, name), orderBy("at", "desc"), limit(ACTIVITY_LISTEN_LIMIT)) : collection(db, name);
    return onSnapshot(ref, (snap) => {
      cb(snap.docs.map((d) => d.data() as never));
    });
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
