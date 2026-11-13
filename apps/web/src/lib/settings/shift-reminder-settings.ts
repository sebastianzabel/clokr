/**
 * Shift reminder form helpers (Issue #609, D-01).
 *
 * Mirror the API bounds of the five reminder keys of PUT /settings/work: the offset is an
 * integer 5-120 and the evening time is HH:MM (00:00-23:59). The API fields are `.optional()`
 * and not `.nullable()`, so a cleared input (Svelte's bind:value yields null) must never reach
 * the wire: it would fail the whole-page PUT and nothing else on the page would save either.
 */

export const REMINDER_OFFSET_MIN = 5;
export const REMINDER_OFFSET_MAX = 120;
export const DEFAULT_REMINDER_OFFSET_MINUTES = 15;
export const DEFAULT_DAY_CLOSE_TIME = "20:00";

const DAY_CLOSE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Rounds to a whole minute and clamps to 5-120; an empty or non-numeric input becomes 15. */
export function clampReminderOffsetInput(raw: number | null | undefined): number {
  if (raw === null || raw === undefined || (raw as unknown) === "") {
    return DEFAULT_REMINDER_OFFSET_MINUTES;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_REMINDER_OFFSET_MINUTES;
  return Math.min(REMINDER_OFFSET_MAX, Math.max(REMINDER_OFFSET_MIN, Math.round(n)));
}

/** Returns the time when it is a valid HH:MM, else the default evening time 20:00. */
export function normalizeDayCloseTimeInput(raw: string | null | undefined): string {
  if (typeof raw === "string" && DAY_CLOSE_TIME_RE.test(raw)) return raw;
  return DEFAULT_DAY_CLOSE_TIME;
}
