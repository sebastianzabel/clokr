/**
 * Issue #840 (D-840-19) — the masking kernel of `GET /leave/calendar`. Pure, no I/O.
 *
 * A calendar row of a person the reader may not read (outside the `leave-request:read` reach on
 * every day of the row) is not handed out in detail. It becomes a masked range that says only
 * "this person is absent" — name, first and last day, nothing else: no id, status, half day, type
 * or § 9 marker (Art. 9 DSGVO — the type of an absence can be a health datum).
 *
 *  - Only effective rows are masked. A PENDING request of a person outside the reach is not (yet)
 *    an absence, so it is dropped, not shown (Phase 262 D-05).
 *  - Overlapping or adjacent masked ranges of one person are merged, so the seam between two
 *    absences of different kinds (e.g. a sick spell right after a vacation) cannot be read off.
 *  - A masked range is clipped to the window the reader asked for BEFORE the merge. The stored
 *    length of an absence (14 weeks around a due date, a year of Elternzeit) would otherwise be
 *    readable from the dates alone, and the answer would carry more than the window it answers
 *    (Art. 9 DSGVO, Art. 5 Abs. 1 lit. c; review WR-03).
 *
 * The visibility decision is the caller's callback; the rule itself lives only in
 * `leave-limits/redact.ts` (`isPersonVisibleOnSomeDay`, #836), so there is no second visibility
 * rule here.
 *
 * Zero runtime imports, so it can never join the measured import cycle.
 */

/** The fields the kernel reads from a calendar row; `startDate`/`endDate` are `YYYY-MM-DD`. */
export interface MaskableCalendarRow {
  employeeId: string;
  firstName: string;
  lastName: string;
  startDate: string;
  endDate: string;
  status: string;
  isOwn: boolean;
}

/** The ONLY shape a foreign absence has outside the reach — exactly these seven keys. */
export interface MaskedCalendarEntry {
  employeeId: string;
  firstName: string;
  lastName: string;
  startDate: string;
  endDate: string;
  isOwn: false;
  masked: true;
}

/** `YYYY-MM-DD` plus one calendar day, in UTC (string arithmetic, no time zone involved). */
function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Clips a day range (`YYYY-MM-DD`, inclusive) to a window; `null` when nothing of it lies inside.
 * Shared by the calendar and the planner (D-840-20), so both clip masked ranges the same way.
 */
export function clipDayRange(
  range: { startDate: string; endDate: string },
  window: { from: string; to: string },
): { startDate: string; endDate: string } | null {
  const startDate = range.startDate < window.from ? window.from : range.startDate;
  const endDate = range.endDate > window.to ? window.to : range.endDate;
  return startDate > endDate ? null : { startDate, endDate };
}

/**
 * Merges day ranges (`YYYY-MM-DD`, inclusive) that overlap or touch into one range; the result is
 * sorted by start. Shared by the calendar (per person) and the planner (D-840-20), so both hide the
 * seam between two absences of different kinds the same way. Callers group by person first.
 */
export function mergeDayRanges<T extends { startDate: string; endDate: string }>(
  ranges: readonly T[],
): Array<{ startDate: string; endDate: string }> {
  const sorted = [...ranges].sort((a, b) =>
    a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0,
  );
  const merged: Array<{ startDate: string; endDate: string }> = [];
  for (const range of sorted) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && range.startDate <= nextDay(prev.endDate)) {
      if (range.endDate > prev.endDate) prev.endDate = range.endDate;
      continue;
    }
    merged.push({ startDate: range.startDate, endDate: range.endDate });
  }
  return merged;
}

/**
 * Splits `rows` into the rows the reader may see in detail and the masked ranges of the others.
 * `detailed(row)` is the caller's per-row decision; `effectiveStatuses` are the statuses that
 * count as an absence (a masked candidate with another status is dropped).
 *
 * `window` (inclusive calendar days) clips every masked range before the merge; detailed rows keep
 * their real range (the reader may read them).
 *
 * Output order of the masked ranges: by `employeeId`, then `startDate`. The detailed rows keep
 * their input order and are returned unchanged.
 */
export function maskCalendarRows<T extends MaskableCalendarRow>(
  rows: readonly T[],
  detailed: (row: T) => boolean,
  effectiveStatuses: ReadonlySet<string>,
  window?: { from: string; to: string },
): { detailed: T[]; masked: MaskedCalendarEntry[] } {
  const keep: T[] = [];
  const candidates: MaskedCalendarEntry[] = [];

  for (const row of rows) {
    if (detailed(row)) {
      keep.push(row);
      continue;
    }
    if (!effectiveStatuses.has(row.status)) continue;
    const range = window ? clipDayRange(row, window) : row;
    if (range === null) continue;
    candidates.push({
      employeeId: row.employeeId,
      firstName: row.firstName,
      lastName: row.lastName,
      startDate: range.startDate,
      endDate: range.endDate,
      isOwn: false,
      masked: true,
    });
  }

  candidates.sort((a, b) =>
    a.employeeId === b.employeeId ? 0 : a.employeeId < b.employeeId ? -1 : 1,
  );

  const masked: MaskedCalendarEntry[] = [];
  for (let i = 0; i < candidates.length;) {
    let j = i;
    while (j < candidates.length && candidates[j].employeeId === candidates[i].employeeId) j++;
    const person = candidates[i];
    for (const range of mergeDayRanges(candidates.slice(i, j))) {
      masked.push({ ...person, startDate: range.startDate, endDate: range.endDate });
    }
    i = j;
  }

  return { detailed: keep, masked };
}
