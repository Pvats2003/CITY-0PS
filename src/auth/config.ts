// ---------------------------------------------------------------------------
// Backend/demo split (spec: "demo mode must work with zero external network
// requests"). A real Firebase backend only activates when all of these are
// set — see .env.example. Until then, every page runs entirely against
// local Zustand/localStorage state, same as the original single-user build.
// ---------------------------------------------------------------------------

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

export function getFirebaseConfig(): FirebaseConfig | null {
  const env = import.meta.env;
  const apiKey = env.VITE_FIREBASE_API_KEY;
  const authDomain = env.VITE_FIREBASE_AUTH_DOMAIN;
  const projectId = env.VITE_FIREBASE_PROJECT_ID;
  const storageBucket = env.VITE_FIREBASE_STORAGE_BUCKET;
  const messagingSenderId = env.VITE_FIREBASE_MESSAGING_SENDER_ID;
  const appId = env.VITE_FIREBASE_APP_ID;
  if (!apiKey || !authDomain || !projectId || !storageBucket || !messagingSenderId || !appId) return null;
  return { apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId };
}

export function isFirebaseConfigured(): boolean {
  return getFirebaseConfig() !== null;
}
