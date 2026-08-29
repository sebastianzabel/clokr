/**
 * deep-link.ts
 *
 * Phase 112 (GitHub issue #115) — receiver-side hardening for the two deep links that point at
 * /time-entries:
 *   - `?date=<day>`      — the dashboard "Pause bestätigen" nudge
 *   - `?highlight=<id>`  — the BREAK_UNCONFIRMED notification (sent since Phase 92-05,
 *                          apps/api/src/plugins/attendance-checker.ts, never read until now)
 *
 * WHY: the destination computed `new Date(param + "T12:00:00")` and fed the result straight into
 * date-fns `format()` and into MonthBar's `Intl.DateTimeFormat(...).format()`. Both THROW
 * `RangeError: Invalid time value` on an invalid Date, and apps/web/src has no <svelte:boundary>
 * anywhere, so the page just rendered empty with `loading === false`. A URL param is untrusted
 * text; it must be validated before it can reach a Date.
 */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reduces a `?date=` URL parameter to a plain, REAL calendar day, or `null` when it is unusable.
 * Callers must treat `null` as "no date param" and fall back to their default month — never
 * assign an unvalidated value to a Date.
 */
export function normalizeDateParam(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const day = raw.split("T")[0];
  if (!ISO_DAY.test(day)) return null;

  // Shape is not enough: "2026-13-01" and "2026-02-30" match the regex but are not real days.
  // A plain NaN probe is ALSO not enough — V8 falls back to a lenient parser that silently
  // ROLLS OVER an out-of-range day ("2026-02-30T12:00:00" becomes 2026-03-02, a valid Date).
  // So round-trip the components: only a day the engine gives back unchanged is real.
  // Local noon is deliberate — it keeps the local getters free of any DST/UTC edge shift.
  const probe = new Date(`${day}T12:00:00`);
  if (Number.isNaN(probe.getTime())) return null;
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  if (
    probe.getFullYear() !== year ||
    probe.getMonth() + 1 !== month ||
    probe.getDate() !== dayOfMonth
  ) {
    return null;
  }
  return day;
}

export interface FocusableEntry {
  id: string;
  /** Full ISO instant as sent by the API, or a plain day. */
  date: string;
}

export interface FocusTarget {
  entryId: string | null;
  day: string | null;
}

/**
 * Decides which list row the page should highlight and scroll to.
 *
 * `?highlight=` wins when it resolves against the ALREADY LOADED entries — the notification only
 * ever targets an entry in the current month, which is the page's default window, so no extra
 * fetch is needed. An unknown id (foreign, deleted, other month) resolves to `null`: nothing is
 * focused, nothing throws, and the caller learns nothing about whether the id exists.
 */
export function resolveFocusTarget(
  entries: FocusableEntry[] | null | undefined,
  highlightId: string | null | undefined,
  day: string | null | undefined,
): FocusTarget {
  const rows = entries ?? [];

  if (highlightId) {
    const hit = rows.find((e) => e.id === highlightId);
    if (hit) return { entryId: hit.id, day: normalizeDateParam(hit.date) };
  }

  if (day) {
    const hit = rows.find((e) => normalizeDateParam(e.date) === day);
    return { entryId: hit?.id ?? null, day };
  }

  return { entryId: null, day: null };
}
