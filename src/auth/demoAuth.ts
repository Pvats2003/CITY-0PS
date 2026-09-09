import { useCity } from "@/store/city";
import { nowISO } from "@/lib/dates";
import type { AppUser, AuthProvider, AuthResult, UserRole } from "./types";

// ---------------------------------------------------------------------------
// Zero-network demo auth. Used whenever no real backend is configured (see
// isFirebaseConfigured() in ./config). Session lives in its own localStorage
// key — deliberately separate from "city-ops-os" so it never interacts with
// that store's DATA_VERSION/migrate logic.
// ---------------------------------------------------------------------------

const AUTH_STORAGE_KEY = "city-ops-auth";

const DEMO_MANAGER: AppUser = {
  id: "demo-manager",
  email: "manager@demo.city-ops",
  role: "MANAGER",
  displayName: "Demo Manager",
  createdAt: nowISO(),
};

function readSession(): AppUser | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AppUser) : null;
  } catch {
    return null;
  }
}

function writeSession(user: AppUser | null) {
  if (user) localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(user));
  else localStorage.removeItem(AUTH_STORAGE_KEY);
  window.dispatchEvent(new CustomEvent("city-ops-auth-change"));
}

/** Demo Field Officer identity binds to the first active FO in whatever
 * city data is currently loaded — there's no separate "FO accounts" table
 * in demo mode, the roster already loaded by Onboarding/demo data IS it. */
function demoFieldOfficerUser(): AppUser | null {
  const fo = useCity.getState().fos.find((f) => f.active);
  if (!fo) return null;
  return {
    id: `demo-fo-${fo.id}`,
    email: fo.email ?? `${fo.name.toLowerCase().replace(/\s+/g, ".")}@demo.city-ops`,
    role: "FIELD_OFFICER",
    displayName: fo.name,
    foId: fo.id,
    createdAt: nowISO(),
  };
}

export function loginDemo(role: UserRole): AuthResult {
  if (role === "MANAGER") {
    writeSession(DEMO_MANAGER);
    return { ok: true };
  }
  const fo = demoFieldOfficerUser();
  if (!fo) return { ok: false, error: "No active field officers in the loaded city yet — load demo data or add an FO first." };
  writeSession(fo);
  return { ok: true };
}

export const demoAuthProvider: AuthProvider = {
  onChange(cb) {
    cb(readSession());
    const handler = () => cb(readSession());
    window.addEventListener("city-ops-auth-change", handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener("city-ops-auth-change", handler);
      window.removeEventListener("storage", handler);
    };
  },
  async loginWithEmail() {
    return { ok: false, error: "Email/password login needs a configured backend. Use a demo button below, or set VITE_FIREBASE_* to enable real accounts." };
  },
  async logout() {
    writeSession(null);
  },
};
