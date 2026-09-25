/**
 * Phase 67b Plan 01 (issue #67) — pure day/weekday/period rules for `EmployeeSalonAssignment`.
 *
 * No Prisma call, no Fastify import — this module is unit-testable DB-free
 * (`salon-assignment-rules.test.ts`) and its helpers are not subject to the facade F1 rule
 * (`apps/api/scripts/lint-facade-signatures.ts` only walks `contexts/*\/facade/**`).
 *
 * Days are tenant-local calendar days, represented as `YYYY-MM-DD` strings — never a bare `Date`,
 * which would silently reintroduce a UTC-vs-tenant-timezone ambiguity this module exists to avoid.
 *
 * Weekday encoding: 0 = Monday … 6 = Sunday — identical to `EmployeeShiftPattern.dayOfWeek` and
 * `Salon.openingHours`, and deliberately NOT `WorkSchedule.workDays`'s encoding (0 = Sunday).
 *
 * `date-fns-tz` is imported directly here rather than through
 * `contexts/working-time-account/timezone.ts` (which wraps the same primitive). Per D-16,
 * `contexts/platform/index.ts` re-exports this module's facade — and that index's own docblock
 * forbids transitively reaching another context. Importing the working-time-account index here
 * would violate exactly that rule.
 */
import { formatInTimeZone } from "date-fns-tz";

/** A tenant-local calendar day, `YYYY-MM-DD`. */
export type CalendarDay = string;

/** The shape every read function needs to answer "is this row effective on day X". */
export interface AssignmentPeriod {
  validFrom: Date;
  validUntil: Date | null;
}

/**
 * The open-end sentinel used where a comparison needs a concrete upper bound instead of `null`
 * (e.g. widening a lock-check window in a later plan). Never stored — `validUntil: null` remains
 * the on-disk representation of "open-ended".
 */
export const FAR_FUTURE_DAY: CalendarDay = "9999-12-31";

/**
 * Pure UTC calendar arithmetic on a `YYYY-MM-DD` string — `n` may be negative. Never touches a
 * timezone: a calendar day plus/minus a whole number of days is timezone-independent by
 * definition, so this deliberately does NOT go through `date-fns-tz`.
 */
export function addDays(day: CalendarDay, n: number): CalendarDay {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

/**
 * UTC-midnight `Date` for a `YYYY-MM-DD` day — the shape a `@db.Date` write or filter needs
 * (Prisma serializes a `@db.Date` column from/to UTC midnight, never a local-timezone midnight).
 */
export function dayToDate(day: CalendarDay): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * `YYYY-MM-DD` of a `@db.Date` column value. Prisma returns a `@db.Date` column as a `Date` at UTC
 * midnight, so reading it back with `toISOString().slice(0, 10)` round-trips exactly — this is NOT
 * a tenant-timezone conversion (a `@db.Date` value has no timezone at all).
 */
export function dateToDay(date: Date): CalendarDay {
  return date.toISOString().slice(0, 10);
}

/** The tenant-local calendar day an instant falls on, given the tenant's IANA timezone. */
export function tenantLocalDay(instant: Date, tz: string): CalendarDay {
  return formatInTimeZone(instant, tz, "yyyy-MM-dd");
}

/**
 * The tenant-local weekday of an instant, as 0 = Monday … 6 = Sunday.
 *
 * date-fns' ISO weekday format token `i` already yields 1 = Monday … 7 = Sunday, so subtracting 1
 * gives 0 = Monday … 6 = Sunday directly — this is DELIBERATELY not built on
 * `getDayOfWeekInTz`/`getTenantTimezone`'s day-of-week helper family, whose `0 = Sunday` result
 * must never be compared against this module's `weekdays` arrays (67b-RESEARCH.md Pitfall 1).
 */
export function mondayBasedWeekday(instant: Date, tz: string): number {
  return Number(formatInTimeZone(instant, tz, "i")) - 1;
}

/** A row is voided (D-03) when it has an end date strictly before its own start date. */
export function isVoided(row: AssignmentPeriod): boolean {
  return row.validUntil !== null && row.validUntil.getTime() < row.validFrom.getTime();
}

/**
 * Phase 71b (issue #71): the Monday-based weekday (0 = Monday … 6 = Sunday) of a CALENDAR day
 * itself — timezone-free, unlike {@link mondayBasedWeekday} (which resolves the weekday of an
 * INSTANT in a given timezone). A calendar date's day of the week never depends on a timezone once
 * the date is fixed, so this reads the UTC-midnight `Date` {@link dayToDate} produces and converts
 * `getUTCDay()` (0 = Sunday … 6 = Saturday) into the same 0 = Monday … 6 = Sunday encoding every
 * other helper in this module uses.
 */
export function weekdayOfDay(day: CalendarDay): number {
  return (dayToDate(day).getUTCDay() + 6) % 7;
}

/**
 * A row is effective on `day` iff `validFrom <= day AND (validUntil IS NULL OR validUntil >= day)`
 * — this is the ONE definition every read/overlap check uses (D-03). A voided row (validUntil <
 * validFrom) can never satisfy this for any day, because no day is both `>= validFrom` and
 * `<= validUntil` when `validUntil < validFrom`.
 */
export function isEffectiveOn(row: AssignmentPeriod, day: CalendarDay): boolean {
  const target = dayToDate(day).getTime();
  if (row.validFrom.getTime() > target) return false;
  if (row.validUntil !== null && row.validUntil.getTime() < target) return false;
  return true;
}

/**
 * Two periods overlap iff both have at least one common effective day. A voided period (either
 * side) overlaps nothing — D-03's "effective on no day" applies here too. `validUntil: null` on
 * either side means "open", i.e. no upper bound for that side's comparison.
 */
export function periodsOverlap(a: AssignmentPeriod, b: AssignmentPeriod): boolean {
  if (isVoided(a) || isVoided(b)) return false;
  const aEnd = a.validUntil?.getTime() ?? Infinity;
  const bEnd = b.validUntil?.getTime() ?? Infinity;
  return a.validFrom.getTime() <= bEnd && b.validFrom.getTime() <= aEnd;
}

/** The shape {@link toAssignmentDto} accepts — a superset of the Prisma row (id, kind, weekdays). */
export interface AssignmentRow extends AssignmentPeriod {
  id: string;
  employeeId: string;
  salonId: string;
  kind: "HOME" | "DEPLOYMENT";
  weekdays: number[];
  createdAt: Date;
  updatedAt: Date;
}

/** The API-facing shape of an assignment row — dates as `YYYY-MM-DD` strings (D-20). */
export interface AssignmentDto {
  id: string;
  employeeId: string;
  salonId: string;
  kind: "HOME" | "DEPLOYMENT";
  validFrom: CalendarDay;
  validUntil: CalendarDay | null;
  weekdays: number[];
  createdAt: Date;
  updatedAt: Date;
}

/** Converts a Prisma `EmployeeSalonAssignment` row into its API-facing DTO shape (D-20). */
export function toAssignmentDto(row: AssignmentRow): AssignmentDto {
  return {
    id: row.id,
    employeeId: row.employeeId,
    salonId: row.salonId,
    kind: row.kind,
    validFrom: dateToDay(row.validFrom),
    validUntil: row.validUntil !== null ? dateToDay(row.validUntil) : null,
    weekdays: row.weekdays,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── Phase 67b Plan 02 (issue #67) additions — write-surface rules (D-04, D-10, D-20, D-27) ──────

const CALENDAR_DAY_SHAPE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * D-20: `value` has the `YYYY-MM-DD` shape AND is a REAL calendar day — an impossible date like
 * "2026-02-30" has the right shape but does not round-trip through {@link dayToDate}/
 * {@link dateToDay} (JS's `Date.UTC` rolls it over into March), so the round-trip comparison below
 * catches it without a hand-rolled per-month day-count table.
 */
export function isCalendarDay(value: string): value is CalendarDay {
  if (!CALENDAR_DAY_SHAPE_RE.test(value)) return false;
  return dateToDay(dayToDate(value)) === value;
}

/** D-04: distinct weekday codes (0..6), sorted ascending — the ONE normalised shape every stored
 * `weekdays` array takes, so two arrays denoting the same set always compare equal. */
export function normalizeWeekdays(list: number[]): number[] {
  return Array.from(new Set(list)).sort((a, b) => a - b);
}

/**
 * D-10/D-27: German adverb per weekday code, 0 = Monday … 6 = Sunday — the display label is always
 * DERIVED from the code (CLAUDE.md "never use a new display string as a control value"), never the
 * reverse; nothing in this module ever compares against these strings.
 */
export const WEEKDAY_ADVERB_DE: Readonly<Record<number, string>> = {
  0: "montags",
  1: "dienstags",
  2: "mittwochs",
  3: "donnerstags",
  4: "freitags",
  5: "samstags",
  6: "sonntags",
};

/**
 * D-10: the LOWEST weekday code present in both `a` and `b`, or `null` if they share none. Either
 * array being empty (a DEPLOYMENT with no weekday restriction never weekday-conflicts, D-10) yields
 * `null` by construction.
 */
export function firstCommonWeekday(a: number[], b: number[]): number | null {
  const bSet = new Set(b);
  const common = a.filter((day) => bSet.has(day));
  if (common.length === 0) return null;
  return Math.min(...common);
}

// ── Phase 71b (issue #71) addition — the ONE per-day salon pick rule (D-04) ──────────────────────

/** The subset of {@link AssignmentRow} {@link pickSalonForDay} needs. */
export type PickSalonForDayRow = Pick<
  AssignmentRow,
  "id" | "salonId" | "kind" | "weekdays" | "validFrom" | "validUntil"
>;

/** The answer to "which salon does an employee probably work in on this day?" — the shared return
 * shape of {@link pickSalonForDay}, `salonForDay` (`facade/salon-assignments.ts`) and, per-day, the
 * batched `salonsForDays`. */
export interface PickedSalonForDay {
  salonId: string;
  kind: "HOME" | "DEPLOYMENT";
  assignmentId: string;
}

/**
 * D-16/D-04: the ONE statement of the per-day salon rule. Both `salonForDay` and `salonsForDays`
 * (`facade/salon-assignments.ts`) call this — never re-implement it — so the single-employee and
 * the batched form can never drift apart (a parity test in `holiday-resolution.test.ts` pins this).
 *
 * `rows` must already be the FULL set of one employee's assignment rows, in `validFrom asc, id asc`
 * order — this function does not sort or filter by employee, it only picks among what it is given.
 * Returns the first effective DEPLOYMENT whose `weekdays` contain the weekday of `day` itself
 * ({@link weekdayOfDay} — timezone-free, a calendar date's weekday needs no conversion), else the
 * first effective HOME row, else `null` (no matching row at all — e.g. a legacy fixture, or a day
 * with no assignment rows loaded for it).
 */
export function pickSalonForDay(
  rows: readonly PickSalonForDayRow[],
  day: CalendarDay,
): PickedSalonForDay | null {
  const weekday = weekdayOfDay(day);
  const effective = rows.filter((row) => isEffectiveOn(row, day));

  const deployment = effective.find(
    (row) => row.kind === "DEPLOYMENT" && row.weekdays.includes(weekday),
  );
  if (deployment) {
    return { salonId: deployment.salonId, kind: "DEPLOYMENT", assignmentId: deployment.id };
  }

  const home = effective.find((row) => row.kind === "HOME");
  if (home) {
    return { salonId: home.salonId, kind: "HOME", assignmentId: home.id };
  }

  return null;
}
