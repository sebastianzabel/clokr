import { writable } from "svelte/store";
import { browser } from "$app/environment";

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

function createAuthStore() {
  const initial: AuthState = {
    accessToken: browser ? localStorage.getItem("accessToken") : null,
    refreshToken: browser ? localStorage.getItem("refreshToken") : null,
    user: loadUser(),
  };

  const { subscribe, set, update } = writable<AuthState>(initial);

  return {
    subscribe,
    login(accessToken: string, refreshToken: string, user: AuthUser) {
      if (browser) {
        localStorage.setItem("accessToken", accessToken);
        localStorage.setItem("refreshToken", refreshToken);
        localStorage.setItem("user", JSON.stringify(user));
      }
      set({ accessToken, refreshToken, user });
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
      }
      set({ accessToken: null, refreshToken: null, user: null });
    },
  };
}

export const authStore = createAuthStore();
