// Safe `?next=` handling for the operator sign-in (Issue #89, D-02, T-89-04).
//
// The target is accepted only when it stays inside the operator console; everything else
// (protocol-relative URLs, backslash tricks, other schemes, traversal, the tenant app) is
// refused, so the sign-in page can never be turned into an open redirect.

const CONSOLE_ROOT = "/betreiber";
const SIGN_IN_PATH = "/betreiber/anmelden";

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

/** The path itself when it is a safe operator-console target, otherwise null. */
export function safeNext(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  if (!isUnder(raw, CONSOLE_ROOT)) return null;
  if (raw.includes("\\") || raw.includes("//") || raw.includes("..")) return null;
  if (CONTROL_CHARS.test(raw) || ENCODED_SEPARATORS.test(raw)) return null;
  // Sending someone back to the sign-in page after signing in would only loop.
  if (isUnder(raw, SIGN_IN_PATH)) return null;
  return raw;
}

/** `/betreiber/anmelden` with the safe `next` and, for an expired session, `abgelaufen=1`. */
export function buildSignInUrl(path: string, opts: { expired: boolean }): string {
  const params: string[] = [];
  const next = safeNext(path);
  if (next !== null) params.push(`next=${encodeURIComponent(next)}`);
  if (opts.expired) params.push("abgelaufen=1");
  return params.length > 0 ? `${SIGN_IN_PATH}?${params.join("&")}` : SIGN_IN_PATH;
}
