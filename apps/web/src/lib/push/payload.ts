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

function isSafeRelativeUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw === "" || raw.length > MAX_URL) return false;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return false;
  if (raw.includes("\\") || FORBIDDEN_CHARS.test(raw) || ENCODED_SEPARATORS.test(raw)) return false;
  return !raw.split(/[?#]/)[0].split("/").includes("..");
}

/** The same-origin absolute URL of `raw`, or the dashboard when `raw` is not a safe relative path. */
export function targetUrlFor(raw: unknown, origin: string): string {
  const fallback = `${origin}${FALLBACK_URL}`;
  if (!isSafeRelativeUrl(raw)) return fallback;
  try {
    const target = new URL(raw, origin);
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
