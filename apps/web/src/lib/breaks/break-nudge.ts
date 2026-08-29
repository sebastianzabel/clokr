/**
 * break-nudge.ts
 *
 * Phase 112 (GitHub issue #115) — presentation helpers for the dashboard's
 * "N Tage: Pause bestätigen" nudge (§ 4 ArbZG Pflichtpause, breakStatus = "AUTO").
 *
 * WHY THIS MODULE EXISTS: `dashboard/+page.svelte` used to forward the raw API value
 * `row.date` into the deep link. `TimeEntry.date` is `DateTime @db.Date` and
 * `GET /api/v1/time-entries` carries NO Fastify response schema, so the JSON value is the
 * full ISO instant "2026-08-05T00:00:00.000Z" — never "2026-08-05". The destination then
 * computed `new Date(param + "T12:00:00")` → Invalid Date → `format()` threw a RangeError
 * before `loadAll()` ran, and with no <svelte:boundary> anywhere in apps/web/src the page
 * simply looked empty. Shipped in 18c27fcc with no test on the emitted URL; this module
 * exists so that URL is unit-testable (route pages cannot be mounted — see vitest.config.ts).
 *
 * The RULE for what counts as unconfirmed lives server-side in
 * apps/api/src/utils/find-unconfirmed-break-days.ts and is deliberately NOT the same window
 * as this client-side counter (12 months here vs. the current month there). Resolving that
 * divergence is explicitly out of scope for issue #115 — see the phase deferred-items.md.
 */

export interface UnconfirmedBreakRow {
  /** Full ISO instant as sent by the API ("2026-08-05T00:00:00.000Z"), or a plain day. */
  date: string;
  breakStatus?: string | null;
  isLocked?: boolean | null;
}

export interface BreakNudgeSummary {
  count: number;
  /** Ascending, distinct, "YYYY-MM-DD". */
  days: string[];
  /** Oldest / most overdue day — the deep-link target. */
  earliestDay: string | null;
  label: string;
}

export const BREAK_NUDGE_EMPTY: BreakNudgeSummary = {
  count: 0,
  days: [],
  earliestDay: null,
  label: "",
};

/**
 * Normalizes an API date value to a plain calendar day. This single `.split("T")[0]` is the
 * fix for issue #115 — every other consumer of `TimeEntry.date` in apps/web already does it
 * (e.g. time-entries/+page.svelte:534, :1565).
 */
export function toBreakDayString(raw: string): string {
  return raw.split("T")[0];
}

export function summarizeUnconfirmedBreaks(
  rows: UnconfirmedBreakRow[] | null | undefined,
): BreakNudgeSummary {
  const distinct = new Set<string>();
  for (const row of rows ?? []) {
    if (row.breakStatus !== "AUTO") continue;
    if (row.isLocked === true) continue; // a closed month is immutable and un-actionable
    if (!row.date) continue;
    distinct.add(toBreakDayString(row.date));
  }

  const count = distinct.size;
  if (count === 0) return BREAK_NUDGE_EMPTY;

  // ISO yyyy-MM-dd sorts lexicographically, so ascending order puts the oldest first.
  const days = [...distinct].sort((a, b) => a.localeCompare(b));
  return {
    count,
    days,
    earliestDay: days[0],
    label: count === 1 ? "1 Tag: Pause bestätigen" : `${count} Tage: Pause bestätigen`,
  };
}

export function breakNudgeHref(summary: BreakNudgeSummary): string {
  return summary.earliestDay
    ? `/time-entries?view=list&date=${summary.earliestDay}`
    : "/time-entries?view=list";
}
