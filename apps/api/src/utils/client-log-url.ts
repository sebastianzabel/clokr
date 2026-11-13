// Issue #610 (review WR-02): the client error log stores a page URL, never its query string or
// fragment. A query can carry a one-time device pairing code (`?code=`) or the sign-in leg that
// leads to the pairing page (`?next=`), and a log reader has no use for either.

/** The URL up to (not including) the first "?" or "#", capped at 500 characters. */
export function clientLogUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return raw.split(/[?#]/)[0].slice(0, 500);
}
