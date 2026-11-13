// Sign-in target of the tenant app (Issue #608, D-20, T-608-30).
//
// A notification tap after the session ended must not lose its target: the (app) guard and the
// API client's forced logout send `/login?next=<path+search>`, and the login and OTP pages continue
// there. This mirrors the refusal rules of `$lib/operator/next-path.ts` for the tenant app: only a
// plain same-origin path is accepted, so the sign-in page can never become an open redirect.

const OPERATOR_ROOT = "/betreiber";
const AUTH_PAGES = ["/login", "/otp"];
const MAX_LENGTH = 512;

// Control characters (including line breaks) have no place in a redirect target.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// Percent-encoded dots, slashes and backslashes could smuggle a traversal past the plain checks.
const ENCODED_SEPARATORS = /%(2e|2f|5c)/i;

/** True when `path` is `root` itself or continues with `/`, `?` or `#` right after it. */
function isUnder(path: string, root: string): boolean {
  if (!path.startsWith(root)) return false;
  const next = path.charAt(root.length);
  return next === "" || next === "/" || next === "?" || next === "#";
}

/** The path itself when it is a safe in-app sign-in target, otherwise null. */
export function safeAppNext(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw === "" || raw.length > MAX_LENGTH) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.includes("\\") || raw.includes("//") || raw.includes("..")) return null;
  if (CONTROL_CHARS.test(raw) || ENCODED_SEPARATORS.test(raw)) return null;
  // The operator console has its own sign-in; the auth pages would only loop.
  if (isUnder(raw, OPERATOR_ROOT)) return null;
  if (AUTH_PAGES.some((page) => isUnder(raw, page))) return null;
  return raw;
}

/** `base` with the (already safe) target as `?next=`; the bare `base` when there is none. */
export function authPathWithNext(base: "/login" | "/otp", next: string | null): string {
  return next === null ? base : `${base}?next=${encodeURIComponent(next)}`;
}

/** `/login` carrying the page the person was on, when that page is a safe target. */
export function loginPathWithNext(loc: { pathname: string; search: string }): string {
  const target = safeAppNext(`${loc.pathname}${loc.search}`);
  // The root only redirects to the dashboard, which is where sign-in goes anyway.
  return authPathWithNext("/login", target === "/" ? null : target);
}
