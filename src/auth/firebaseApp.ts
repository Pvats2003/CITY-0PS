import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getFirebaseConfig } from "./config";

let app: FirebaseApp | null = null;

/** Lazily initializes the Firebase app singleton. Only ever called from
 * firebaseAuth.ts / firebaseBackend.ts, which are themselves only reached
 * when isFirebaseConfigured() is true — so demo mode never touches this. */
export function getFirebaseApp(): FirebaseApp {
  if (app) return app;
  const config = getFirebaseConfig();
  if (!config) throw new Error("Firebase is not configured — set VITE_FIREBASE_* env vars (see .env.example).");
  app = getApps().length ? getApps()[0]! : initializeApp(config);
  return app;
}
