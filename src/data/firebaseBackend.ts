import { getFirestore, collection, doc, onSnapshot, setDoc, deleteDoc as fsDeleteDoc } from "firebase/firestore";
import { getFirebaseApp } from "@/auth/firebaseApp";
import type { CollectionName, RemoteBackend } from "./backend";

/** Firestore-backed implementation. Only ever imported when
 * isFirebaseConfigured() is true (see AuthContext/syncEngine) — never
 * pulled into the bundle path demo mode actually runs. One Firestore
 * collection per CityData array, documents keyed by the app's own ids so
 * writes are naturally idempotent (a retried write just overwrites itself). */
export const firebaseBackend: RemoteBackend = {
  subscribeCollection(name: CollectionName, cb) {
    const db = getFirestore(getFirebaseApp());
    return onSnapshot(collection(db, name), (snap) => {
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
