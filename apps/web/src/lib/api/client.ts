import { authStore } from "$stores/auth";
import { get } from "svelte/store";

const BASE_URL = "/api/v1";

let refreshPromise: Promise<boolean> | null = null;

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const auth = get(authStore);

  const headers: Record<string, string> = {
    // Content-Type nur setzen wenn ein Body mitkommt
    ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(options.headers as Record<string, string>),
  };

  if (auth.accessToken) {
    headers["Authorization"] = `Bearer ${auth.accessToken}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });

  // 204 No Content – kein Body
  if (res.status === 204) return undefined as T;

  const data = res.headers.get("content-type")?.includes("application/json")
    ? await res.json()
    : await res.text();

  if (res.status === 401) {
    // Auth-Endpunkte selbst (login, otp) sollen kein Auto-Refresh auslösen —
    // dort bedeutet 401 "falsche Anmeldedaten", nicht "Token abgelaufen".
    const isAuthEndpoint = path.startsWith("/auth/login") || path.startsWith("/auth/otp");
    if (!isAuthEndpoint) {
      // Token abgelaufen – versuche zu refreshen
      const refreshed = await tryRefresh();
      if (refreshed) {
        return request<T>(path, options); // Retry
      }
      authStore.logout();
      window.location.href = "/login";
    }
    throw new ApiError(401, (data as { error?: string })?.error ?? "Unauthorized", data);
  }

  if (!res.ok) {
    throw new ApiError(res.status, (data as { error?: string })?.error ?? "Fehler", data);
  }

  return data as T;
}

async function tryRefresh(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = doRefresh();
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function doRefresh(): Promise<boolean> {
  const auth = get(authStore);
  if (!auth.refreshToken) return false;

  try {
    const res = await fetch(`${BASE_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: auth.refreshToken }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    authStore.setTokens(data.accessToken, data.refreshToken);
    return true;
  } catch (err) {
    console.error("Failed to refresh token:", err);
    return false;
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "DELETE", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
};
