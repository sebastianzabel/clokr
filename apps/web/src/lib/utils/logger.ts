/**
 * Client-side logger — catches errors and sends them to the API.
 * Errors are also logged to console for dev debugging.
 */

const LOG_ENDPOINT = "/api/v1/logs/client";
const MAX_QUEUE = 10;
const queue: Array<Record<string, unknown>> = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function getAuthInfo(): { userId?: string; token?: string } {
  try {
    const stored = localStorage.getItem("auth");
    if (!stored) return {};
    const parsed = JSON.parse(stored);
    return { userId: parsed.user?.id, token: parsed.accessToken };
  } catch {
    return {};
  }
}

function flush() {
  if (queue.length === 0) return;
  const batch = queue.splice(0, MAX_QUEUE);
  const { token } = getAuthInfo();

  for (const entry of batch) {
    fetch(LOG_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(entry),
    }).catch(() => {}); // Fire and forget
  }
}

function enqueue(entry: Record<string, unknown>) {
  queue.push(entry);
  if (queue.length >= MAX_QUEUE) {
    flush();
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      flush();
    }, 5000);
  }
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

  /** Install global error handlers. Call once in root layout. */
  install() {
    if (typeof window === "undefined") return;

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
