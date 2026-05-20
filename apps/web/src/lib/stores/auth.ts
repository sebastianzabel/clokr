import { writable } from "svelte/store";
import { browser } from "$app/environment";
import { theme, themes, type Theme } from "$stores/theme";
import { mode } from "$stores/mode";
import { density } from "$stores/density";
import { skin } from "$stores/skin";
import { prefsHydrated } from "$stores/prefs-state";
import { fetchPreferences } from "$api/preferences";

interface AuthUser {
  id: string;
  email: string;
  role: "ADMIN" | "MANAGER" | "EMPLOYEE";
  employeeId: string | null;
  firstName: string | null;
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
}

function loadUser(): AuthUser | null {
  if (!browser) return null;
  try {
    const raw = localStorage.getItem("user");
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

/**
 * Pull preferences from the server and apply them to the relevant stores.
 *
 * Crucial ordering: `prefsHydrated` stays `false` while we apply server values so the
 * store subscribers don't echo each value back to the API (which would create an
 * immediate no-op PUT for every key). Only AFTER all three stores are updated do we
 * flip the gate to `true`, so subsequent user toggles propagate to the server.
 *
 * Failures are silent: localStorage already holds last-used values as offline fallback.
 */
async function hydratePreferencesFromServer(): Promise<void> {
  if (!browser) return;
  try {
    const prefs = await fetchPreferences();
    // Apply in order. Subscribers will still write to localStorage + DOM attribute
    // (those are unconditional), but skip the server PUT because prefsHydrated === false.
    // The server theme enum includes "schiefer" but the web theme type only has 3 values
    // for now; fall back to "pflaume" when the server returns a theme we don't ship yet.
    const validTheme: Theme = themes.some((t) => t.id === prefs.theme)
      ? (prefs.theme as Theme)
      : "pflaume";
    theme.set(validTheme);
    mode.set(prefs.mode);
    density.set(prefs.density);
    // Skin (999.2): editorial = default, modern = glassmorphism layer.
    skin.set(prefs.skin ?? "editorial");
    // Language store doesn't exist yet (planned). Once it does, set it here.
    prefsHydrated.set(true);
  } catch {
    // Server unreachable or 401 — keep localStorage fallback, stay un-hydrated so
    // we don't fire PUTs that will also fail.
  }
}

function createAuthStore() {
  const initial: AuthState = {
    accessToken: browser ? localStorage.getItem("accessToken") : null,
    refreshToken: browser ? localStorage.getItem("refreshToken") : null,
    user: loadUser(),
  };

  const { subscribe, set, update } = writable<AuthState>(initial);

  // On boot: if we already have an access token (returning visit), hydrate prefs.
  if (browser && initial.accessToken) {
    void hydratePreferencesFromServer();
  }

  return {
    subscribe,
    login(accessToken: string, refreshToken: string, user: AuthUser) {
      if (browser) {
        localStorage.setItem("accessToken", accessToken);
        localStorage.setItem("refreshToken", refreshToken);
        localStorage.setItem("user", JSON.stringify(user));
      }
      set({ accessToken, refreshToken, user });
      // Fire-and-forget — UI shouldn't block on preference fetch.
      if (browser) {
        void hydratePreferencesFromServer();
      }
    },
    setTokens(accessToken: string, refreshToken: string) {
      if (browser) {
        localStorage.setItem("accessToken", accessToken);
        localStorage.setItem("refreshToken", refreshToken);
      }
      update((s) => ({ ...s, accessToken, refreshToken }));
    },
    logout() {
      if (browser) {
        localStorage.removeItem("accessToken");
        localStorage.removeItem("refreshToken");
        localStorage.removeItem("user");
        // NOTE: deliberately do NOT clear theme/mode/density localStorage keys.
        // They serve as offline fallback for the next user on this device.
      }
      // Stop background PUTs for the previous user. The next login will re-hydrate
      // and flip this back to true once values from the server are applied.
      prefsHydrated.set(false);
      set({ accessToken: null, refreshToken: null, user: null });
    },
  };
}

export const authStore = createAuthStore();
