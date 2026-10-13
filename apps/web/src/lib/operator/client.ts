// Operator API client (Issue #89, D-02, T-89-03).
//
// A fetch wrapper for `/api/v1/operator`, separate from the tenant client on purpose: it sends
// the operator token and nothing else (never the tenant `accessToken`), has no refresh and no
// retry, and turns a 401/403 on an authenticated call into "clear the operator session and hand
// the caller a sign-in URL". Navigation is injected by the console layout through
// `setUnauthorizedHandler`, so this module imports neither the tenant client nor SvelteKit's
// navigation and stays unit-testable.
import { errorMessage } from "$api/error-message";
import { clearSession, currentToken } from "$stores/operator-auth";
import { buildSignInUrl } from "./next-path";
import type {
  CreateTenantBody,
  CreateTenantResult,
  OperatorAccessGrant,
  OperatorChallenge,
  OperatorFactor,
  OperatorMe,
  OperatorSalon,
  OperatorTenant,
  ResendInvitationResult,
} from "./types";

const BASE_URL = "/api/v1/operator";

export class OperatorApiError extends Error {
  constructor(
    public status: number,
    /** Machine-readable reason from the response body, when the server sent one. */
    public code: string | undefined,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = "OperatorApiError";
  }
}

let unauthorizedHandler: ((signInUrl: string) => void) | null = null;

export function setUnauthorizedHandler(fn: ((signInUrl: string) => void) | null) {
  unauthorizedHandler = fn;
}

function currentPath(): string {
  if (typeof window === "undefined") return "/betreiber";
  return window.location.pathname + window.location.search;
}

export interface RequestOptions {
  body?: unknown;
  /** Send the operator token (default). `false` for the sign-in calls. */
  auth?: boolean;
}

export async function request<T>(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { body, auth = true } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    const token = currentToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  // 204 No Content - no body
  if (res.status === 204) return undefined as T;

  const data: unknown = res.headers.get("content-type")?.includes("application/json")
    ? await res.json()
    : await res.text();

  if (auth && (res.status === 401 || res.status === 403)) {
    clearSession();
    unauthorizedHandler?.(buildSignInUrl(currentPath(), { expired: true }));
    throw new OperatorApiError(res.status, readCode(data), errorMessage(data, "Fehler"), data);
  }

  if (!res.ok) {
    throw new OperatorApiError(res.status, readCode(data), errorMessage(data, "Fehler"), data);
  }

  return data as T;
}

function readCode(data: unknown): string | undefined {
  const code = (data as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

export const operatorApi = {
  /**
   * Whether the operator surface exists on this instance. A GET /auth/me without a token is
   * answered 404 when the surface is off and 401 when it is on - and unlike a login attempt it
   * neither uses the 10-per-15-minutes login budget nor writes a failed-login audit row on every
   * page load (T-89-13). Anything but a 404 (including a network failure) counts as "on", so the
   * form can report the real problem.
   */
  probeSurface: async (): Promise<"on" | "off"> => {
    try {
      await request<unknown>("GET", "/auth/me", { auth: false });
      return "on";
    } catch (error) {
      return error instanceof OperatorApiError && error.status === 404 ? "off" : "on";
    }
  },
  login: (email: string, password: string) =>
    request<OperatorChallenge>("POST", "/auth/login", { body: { email, password }, auth: false }),
  verify: (challengeToken: string, factor: OperatorFactor) =>
    request<OperatorAccessGrant>("POST", "/auth/verify", {
      body: { challengeToken, ...factor },
      auth: false,
    }),
  me: () => request<OperatorMe>("GET", "/auth/me"),
  createTenant: (body: CreateTenantBody) =>
    request<CreateTenantResult>("POST", "/tenants", { body }),
  listTenants: () => request<OperatorTenant[]>("GET", "/tenants"),
  getTenant: (id: string) => request<OperatorTenant>("GET", `/tenants/${encodeURIComponent(id)}`),
  renameTenant: (id: string, name: string) =>
    request<OperatorTenant>("PATCH", `/tenants/${encodeURIComponent(id)}`, { body: { name } }),
  deactivateTenant: (id: string, reason: string) =>
    request<OperatorTenant>("POST", `/tenants/${encodeURIComponent(id)}/deactivate`, {
      body: { reason },
    }),
  reactivateTenant: (id: string) =>
    request<OperatorTenant>("POST", `/tenants/${encodeURIComponent(id)}/reactivate`),
  resendInvitation: (id: string) =>
    request<ResendInvitationResult>(
      "POST",
      `/tenants/${encodeURIComponent(id)}/resend-admin-invitation`,
    ),
  listSalons: (tenantId: string) =>
    request<OperatorSalon[]>("GET", `/tenants/${encodeURIComponent(tenantId)}/salons`),
};
