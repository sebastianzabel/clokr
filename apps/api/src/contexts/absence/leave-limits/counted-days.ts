/**
 * Issue #836 (D-836-04) — which days of one leave row count toward a limit. Pure, no I/O.
 *
 * A day counts iff it lies in the row clipped to the window, the person is employed and not
 * anonymised, has a Stammsalon (HOME row) that day, would work that day, and — for VACATION only —
 * is not a Berufsschule day (the same displacement the leave pricing applies, D-836-20). A half
 * day counts as one person. The workday set is prepared by the loader: the tracer fills it from the
 * contract weekday set, 836-02 adds holidays, the SHIFT_BASED roster and Berufsschule.
 */
export type PersonDayFacts = {
  personId: string;
  /** Stammsalon per day (HOME rows only); null / missing = no salon, the day never counts. */
  homeSalonByDay: ReadonlyMap<string, string | null>;
  /** Days on which the person is employed (inclusive hire/exit bounds, tenant-local). */
  employedDays: ReadonlySet<string>;
  anonymized: boolean;
  /** Days the person would work. */
  workdays: ReadonlySet<string>;
  /** Berufsschule days; they displace VACATION only. */
  vocationalSchoolDays: ReadonlySet<string>;
};

export type CountableLeaveRow = { typeCode: string; startDay: string; endDay: string };

/** Every `YYYY-MM-DD` from `fromDay` to `toDay` inclusive; empty when `fromDay > toDay`. */
export function eachDay(fromDay: string, toDay: string): string[] {
  const days: string[] = [];
  const end = new Date(`${toDay}T00:00:00Z`).getTime();
  for (let t = new Date(`${fromDay}T00:00:00Z`).getTime(); t <= end; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

export function countedDaysOfLeave(
  person: PersonDayFacts,
  row: CountableLeaveRow,
  window: { fromDay: string; toDay: string },
): Array<{ day: string; salonId: string }> {
  if (person.anonymized) return [];
  const from = row.startDay > window.fromDay ? row.startDay : window.fromDay;
  const to = row.endDay < window.toDay ? row.endDay : window.toDay;
  const counted: Array<{ day: string; salonId: string }> = [];
  for (const day of eachDay(from, to)) {
    if (!person.employedDays.has(day)) continue;
    const salonId = person.homeSalonByDay.get(day) ?? null;
    if (salonId === null) continue;
    if (!person.workdays.has(day)) continue;
    if (row.typeCode === "VACATION" && person.vocationalSchoolDays.has(day)) continue;
    counted.push({ day, salonId });
  }
  return counted;
}
