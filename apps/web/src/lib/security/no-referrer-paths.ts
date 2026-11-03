// Issue #610 (review WR-01): the device pairing page carries a one-time code in its query, and the
// sign-in leg that leads to it carries the same code inside `?next=`. Browsers send the full URL of
// a same-origin page as `Referer` on every sub-request (chunks, API calls), and ingress access logs
// record it. These pages therefore send no referrer at all (hooks.server.ts sets the header); every
// other page keeps the browser default.

const NO_REFERRER_PATHS = new Set(["/login", "/otp", "/settings/geraet-koppeln"]);

export function sendsNoReferrer(pathname: string): boolean {
  const normalized =
    pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return NO_REFERRER_PATHS.has(normalized);
}
