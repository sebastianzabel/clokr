// Operator session store (Issue #89, D-02).
//
// The operator console has its own session, entirely separate from the tenant session of
// `$stores/auth`: the access token is opaque (never decoded here), lives 15 minutes server-side,
// has no refresh and dies with the browser tab, so it is kept in `sessionStorage` only — never in
// the persistent storage that the tenant session and every other tab share. A blocked or throwing
// storage (private mode, policy) must not break the console: the session then lives in memory for
// the module lifetime, and a reload lands on the sign-in page.
//
// Imports are deliberately limited to `svelte/store` and `$app/environment`; the isolation scan
// (`__tests__/operator-isolation-89.test.ts`) fails on anything that reaches the tenant session.
import { writable } from "svelte/store";
import { browser } from "$app/environment";

export const OPERATOR_TOKEN_KEY = "clokr.operator.accessToken";
export const OPERATOR_EXPIRES_KEY = "clokr.operator.expiresAt";

export interface OperatorSession {
  token: string;
  /** Absolute expiry as epoch milliseconds. */
  expiresAt: number;
}

/** In-memory copy: the fallback when sessionStorage is blocked, and the SSR-safe default. */
let memory: OperatorSession | null = null;

export const operatorSession = writable<OperatorSession | null>(null);

function readStored(): OperatorSession | null {
  if (!browser) return null;
  try {
    const token = sessionStorage.getItem(OPERATOR_TOKEN_KEY);
    const rawExpiry = sessionStorage.getItem(OPERATOR_EXPIRES_KEY);
    if (!token || rawExpiry === null) return null;
    const expiresAt = Number(rawExpiry);
    if (!Number.isFinite(expiresAt)) return null;
    return { token, expiresAt };
  } catch {
    return null;
  }
}

function removeStored(): void {
  if (!browser) return;
  try {
    sessionStorage.removeItem(OPERATOR_TOKEN_KEY);
    sessionStorage.removeItem(OPERATOR_EXPIRES_KEY);
  } catch {
    // Blocked storage: nothing stored there that could outlive this call.
  }
}

/** The valid session or null; an expired or half-written session is removed. */
function resolve(now: number): OperatorSession | null {
  const candidate = readStored() ?? memory;
  if (candidate && candidate.expiresAt > now) return candidate;
  memory = null;
  removeStored();
  return null;
}

/** Read the stored session; null (and both keys removed) when absent, incomplete or expired. */
export function loadSession(now: number = Date.now()): OperatorSession | null {
  const session = resolve(now);
  operatorSession.set(session);
  return session;
}

export function setSession(token: string, expiresInSeconds: number, now: number = Date.now()) {
  const session: OperatorSession = { token, expiresAt: now + expiresInSeconds * 1000 };
  memory = session;
  if (browser) {
    try {
      sessionStorage.setItem(OPERATOR_TOKEN_KEY, session.token);
      sessionStorage.setItem(OPERATOR_EXPIRES_KEY, String(session.expiresAt));
    } catch {
      // Blocked storage: the in-memory copy carries the session.
    }
  }
  operatorSession.set(session);
}

/** Remove the operator session and nothing else (the tenant keys are never touched). */
export function clearSession(): void {
  memory = null;
  removeStored();
  operatorSession.set(null);
}

/** The token to send, or null when there is no unexpired session. */
export function currentToken(now: number = Date.now()): string | null {
  return resolve(now)?.token ?? null;
}
