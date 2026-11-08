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
 * Splits `rows` into the rows the reader may see in detail and the masked ranges of the others.
 * `detailed(row)` is the caller's per-row decision; `effectiveStatuses` are the statuses that
 * count as an absence (a masked candidate with another status is dropped).
 *
 * Output order of the masked ranges: by `employeeId`, then `startDate`. The detailed rows keep
 * their input order and are returned unchanged.
 */
export function maskCalendarRows<T extends MaskableCalendarRow>(
  rows: readonly T[],
  detailed: (row: T) => boolean,
  effectiveStatuses: ReadonlySet<string>,
): { detailed: T[]; masked: MaskedCalendarEntry[] } {
  const keep: T[] = [];
  const candidates: MaskedCalendarEntry[] = [];

  for (const row of rows) {
    if (detailed(row)) {
      keep.push(row);
      continue;
    }
    if (!effectiveStatuses.has(row.status)) continue;
    candidates.push({
      employeeId: row.employeeId,
      firstName: row.firstName,
      lastName: row.lastName,
      startDate: row.startDate,
      endDate: row.endDate,
      isOwn: false,
      masked: true,
    });
  }

  candidates.sort((a, b) =>
    a.employeeId === b.employeeId
      ? a.startDate < b.startDate
        ? -1
        : a.startDate > b.startDate
          ? 1
          : 0
      : a.employeeId < b.employeeId
        ? -1
        : 1,
  );

  const masked: MaskedCalendarEntry[] = [];
  for (const entry of candidates) {
    const prev = masked[masked.length - 1];
    if (
      prev !== undefined &&
      prev.employeeId === entry.employeeId &&
      entry.startDate <= nextDay(prev.endDate)
    ) {
      if (entry.endDate > prev.endDate) prev.endDate = entry.endDate;
      continue;
    }
    masked.push({ ...entry });
  }

  return { detailed: keep, masked };
}
