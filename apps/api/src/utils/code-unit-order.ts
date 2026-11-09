/**
 * Ascending by UTF-16 code unit — the same order as a bare `.sort()`, stated explicitly and
 * locale-independent (never `localeCompare`, whose order depends on the runtime's locale data).
 * Used where ids, ISO days or codes are sorted for a stable answer.
 */
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
