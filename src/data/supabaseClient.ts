import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getCurrentFirebaseIdToken } from "@/auth/firebaseAuth";

// ---------------------------------------------------------------------------
// Supabase Storage adapter singleton — binary evidence photos only. Firebase
// Auth remains the only authentication system and Firestore remains the only
// operational metadata store; this client exists solely so mediaStorage.ts
// can upload/read evidence photo binaries against Supabase's private
// `evidence` bucket.
//
// No Supabase-native session is ever created. The client is configured with
// Supabase's Third-Party Auth `accessToken` option (see Supabase's Firebase
// Auth integration docs) so every request carries the SAME Firebase ID token
// the rest of the app already obtains from firebaseAuth.ts — Supabase
// verifies that token itself (against Firebase project city-ops-cf81f's
// public JWKS, configured once in the Supabase dashboard, not in this file)
// rather than issuing or storing any credential of its own. This file never
// contains, imports, or references a Supabase service-role key or a Firebase
// Admin SDK credential — anon key + a third-party-verified user JWT only,
// exactly like every other client-side call in this app.
// ---------------------------------------------------------------------------

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

export function getSupabaseConfig(): SupabaseConfig | null {
  const env = import.meta.env;
  const url = env.VITE_SUPABASE_URL;
  const anonKey = env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

export function isSupabaseConfigured(): boolean {
  return getSupabaseConfig() !== null;
}

let client: SupabaseClient | null = null;

/** Lazily initializes the Supabase client singleton. Only ever called from
 * mediaStorage.ts, which is itself only reached when isSupabaseConfigured()
 * is true — demo mode never touches this, same convention as
 * auth/firebaseApp.ts's getFirebaseApp(). */
export function getSupabaseClient(): SupabaseClient {
  if (client) return client;
  const config = getSupabaseConfig();
  if (!config) throw new Error("Supabase is not configured — set VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY (see .env.example).");
  client = createClient(config.url, config.anonKey, {
    // Third-Party Auth: Supabase calls this on every request instead of
    // managing its own auth session. getCurrentFirebaseIdToken() uses the
    // SDK's normal (non-forced) getIdToken() — Firebase auto-refreshes the
    // cached token as it nears expiry, so this does not force a network
    // round-trip on every Storage call. A forced refresh is used only
    // explicitly, during account provisioning/testing right after a custom
    // claim changes (see scripts/set-supabase-role-claim.mjs's docs) — never
    // here.
    accessToken: async () => getCurrentFirebaseIdToken(),
  });
  return client;
}
