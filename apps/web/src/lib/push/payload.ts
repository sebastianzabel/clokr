// Pure helpers of the push-only service worker (Issue #608, D-09 / D-19).
//
// The server already validates the target of every push (`safePushUrl`), but the worker is the last
// hop before a window is navigated, so it re-applies the same refusal rules on its own: a payload is
// untrusted input until it has passed this module. Nothing here throws - an unreadable payload
// becomes the neutral fallback, because a push that shows nothing makes iOS revoke the subscription.

export type PushPayload = { title: string; body: string; url: string };

const FALLBACK_URL = "/dashboard";
const MAX_TITLE = 100;
const MAX_BODY = 300;
const MAX_URL = 512;

/** What is shown when the data is missing or unreadable. */
export const PUSH_FALLBACK: PushPayload = {
  title: "Clokr",
  body: "Es gibt etwas Neues in Clokr.",
  url: FALLBACK_URL,
};

// Control characters (including line breaks) and whitespace have no place in a navigation target.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f\s]/;
// Percent-encoded dots, slashes and backslashes could smuggle a traversal past the plain checks.
const ENCODED_SEPARATORS = /%(2e|2f|5c)/i;

const NORMALISE_BASE = "https://push.invalid";

/**
 * The path, query and hash of `raw` AFTER dot-segment normalisation, or null when `raw` is not a
 * safe same-origin path. Normalising first matters (review 2, WR-03): `/.//evil.example` passes
 * every textual check, but WHATWG removes the `.` segment and leaves `//evil.example`, which a
 * router or a browser resolves against ANOTHER origin. The normalised result must therefore again
 * start with exactly one `/`.
 */
function normalisedPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "" || raw.length > MAX_URL) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if (raw.includes("\\") || FORBIDDEN_CHARS.test(raw) || ENCODED_SEPARATORS.test(raw)) return null;
  if (raw.split(/[?#]/)[0].split("/").includes("..")) return null;
  try {
    const target = new URL(raw, NORMALISE_BASE);
    if (target.origin !== NORMALISE_BASE) return null;
    const path = `${target.pathname}${target.search}${target.hash}`;
    if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return null;
    return path;
  } catch {
    return null;
  }
}

function isSafeRelativeUrl(raw: unknown): raw is string {
  return normalisedPath(raw) !== null;
}

/** Message type the worker posts to an open app window to navigate it (review WR-05). */
export const PUSH_NAVIGATE_MESSAGE = "clokr:navigate";

const AUTH_PATHS = ["/login", "/otp", "/forgot-password", "/invitation", "/reset-password"];

/**
 * True when an open window can receive a push navigation: it is neither the operator console (a
 * different application) nor a signed-out auth page (those pages mount no navigation listener).
 */
export function isAppWindowPath(pathname: string): boolean {
  if (pathname === "/betreiber" || pathname.startsWith("/betreiber/")) return false;
  return !AUTH_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/**
 * The normalised same-origin path (path, query, hash) for `raw`, or the dashboard when `raw` is not
 * a safe relative path. The worker posts it and the app re-applies this very rule before `goto()`.
 */
export function safePushPath(raw: unknown): string {
  return normalisedPath(raw) ?? FALLBACK_URL;
}

/** The same-origin absolute URL of `raw`, or the dashboard when `raw` is not a safe relative path. */
export function targetUrlFor(raw: unknown, origin: string): string {
  const fallback = `${origin}${FALLBACK_URL}`;
  const path = normalisedPath(raw);
  if (path === null) return fallback;
  try {
    const target = new URL(path, origin);
    return target.origin === new URL(origin).origin ? target.href : fallback;
  } catch {
    return fallback;
  }
}

/** Title, body and url of a push event; never throws. */
export function parsePushPayload(data: { json(): unknown } | null | undefined): PushPayload {
  let parsed: unknown;
  try {
    parsed = data ? data.json() : null;
  } catch {
    return { ...PUSH_FALLBACK };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...PUSH_FALLBACK };
  }
  const { title, body, url } = parsed as Record<string, unknown>;
  if (typeof title !== "string" || typeof body !== "string") return { ...PUSH_FALLBACK };
  if (title === "" || title.length > MAX_TITLE || body.length > MAX_BODY) {
    return { ...PUSH_FALLBACK };
  }
  return { title, body, url: isSafeRelativeUrl(url) ? url : FALLBACK_URL };
}
