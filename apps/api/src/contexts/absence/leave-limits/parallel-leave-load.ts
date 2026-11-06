/**
 * Issue #836 (D-836-03) — the pure counting kernel, the ONLY place parallel leave is counted.
 *
 * It takes prepared person-day rows (the loader and the checker decide which days count and which
 * salon and groups a person belongs to) and folds them into a load per salon x group x day, keeping
 * the person ids behind each count. No I/O. Counting rule: a person counts ONCE per salon, group and
 * day, however many requests cover that day; a person in two groups appears in both groups.
 */
export type CountedPersonDay = {
  personId: string;
  /** The request behind the row; null for a hypothetical row (a #835 wish). */
  requestId: string | null;
  /** `YYYY-MM-DD`. */
  day: string;
  /** The person's Stammsalon on that day. */
  salonId: string;
  /** Group keys the person belongs to on that day (see `groupMembershipOn`). */
  groups: readonly string[];
};

/** salonId -> groupKey -> day -> the distinct persons on leave. */
export type LeaveLoad = Map<string, Map<string, Map<string, Set<string>>>>;

export function parallelLeaveLoad(rows: readonly CountedPersonDay[]): LeaveLoad {
  const load: LeaveLoad = new Map();
  for (const row of rows) {
    let bySalon = load.get(row.salonId);
    if (!bySalon) {
      bySalon = new Map();
      load.set(row.salonId, bySalon);
    }
    for (const groupKey of row.groups) {
      let byDay = bySalon.get(groupKey);
      if (!byDay) {
        byDay = new Map();
        bySalon.set(groupKey, byDay);
      }
      let persons = byDay.get(row.day);
      if (!persons) {
        persons = new Set();
        byDay.set(row.day, persons);
      }
      persons.add(row.personId);
    }
  }
  return load;
}
