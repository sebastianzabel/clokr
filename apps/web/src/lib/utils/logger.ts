/**
 * Client-side logger — catches errors and sends them to the API.
 * Errors are also logged to console for dev debugging.
 */

const LOG_ENDPOINT = "/api/v1/logs/client";

/**
 * localStorage keys written by `$stores/auth` (`authStore.login()` / `setTokens()`).
 * They are three separate keys — there is NO single `"auth"` object. Reading a
 * non-existent key left every delivery unauthenticated and the endpoint answered
 * 401 for years (issue #149), so these two constants are the contract with the
 * auth store and must stay in sync with it.
 */
const ACCESS_TOKEN_KEY = "accessToken";
const USER_KEY = "user";

/** Entries held back for delivery. Oldest ones are dropped once it overflows. */
const MAX_QUEUE = 10;
/** Delay between enqueueing an entry and the first delivery attempt. */
const FLUSH_DELAY_MS = 5_000;
/**
 * The endpoint allows 5 requests per minute (`apps/api/src/app.ts`, the
 * `/api/v1/logs/client` route's `config.rateLimit`). One request carries exactly one
 * entry, so deliveries are spaced far enough apart to stay under that budget (4/min).
 */
const MIN_SEND_INTERVAL_MS = 15_000;
/** How long to stay silent after the server answered 429. */
const RATE_LIMIT_COOLDOWN_MS = 60_000;

const queue: Array<Record<string, unknown>> = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let lastSendAt = 0;
let cooldownUntil = 0;
let deliveryFailureReported = false;
let installed = false;

function readStoredUserId(): string | undefined {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { id?: string } | null;
    return parsed?.id;
  } catch {
    // A corrupt `user` entry must not cost us the token as well.
    return undefined;
  }
}

function getAuthInfo(): { userId?: string; token?: string } {
  try {
    return {
      userId: readStoredUserId(),
      token: localStorage.getItem(ACCESS_TOKEN_KEY) ?? undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Make a broken delivery chain audible — once per session, never per attempt.
 *
 * Deliberately writes straight to the console instead of going through
 * `clientLogger.error()`: routing it back in would re-enqueue the very entry whose
 * delivery just failed and spin a loop. The previous `.catch(() => {})` hid the
 * total outage this replaces (issue #149).
 */
function reportDeliveryFailureOnce(reason: string) {
  if (deliveryFailureReported) return;
  deliveryFailureReported = true;
  console.warn(
    `[clokr] client error logging could not reach ${LOG_ENDPOINT} (${reason}). ` +
      `Further delivery failures are suppressed for this session.`,
  );
}

function scheduleFlush(delayMs: number) {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    flush();
  }, delayMs);
}

function flush() {
  if (queue.length === 0) return;

  const now = Date.now();
  const waitMs = Math.max(cooldownUntil - now, MIN_SEND_INTERVAL_MS - (now - lastSendAt));
  if (waitMs > 0) {
    scheduleFlush(waitMs);
    return;
  }

  const { token } = getAuthInfo();
  if (!token) {
    // The endpoint sits behind `requireAuth`. Without a token there is nothing to
    // deliver, so drop the backlog instead of retrying into a guaranteed 401.
    queue.length = 0;
    reportDeliveryFailureOnce("no access token in localStorage");
    return;
  }

  const entry = queue.shift();
  if (!entry) return;
  lastSendAt = now;

  void fetch(LOG_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(entry),
  })
    .then((res) => {
      if (res.status === 429) {
        // Rate limited: back off for a full window and drop this entry rather than
        // retrying it — a retry would be the error loop the limit is there to prevent.
        cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
        return;
      }
      if (!res.ok) reportDeliveryFailureOnce(`HTTP ${res.status}`);
    })
    .catch((err: unknown) => {
      reportDeliveryFailureOnce(err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      if (queue.length > 0) scheduleFlush(MIN_SEND_INTERVAL_MS);
    });
}

function enqueue(entry: Record<string, unknown>) {
  queue.push(entry);
  // Bounded buffer: an error storm must not grow the queue without limit.
  while (queue.length > MAX_QUEUE) queue.shift();
  scheduleFlush(FLUSH_DELAY_MS);
}

export const clientLogger = {
  error(message: string, extra?: Record<string, unknown>) {
    console.error(`[clokr]`, message, extra);
    const { userId } = getAuthInfo();
    enqueue({
      level: "error",
      message,
      url: window.location.href,
      userAgent: navigator.userAgent,
      userId,
      ...extra,
    });
  },

  warn(message: string, extra?: Record<string, unknown>) {
    console.warn(`[clokr]`, message, extra);
    const { userId } = getAuthInfo();
    enqueue({
      level: "warn",
      message,
      url: window.location.href,
      userAgent: navigator.userAgent,
      userId,
      ...extra,
    });
  },

  /**
   * Install global error handlers. Called once from the ROOT layout so the
   * `(auth)` pages are covered too; the guard keeps a second call a no-op.
   */
  install() {
    if (typeof window === "undefined") return;
    if (installed) return;
    installed = true;

    window.addEventListener("error", (e) => {
      clientLogger.error(e.message, {
        stack: e.error?.stack,
        filename: e.filename,
        lineno: e.lineno,
        colno: e.colno,
      });
    });

    window.addEventListener("unhandledrejection", (e) => {
      const msg = e.reason instanceof Error ? e.reason.message : String(e.reason);
      const stack = e.reason instanceof Error ? e.reason.stack : undefined;
      clientLogger.error(`Unhandled Promise: ${msg}`, { stack });
    });
  },
};
