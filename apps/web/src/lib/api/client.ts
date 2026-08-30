import { authStore } from "$stores/auth";
import { clearUnsaved } from "$stores/unsaved";
import { get } from "svelte/store";

const BASE_URL = "/api/v1";

let refreshPromise: Promise<boolean> | null = null;

export class ApiError extends Error {
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
      clearUnsaved(); // N-08 / A1: window.location.href bypasses SvelteKit's router, and it is not
      // settled whether beforeNavigate sees it — clearing here is correct either way
      window.location.href = "/login";
    }
    throw new ApiError(401, (data as { error?: string })?.error ?? "Unauthorized", data);
  }

  if (!res.ok) {
    throw new ApiError(res.status, (data as { error?: string })?.error ?? "Fehler", data);
  }

  return data as T;
}

/**
 * Multipart upload with the SAME 401-refresh-and-retry behaviour as `request()`.
 *
 * Phase 104 code review (IN-06): the § 9 AU upload and the avatar upload each used a raw
 * `fetch` with a hand-attached `Authorization` header, so an expired access token surfaced as
 * "Upload fehlgeschlagen (401)" instead of a transparent retry. For the § 9 upload that was
 * worse than cosmetic: it runs BEFORE the confirm call, so a 401 aborted the whole
 * "AU liegt vor" flow.
 *
 * Deliberately NOT routed through `request()`: that helper sets
 * `Content-Type: application/json` whenever a body is present, which would destroy the
 * multipart boundary. FormData instances are re-sendable, so the retry can reuse the body.
 */
async function upload<T>(path: string, formData: FormData): Promise<T> {
  const auth = get(authStore);
  const headers: Record<string, string> = {};
  if (auth.accessToken) headers["Authorization"] = `Bearer ${auth.accessToken}`;

  const res = await fetch(`${BASE_URL}${path}`, { method: "POST", body: formData, headers });

  if (res.status === 204) return undefined as T;

  const data = res.headers.get("content-type")?.includes("application/json")
    ? await res.json()
    : await res.text();

  if (res.status === 401) {
    const refreshed = await tryRefresh();
    if (refreshed) return upload<T>(path, formData); // Retry with the fresh token
    authStore.logout();
    clearUnsaved(); // N-08 / A1: window.location.href bypasses SvelteKit's router, and it is not
    // settled whether beforeNavigate sees it — clearing here is correct either way
    window.location.href = "/login";
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
  /** Multipart POST (file upload) with the same 401-refresh-and-retry as every other verb. */
  upload: <T>(path: string, formData: FormData) => upload<T>(path, formData),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "DELETE",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
};
