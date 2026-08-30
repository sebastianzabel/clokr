/**
 * break-nudge.ts
 *
 * Phase 112 (GitHub issue #115) — presentation helpers for the dashboard's
 * "N Tage: Pause bestätigen" nudge (§ 4 ArbZG Pflichtpause, auto-inserted and unconfirmed).
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
 * Phase 126 (GitHub issue #126): the RULE for what counts as unconfirmed is no longer applied
 * here at all. The dashboard used to re-derive it client-side over a 12-MONTH window while the
 * canonical detector (apps/api/src/utils/find-unconfirmed-break-days.ts) measured the CURRENT
 * MONTH with a type:"WORK" filter and a MONTHLY_HOURS/FLEXTIME exclusion — so the card demanded
 * action on days the backend does not know about. The count now arrives ready-made as
 * `unconfirmedBreakDays` on GET /api/v1/dashboard/open-items. This module is PRESENTATION ONLY:
 * German copy, ordering and the deep-link URL. If you find yourself adding a filter here, the
 * filter belongs in the detector instead — that is the whole point of this phase.
 */

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

/**
 * Presentation summary over the server-supplied day list. No filtering happens here —
 * `days` already IS the canonical answer (see the module header).
 */
export function summarizeUnconfirmedBreakDays(
  days: string[] | null | undefined,
): BreakNudgeSummary {
  const distinct = new Set<string>();
  for (const raw of days ?? []) {
    if (!raw) continue;
    // Defence in depth for issue #115: the server sends plain "YYYY-MM-DD", but a full ISO
    // instant must never be able to reach the ?date= param again.
    distinct.add(toBreakDayString(raw));
  }

  const count = distinct.size;
  if (count === 0) return BREAK_NUDGE_EMPTY;

  // ISO yyyy-MM-dd sorts lexicographically, so ascending order puts the oldest first.
  const sorted = [...distinct].sort((a, b) => a.localeCompare(b));
  return {
    count,
    days: sorted,
    earliestDay: sorted[0],
    label: count === 1 ? "1 Tag: Pause bestätigen" : `${count} Tage: Pause bestätigen`,
  };
}

export function breakNudgeHref(summary: BreakNudgeSummary): string {
  return summary.earliestDay
    ? `/time-entries?view=list&date=${summary.earliestDay}`
    : "/time-entries?view=list";
}
