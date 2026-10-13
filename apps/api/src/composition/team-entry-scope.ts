/**
 * Issue #85 (D-04/D-05) — pure partition helpers of the dashboard's week grid.
 *
 * The composition layer owns no model and carries no rule. Which time entries a scoped caller may
 * see is decided ONCE, in the Unterbau (`scopedTimeEntryIds`); this module only partitions rows by
 * that id set — it never re-derives a salon or a Stammsalon rule. Everything here is DB-free: the
 * handler reads the rows and passes them in.
 *
 * The idea: a scoped caller sees the entries of the in-scope id set and nothing else. A person
 * whose entries are only partly in scope keeps a neutral mark for the rest ("worked elsewhere"),
 * never an hour, a time or a live clock-in of the hidden part.
 */
import type { PresenceEntry } from "../contexts/time-tracking";

/** The minimal row shape these helpers read (a subset of a recorded WORK entry). */
export interface ScopedEntryRow {
  employeeId: string;
  isInvalid: boolean;
}

/** `${employeeId}::${day}` — the key of one person-day in every map this module returns. */
export function personDayKey(employeeId: string, dayStr: string): string {
  return `${employeeId}::${dayStr}`;
}

/**
 * Per person-day: how many VALID rows of `allRows` are not among `inScopeRows`, by count
 * comparison (the rows read without an id column cannot be matched by id). Invalid rows never
 * count — they are not working time and not presence. Only person-days with a positive remainder
 * appear in the map; a person-day covered completely is absent.
 */
export function outOfScopeValidCounts<A extends ScopedEntryRow, B extends ScopedEntryRow>(
  allRows: readonly A[],
  inScopeRows: readonly B[],
  dayKeyOf: (row: A | B) => string,
): Map<string, number> {
  const remaining = new Map<string, number>();
  for (const row of allRows) {
    if (row.isInvalid) continue;
    const key = personDayKey(row.employeeId, dayKeyOf(row));
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  for (const row of inScopeRows) {
    if (row.isInvalid) continue;
    const key = personDayKey(row.employeeId, dayKeyOf(row));
    const left = remaining.get(key);
    if (left !== undefined) remaining.set(key, left - 1);
  }
  const result = new Map<string, number>();
  for (const [key, left] of remaining) {
    if (left > 0) result.set(key, left);
  }
  return result;
}

/**
 * The persons whose number of rows in `allRows` equals their number in `inScopeRows` — nothing of
 * theirs is hidden. `personIds` lists persons that should be judged even if they appear in no row
 * (zero rows on both sides is covered).
 */
export function fullyCoveredPersons<R extends ScopedEntryRow>(
  allRows: readonly R[],
  inScopeRows: readonly R[],
  personIds: Iterable<string> = [],
): Set<string> {
  const total = new Map<string, number>();
  const visible = new Map<string, number>();
  for (const id of personIds) {
    total.set(id, 0);
    visible.set(id, 0);
  }
  for (const row of allRows) total.set(row.employeeId, (total.get(row.employeeId) ?? 0) + 1);
  for (const row of inScopeRows) {
    visible.set(row.employeeId, (visible.get(row.employeeId) ?? 0) + 1);
    if (!total.has(row.employeeId)) total.set(row.employeeId, 0);
  }
  const covered = new Set<string>();
  for (const [id, count] of total) {
    if ((visible.get(id) ?? 0) === count) covered.add(id);
  }
  return covered;
}

/**
 * A fixed non-null end time: the closed stand-in of hidden time. Its value is never read — the
 * presence resolver only asks whether `endTime` is null.
 */
const CLOSED_STAND_IN_END = new Date(0);

/**
 * The presence input of one person-day for a scoped caller: the in-scope rows as they are, plus
 * one CLOSED valid stand-in per hidden valid row. A hidden entry that is still open must not turn
 * into `clocked_in` — that would reveal a live clock-in in a salon the caller cannot see — so the
 * stand-in is always closed: the day reads as "present", never as "clocked in".
 */
export function presenceEntriesWithStandIns(
  inScopeDayRows: readonly { endTime: Date | null; isInvalid: boolean }[],
  outOfScopeValidCount: number,
): PresenceEntry[] {
  const entries: PresenceEntry[] = inScopeDayRows.map((e) => ({
    endTime: e.endTime,
    isInvalid: e.isInvalid,
  }));
  for (let i = 0; i < outOfScopeValidCount; i++) {
    entries.push({ endTime: CLOSED_STAND_IN_END, isInvalid: false });
  }
  return entries;
}

/** The distinct employee ids of `rows`, in ascending order. */
export function distinctEmployeeIds(rows: readonly { employeeId: string }[]): string[] {
  return [...new Set(rows.map((r) => r.employeeId))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
