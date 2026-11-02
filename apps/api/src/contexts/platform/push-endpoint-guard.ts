/**
 * Issue #608 (D-17, P-608-04) - the ONE place that decides which push-service endpoints the server
 * will ever send to.
 *
 * A web-push endpoint is a URL chosen by the client, and the server later makes an outbound HTTPS
 * request to it with a signed VAPID token. Without an allow-list that is an SSRF primitive, so an
 * endpoint is accepted only when it is a plain https URL on port 443 whose host is one of the four
 * push services of the supported browsers (or a sub-domain of one). Everything else is refused
 * before any write.
 *
 * Parser differential (review CR-01): the guard judges the string with WHATWG `new URL()`, but the
 * `web-push` library re-parses the same string with the legacy `url.parse()`. The two disagree on
 * inputs such as `https:/host/x` or `https:host/x` (WHATWG repairs the missing authority, legacy
 * leaves the host null and Node then connects to localhost:443). The guard therefore returns ONE
 * canonical string (`url.href`), accepts it only when both parsers resolve the same protocol and
 * host, and the caller stores and sends nothing but that string.
 */
import { parse as legacyParse } from "node:url";

/** The four push-service host suffixes (D-17): FCM, Mozilla autopush, WNS and APNs for Web Push. */
export const PUSH_SERVICE_HOST_SUFFIXES = [
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "notify.windows.com",
  "push.apple.com",
] as const;

function parseEndpoint(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** True for a dotted-quad or a bracketed/colon IPv6 literal host. */
function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

/**
 * True when the legacy parser (the one `web-push` uses) resolves the same protocol and host. The
 * legacy `url.parse()` DOES throw (`ERR_INVALID_URL`) for a host it cannot IDNA-convert while WHATWG
 * accepts the same string (it drops soft hyphens / zero width characters and percent-decodes the
 * host; review 2, WR-01), so a throw means "the parsers disagree" and the endpoint is refused: the
 * guard's contract is `string | null` and it never throws.
 */
function legacyAgrees(candidate: string, url: URL): boolean {
  try {
    const legacy = legacyParse(candidate);
    return legacy.protocol === url.protocol && legacy.hostname === url.hostname;
  } catch {
    return false;
  }
}

/**
 * The canonical form of an allowed push endpoint, or null when the endpoint is not allowed. Every
 * later step (storage, lookup, sending) must use this string and never the raw input. The fragment
 * is dropped: a push service never sees it (`web-push` sends path and query only), so `...#a` and
 * `...#b` are the SAME subscription and must be one stored string (review 2, WR-02). The query is
 * kept on purpose - push services may carry the subscription token in it (WNS does).
 */
export function canonicalPushEndpoint(raw: string): string | null {
  const url = parseEndpoint(raw);
  if (!url) return null;
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.port !== "" && url.port !== "443") return null;
  const host = url.hostname.toLowerCase();
  if (host === "" || host.endsWith(".") || isIpLiteral(host)) return null;
  const allowed = PUSH_SERVICE_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
  if (!allowed) return null;
  url.hash = "";
  // Both parsers must agree on the raw input AND on the canonical string we would actually send.
  if (!legacyAgrees(raw, url) || !legacyAgrees(url.href, url)) return null;
  return url.href;
}

export function isAllowedPushEndpoint(raw: string): boolean {
  return canonicalPushEndpoint(raw) !== null;
}

/** The host of an endpoint for log lines (never the path: it is a capability), null if unparsable. */
export function pushEndpointHost(raw: string): string | null {
  const url = parseEndpoint(raw);
  return url ? url.hostname.toLowerCase() : null;
}
