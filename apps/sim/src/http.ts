/**
 * The only way the simulation talks to Clokr: HTTP against the public API, with a real login.
 * There is deliberately no database client in this file or in any bot (Issue #715).
 */

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
  /** Wall clock duration of the request in milliseconds. */
  ms: number;
}

export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

export class ApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: HttpFetch = (url, init) => fetch(url, init),
  ) {}

  async request<T = unknown>(
    method: string,
    path: string,
    options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const started = performance.now();
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    const ms = Math.round(performance.now() - started);
    let body: unknown = text;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, body: body as T, ms };
  }

  get<T = unknown>(path: string, token?: string) {
    return this.request<T>("GET", path, { token });
  }
  post<T = unknown>(path: string, body: unknown, token?: string) {
    return this.request<T>("POST", path, { token, body });
  }
  put<T = unknown>(path: string, body: unknown, token?: string) {
    return this.request<T>("PUT", path, { token, body });
  }
  patch<T = unknown>(path: string, body: unknown, token?: string) {
    return this.request<T>("PATCH", path, { token, body });
  }
  delete<T = unknown>(path: string, token?: string, body?: unknown) {
    return this.request<T>("DELETE", path, { token, body });
  }
}

export interface Session {
  token: string;
  userId: string;
  employeeId: string;
  tenantId: string;
}

/**
 * The API limits logins to 50 per minute and client address, and the bots all share one address.
 * Logins are therefore spaced out (44 per minute) instead of hammering the limit: a population of
 * 300 people needs a few minutes to sign in, like it would behind one office router.
 */
const LOGIN_SPACING_MS = 1400;
let loginChain: Promise<void> = Promise.resolve();
let lastLoginAt = 0;

function paceLogin(): Promise<void> {
  const slot = loginChain.then(async () => {
    const wait = lastLoginAt + LOGIN_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastLoginAt = Date.now();
  });
  loginChain = slot.catch(() => undefined);
  return slot;
}

/** Real web login. The sim tenants run with 2FA off, so a successful login returns the token. */
export async function login(api: ApiClient, email: string, password: string): Promise<Session> {
  let res: ApiResult<{
    accessToken?: string;
    user?: { id: string; employeeId?: string; tenantId?: string };
    error?: string;
  }>;
  for (let attempt = 0; ; attempt += 1) {
    await paceLogin();
    res = await api.post("/api/v1/auth/login", { email, password });
    if (res.status !== 429 || attempt >= 3) break;
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  if (res.status !== 200 || !res.body.accessToken) {
    throw new Error(`Login refused with status ${res.status}`);
  }
  const payload = JSON.parse(
    Buffer.from(res.body.accessToken.split(".")[1], "base64url").toString("utf8"),
  ) as { sub: string; employeeId?: string; tenantId?: string };
  return {
    token: res.body.accessToken,
    userId: payload.sub,
    employeeId: payload.employeeId ?? res.body.user?.employeeId ?? "",
    tenantId: payload.tenantId ?? res.body.user?.tenantId ?? "",
  };
}

/** Runs async work over items with a fixed number of workers (the API rate limit is per IP). */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
