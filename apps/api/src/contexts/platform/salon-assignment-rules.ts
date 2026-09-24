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
