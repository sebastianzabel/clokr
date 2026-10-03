/**
 * Issue #468, finding 4 (D-08/D-09/A-1) — § 17 Abs. 1 Satz 1 BEEG: Elternzeit-Kürzung.
 *
 * The employer MAY reduce the regular vacation entitlement by one twelfth for every FULL
 * calendar month of Elternzeit (parental leave) the employee takes — but only when the employer
 * explicitly DECLARES this to the employee ("Erklärung gegenüber dem Mitarbeiter"); it is never
 * automatic (owner decision on Issue #451, comment 2026-10-03, carried into this phase's D-08).
 * A-1 (orchestrator amendment): in this codebase Elternzeit is a `LeaveRequest` of leave-type
 * code `PARENTAL`, not an `Absence` — the reduction anchors on that approved request.
 *
 * This module holds the PURE month-counting/rounding functions (no DB access, no side effects)
 * plus the read-only preview builder. `api/parental-leave-reductions.ts` owns every write path
 * (commit, revoke) and every permission/scope/tenant guard.
 */
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import { resolveRegularVacationDays } from "./leave-days";
import { getVacationEntitlement } from "./facade/entitlements";
import { roundVacationDaysBurlG } from "./vacation-calc";

// Prisma client shape shared by `app.prisma` (top-level) and the `tx` handle inside a
// $transaction — same alias as leave-days.ts's own private DbClient (Issue #468 plan 07).
type DbClient = FastifyInstance["prisma"] | Prisma.TransactionClient;

/** One calendar year touched by an Elternzeit span, with the count of FULL calendar months of
 * that Elternzeit falling inside it. A year with zero full months is still included — a caller
 * never has to special-case "the year exists but nothing in it". */
export interface ParentalMonthsInYear {
  year: number;
  months: number;
}

/**
 * Every FULL calendar month of `[start, end]` (inclusive), grouped by calendar year, from
 * `start`'s UTC year through `end`'s UTC year, ascending. A month counts as full when the span
 * covers it entirely: `start <= firstOfMonth` AND `end >= lastOfMonth`. UTC accessors
 * throughout — a host timezone must never move a month boundary (AC-4 "volle Kalendermonate").
 */
export function fullCalendarMonthsByYear(start: Date, end: Date): ParentalMonthsInYear[] {
  const startYear = start.getUTCFullYear();
  const endYear = end.getUTCFullYear();
  const startTime = start.getTime();
  const endTime = end.getTime();
  const result: ParentalMonthsInYear[] = [];

  for (let year = startYear; year <= endYear; year++) {
    let months = 0;
    for (let month = 0; month < 12; month++) {
      const firstOfMonth = Date.UTC(year, month, 1);
      const lastOfMonth = Date.UTC(year, month + 1, 0); // day 0 of next month = last day of this one
      if (startTime <= firstOfMonth && endTime >= lastOfMonth) {
        months++;
      }
    }
    result.push({ year, months });
  }
  return result;
}

/**
 * The regular entitlement remaining AFTER `months` full calendar months of Elternzeit, per
 * § 17 Abs. 1 Satz 1 BEEG (one twelfth per month). `months` is clamped to [0, 12]. Rounding
 * (Issue #421, § 5 Abs. 2 BUrlG: a fraction ≥ 0.5 rounds UP) is applied to the REMAINING
 * entitlement, never to the reduction itself — so the reduction is always the employee-favourable
 * difference, never a rounded-up cut. `months === 0` returns `days` completely unrounded (no
 * re-rounding of an already-settled value).
 */
export function remainingAfterParentalMonths(days: number, months: number): number {
  const clamped = Math.min(12, Math.max(0, months));
  if (clamped === 0) return days;
  if (clamped === 12) return 0;
  return roundVacationDaysBurlG((days * (12 - clamped)) / 12);
}

/**
 * The § 17 Abs. 1 BEEG reduction in days: `regularDays` minus the rounded remainder after
 * `months` full calendar months of Elternzeit. Never negative (defensive floor; `months` is
 * already clamped by {@link remainingAfterParentalMonths}).
 */
export function parentalLeaveReducedDays(regularDays: number, months: number): number {
  const remaining = remainingAfterParentalMonths(regularDays, months);
  const reduced = Math.round((regularDays - remaining) * 100) / 100;
  return reduced < 0 ? 0 : reduced;
}

/** One year's preview line: what the reduction WOULD be, what exists already, and whether this
 * year is committable right now. No write happens anywhere in this type's construction. */
export interface ParentalReductionYearPreview {
  year: number;
  months: number;
  regularDays: number;
  proposedReducedDays: number;
  currentTotalDays: number | null;
  resultingTotalDays: number | null;
  existing: {
    id: string;
    status: "ACTIVE" | "REVOKED";
    months: number;
    reducedDays: number;
    declaredAt: string;
    revokedAt: string | null;
  } | null;
  committable: boolean;
}

export interface ParentalReductionPreview {
  leaveRequestId: string;
  startDate: string;
  endDate: string;
  years: ParentalReductionYearPreview[];
}

/**
 * Builds the full preview for an (already guard-checked) Elternzeit `LeaveRequest`: per calendar
 * year it touches, the full months, the regular yearly entitlement, the proposed reduction, the
 * stored VACATION total (if any), the resulting total and any existing reduction row. Read-only —
 * no row is created or changed by calling this.
 */
export async function buildParentalReductionPreview(
  db: Prisma.TransactionClient,
  request: { id: string; employeeId: string; startDate: Date; endDate: Date },
  tenantId: string,
): Promise<ParentalReductionPreview> {
  const monthsByYear = fullCalendarMonthsByYear(request.startDate, request.endDate);

  const existingRows = await db.parentalLeaveReduction.findMany({
    where: { leaveRequestId: request.id, employee: { tenantId } },
  });
  const existingByYear = new Map(existingRows.map((row) => [row.year, row]));

  const years: ParentalReductionYearPreview[] = [];
  for (const { year, months } of monthsByYear) {
    const regularDays = await resolveRegularVacationDays(db, request.employeeId, tenantId, year);
    const lookup = await getVacationEntitlement(db, request.employeeId, tenantId, year);
    const currentTotalDays =
      lookup?.entitlement != null ? Number(lookup.entitlement.totalDays) : null;
    const proposedReducedDays = parentalLeaveReducedDays(regularDays, months);
    const resultingTotalDays =
      currentTotalDays !== null
        ? Math.round((currentTotalDays - proposedReducedDays) * 100) / 100
        : null;
    const existingRow = existingByYear.get(year) ?? null;

    years.push({
      year,
      months,
      regularDays,
      proposedReducedDays,
      currentTotalDays,
      resultingTotalDays,
      existing: existingRow
        ? {
            id: existingRow.id,
            status: existingRow.status,
            months: existingRow.months,
            reducedDays: Number(existingRow.reducedDays),
            declaredAt: existingRow.declaredAt.toISOString().slice(0, 10),
            revokedAt: existingRow.revokedAt ? existingRow.revokedAt.toISOString() : null,
          }
        : null,
      committable:
        months > 0 &&
        existingRow === null &&
        currentTotalDays !== null &&
        resultingTotalDays !== null &&
        resultingTotalDays >= 0,
    });
  }

  return {
    leaveRequestId: request.id,
    startDate: request.startDate.toISOString().slice(0, 10),
    endDate: request.endDate.toISOString().slice(0, 10),
    years,
  };
}

/**
 * Issue #468 plan 07 (D-10): a declared Elternzeit-Kürzung is anchored on a calendar year's FULL
 * month count at the time it was declared. When a correction moves the Elternzeit's own date
 * range, that count can change — this pure function names every reduced year (from
 * `reducedYears`) whose full-month count under `[oldStart, oldEnd]` differs from its count under
 * `[newStart, newEnd]`. A day-level shift that leaves every reduced year's full-month count
 * unchanged (e.g. shortening only an unreduced tail month) returns an empty array — only a
 * CHANGE in the full-month count of an already-reduced year blocks a correction, never any date
 * change whatsoever.
 */
export function reducedYearsAffectedByRange(params: {
  oldStart: Date;
  oldEnd: Date;
  newStart: Date;
  newEnd: Date;
  reducedYears: Array<{ year: number; months: number }>;
}): number[] {
  const { oldStart, oldEnd, newStart, newEnd, reducedYears } = params;
  const oldMonthsByYear = new Map(
    fullCalendarMonthsByYear(oldStart, oldEnd).map((row) => [row.year, row.months]),
  );
  const newMonthsByYear = new Map(
    fullCalendarMonthsByYear(newStart, newEnd).map((row) => [row.year, row.months]),
  );
  const affected: number[] = [];
  for (const { year } of reducedYears) {
    const oldMonths = oldMonthsByYear.get(year) ?? 0;
    const newMonths = newMonthsByYear.get(year) ?? 0;
    if (oldMonths !== newMonths) affected.push(year);
  }
  return affected;
}

/**
 * Every ACTIVE ParentalLeaveReduction declared against `leaveRequestId`, tenant-scoped via the
 * employee relation (D-10's revoke route uses the identical shape — lint:tenant-scoping's
 * isPrincipalExpression only recognises the literal `employee: { tenantId }` relation filter,
 * not a pre-validated local alias; see 468-04-SUMMARY.md Decisions).
 */
export async function activeParentalReductions(
  db: DbClient,
  leaveRequestId: string,
  tenantId: string,
): Promise<Array<{ year: number; months: number }>> {
  const rows = await db.parentalLeaveReduction.findMany({
    where: { leaveRequestId, status: "ACTIVE", employee: { tenantId } },
    select: { year: true, months: true },
  });
  return rows.map((row) => ({ year: row.year, months: row.months }));
}

/**
 * The sum of ACTIVE ParentalLeaveReduction months declared for `employeeId`+`year` (across every
 * Elternzeit of that employee in that year — § 17 Abs. 1 BEEG does not cap how many separate
 * Elternzeit spans may be declared in one year, only the total months), capped at 12 (the same
 * clamp `remainingAfterParentalMonths` applies). Used by the statutory-floor guard (PUT
 * /settings/vacation) and the read-only Prüfbericht — both reduce the SAME threshold the SAME
 * way (Issue #468 plan 07, D-07/D-09).
 */
export async function activeParentalReductionMonths(
  db: DbClient,
  employeeId: string,
  tenantId: string,
  year: number,
): Promise<number> {
  const rows = await db.parentalLeaveReduction.findMany({
    where: { year, status: "ACTIVE", employeeId, employee: { tenantId } },
    select: { months: true },
  });
  const total = rows.reduce((sum, row) => sum + row.months, 0);
  return Math.min(12, total);
}
