/**
 * Issue #608 (D-17, P-608-04) - the ONE place that decides which push-service endpoints the server
 * will ever send to.
 *
 * A web-push endpoint is a URL chosen by the client, and the server later makes an outbound HTTPS
 * request to it with a signed VAPID token. Without an allow-list that is an SSRF primitive, so an
 * endpoint is accepted only when it is a plain https URL on port 443 whose host is one of the four
 * push services of the supported browsers (or a sub-domain of one). Everything else is refused
 * before any write.
 */

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

export function isAllowedPushEndpoint(raw: string): boolean {
  const url = parseEndpoint(raw);
  if (!url) return false;
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.port !== "" && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  if (host === "" || host.endsWith(".") || isIpLiteral(host)) return false;
  return PUSH_SERVICE_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

/** The host of an endpoint for log lines (never the path: it is a capability), null if unparsable. */
export function pushEndpointHost(raw: string): string | null {
  const url = parseEndpoint(raw);
  return url ? url.hostname.toLowerCase() : null;
}
