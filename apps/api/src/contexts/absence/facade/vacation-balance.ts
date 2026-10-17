/**
 * Issue #451 (D-07) — the ONE Resturlaub function in the absence context.
 *
 * ADR 0001 rule 3 / ADR 0002 Entscheidung 6: every reader of "how much vacation does this
 * employee have left in year Y" — Dashboard, Urlaubsübersicht, Urlaubs-PDFs, the carry-over
 * expiry warning cron (D-08), GET /leave/entitlements (D-07), "gefährdet" — calls
 * {@link vacationBalanceForRow} (or its loader {@link getVacationBalance}), never re-derives the
 * arithmetic itself. Before this facade the formula was duplicated across readers and could
 * silently diverge (the trigger for Issue #451 point 6); this file is read-only (never writes a
 * `LeaveEntitlement` row) and is pinned by `lint:facade-signatures` (F1: first parameter `db:
 * Prisma.TransactionClient`).
 *
 * `vacationBalanceForRow` always treats `row` as a VACATION entitlement — deciding WHETHER a row
 * is the tenant's VACATION type is the caller's job (the cron's `where` already filters on
 * `leaveType.code: "VACATION"`; GET /leave/entitlements only calls this for the VACATION row of
 * its response; {@link getVacationBalance} resolves the VACATION row itself via
 * {@link getVacationEntitlement}). The `row.leaveType` property on the exported type exists only
 * so callers can pass a Prisma row that already carries the relation without a cast — this
 * function never reads it.
 *
 * Composes two rules that live in `../leave-days` (Issue #451 D-07):
 * {@link carryOverAtRiskDays} (BUrlG § 7 Abs. 3, EuGH C-684/16) and
 * {@link exitYearReductionDays} (§ 5 BUrlG Teilurlaub) — plus the existing
 * {@link effectiveCarryOverDays} (FIFO, Issue #445) and
 * {@link exitVacationOverUseWarning} (Issue #447). No arithmetic is re-implemented here.
 */
import type { LeaveEntitlement, LeaveTypeCode, Prisma } from "@clokr/db";
import {
  carryOverAtRiskDays,
  countedLeaveDaysWithin,
  effectiveCarryOverDays,
  exitVacationOverUseWarning,
  exitYearReductionDays,
} from "../leave-days";
import { getVacationEntitlement } from "./entitlements";
import { dateStrInTz, dayRangeUtc } from "../../working-time-account"; // Issue #617 — tenant-local split day

const DEFAULT_TZ = "Europe/Berlin"; // same fallback getTenantTimezone() itself uses

/** `YYYY-MM-DD` of the calendar day before `day` (pure calendar arithmetic on the string). */
function dayBefore(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` of the calendar day after `day`. */
function dayAfter(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** UTC-midnight `Date` of a `YYYY-MM-DD` string — the calendar-day bound the kernel takes. */
function utcDayOf(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Rounds to 2 decimals — the storage precision of `LeaveEntitlement.*Days` (`Decimal(5,2)`). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface VacationBalance {
  year: number;
  entitlementDays: number; // stored totalDays (exit/segment-aware since #447/#450)
  carriedOverDays: number; // stored carriedOverDays
  carriedOverEffectiveDays: number; // effectiveCarryOverDays(row, now, hinweisIssued)
  carriedOverExpiredDays: number; // carriedOverDays − carriedOverEffectiveDays
  exitReductionDays: number; // exitYearReductionDays
  usedDays: number; // stored usedDays
  /** Issue #617 — entitlementDays + carriedOverEffectiveDays ("Verfügbar"); remainingDays = this − taken − approved. */
  availableDays: number;
  /** Issue #617 — the tenant-local day (YYYY-MM-DD) the taken/upcoming split uses (opts.asOf, else yesterday). */
  splitAsOf: string;
  /**
   * Issue #617 — counted VACATION days of the year from 1 January up to and including
   * `splitAsOf`, net of confirmed § 9 credits, read from the absence kernel
   * (`countedLeaveDaysWithin`, the one the `usedDays` heal runs). After the heal
   * `usedDays === takenDays + approvedUpcomingDays`.
   */
  takenDays: number;
  /** Issue #617 — counted VACATION days after `splitAsOf` through 31 December ("Genehmigt"), same kernel and netting. */
  approvedUpcomingDays: number;
  pendingDays: number; // Σ days of PENDING requests of the row's type starting in the row's year
  /**
   * Issue #617 — the PENDING days of the year whose request was created on or before the end of
   * `splitAsOf` (tenant time zone). "Beantragt" of the Monatsexport; never deducted anywhere.
   */
  pendingCreatedByAsOfDays: number;
  remainingDays: number; // entitlementDays + carriedOverEffectiveDays − usedDays (not clamped)
  atRiskDays: number; // carryOverAtRiskDays
  carryOverDeadline: Date | null;
  hinweisIssued: boolean;
  exitOverUseWarning: { used: number; entitlement: number; message: string } | null;
}

/**
 * Issue #451 (D-07) — see the module header. `opts.hinweisIssued`/`opts.employee` let a caller
 * that already has those values (GET /leave/entitlements already bulk-loads
 * `warnedEntitlementIds` and the employee row) pass them in instead of re-querying — otherwise
 * both are loaded here: the Hinweis flag from `row`'s own `CARRYOVER_WARNED` AuditLog entry
 * (same detector {@link import("../leave-days").carryOverRemainder} uses), the employee
 * name/exitDate from `Employee`.
 */
export async function vacationBalanceForRow(
  db: Prisma.TransactionClient,
  row: LeaveEntitlement & { leaveType?: { code: LeaveTypeCode | null } },
  tenantId: string,
  now: Date,
  opts: {
    hinweisIssued?: boolean;
    employee?: { firstName: string; lastName: string; exitDate: Date | null };
    /**
     * Issue #617 (P-03) — tenant-local day (YYYY-MM-DD) the taken/upcoming split and
     * `pendingCreatedByAsOfDays` use. Absent: the tenant-local day before `now`, which is the
     * in-app meaning ("up to yesterday"). The Monatsexport passes its Stichtag.
     */
    asOf?: string;
  } = {},
): Promise<VacationBalance> {
  const hinweisIssued =
    opts.hinweisIssued ??
    (await db.auditLog.count({
      where: { action: "CARRYOVER_WARNED", entity: "LeaveEntitlement", entityId: row.id },
    })) > 0;

  const carriedOverDays = Number(row.carriedOverDays);
  const carriedOverEffectiveDays = await effectiveCarryOverDays(
    db,
    { ...row, tenantId },
    now,
    hinweisIssued,
  );
  const carriedOverExpiredDays = Math.max(0, round2(carriedOverDays - carriedOverEffectiveDays));

  const exitReductionDays = await exitYearReductionDays(db, row.employeeId, tenantId, row.year);
  const atRiskDays = await carryOverAtRiskDays(db, row, tenantId, now);

  const entitlementDays = Number(row.totalDays);
  const usedDays = Number(row.usedDays);

  const pendingAgg = await db.leaveRequest.aggregate({
    where: {
      employeeId: row.employeeId,
      employee: { tenantId },
      leaveTypeId: row.leaveTypeId,
      deletedAt: null,
      status: "PENDING",
      startDate: {
        gte: new Date(Date.UTC(row.year, 0, 1)),
        lt: new Date(Date.UTC(row.year + 1, 0, 1)),
      },
    },
    _sum: { days: true },
  });
  const pendingDays = round2(Number(pendingAgg._sum.days ?? 0));

  const remainingDays = round2(entitlementDays + carriedOverEffectiveDays - usedDays);
  const availableDays = round2(entitlementDays + carriedOverEffectiveDays);

  // ── Issue #617: the taken / approved-upcoming split, from the kernel ────────────────────────
  const tenantConfigRow = await db.tenantConfig.findUnique({
    where: { tenantId },
    select: { timezone: true },
  });
  const tz = tenantConfigRow?.timezone ?? DEFAULT_TZ;
  const splitAsOf = opts.asOf ?? dayBefore(dateStrInTz(now, tz));
  const vacationTypes = await db.leaveType.findMany({
    where: { tenantId, code: "VACATION" },
    select: { id: true },
  });
  const vacationTypeIds = vacationTypes.map((t) => t.id);
  const yearStart = `${row.year}-01-01`;
  const yearEnd = `${row.year}-12-31`;
  // Window [from, to] clamped to the row's year; an empty window counts nothing.
  const countedWithin = async (from: string, to: string): Promise<number> => {
    const f = from < yearStart ? yearStart : from;
    const t = to > yearEnd ? yearEnd : to;
    if (f > t || vacationTypeIds.length === 0) return 0;
    const { requestDays, section9CreditDays } = await countedLeaveDaysWithin(db, {
      employeeId: row.employeeId,
      tenantId,
      leaveTypeIds: vacationTypeIds,
      from: utcDayOf(f),
      to: utcDayOf(t),
    });
    return Math.max(0, round2(requestDays - section9CreditDays));
  };
  const takenDays = await countedWithin(yearStart, splitAsOf);
  const approvedUpcomingDays = await countedWithin(dayAfter(splitAsOf), yearEnd);

  const pendingByAsOfAgg = await db.leaveRequest.aggregate({
    where: {
      employeeId: row.employeeId,
      employee: { tenantId },
      leaveTypeId: row.leaveTypeId,
      deletedAt: null,
      status: "PENDING",
      startDate: {
        gte: new Date(Date.UTC(row.year, 0, 1)),
        lt: new Date(Date.UTC(row.year + 1, 0, 1)),
      },
      createdAt: { lte: dayRangeUtc(splitAsOf, tz).end },
    },
    _sum: { days: true },
  });
  const pendingCreatedByAsOfDays = round2(Number(pendingByAsOfAgg._sum.days ?? 0));

  const employee = opts.employee ??
    (await db.employee.findFirst({
      where: { id: row.employeeId, tenantId },
      select: { firstName: true, lastName: true, exitDate: true },
    })) ?? { firstName: "", lastName: "", exitDate: null };

  const exitOverUseWarning = exitVacationOverUseWarning({
    employeeName: `${employee.firstName} ${employee.lastName}`,
    exitDate: employee.exitDate,
    row,
  });

  return {
    year: row.year,
    entitlementDays,
    carriedOverDays,
    carriedOverEffectiveDays,
    carriedOverExpiredDays,
    exitReductionDays,
    usedDays,
    availableDays,
    splitAsOf,
    takenDays,
    approvedUpcomingDays,
    pendingDays,
    pendingCreatedByAsOfDays,
    remainingDays,
    atRiskDays,
    carryOverDeadline: row.carryOverDeadline,
    hinweisIssued,
    exitOverUseWarning,
  };
}

/**
 * Issue #451 (D-07) — resolves `employeeId`'s VACATION `LeaveEntitlement` row for `year` via
 * {@link getVacationEntitlement} (A11, tenant-scoped, never creates) and delegates to
 * {@link vacationBalanceForRow}. `null` when the tenant has no VACATION type configured, or no
 * row exists yet for `year` (never auto-created — this is a read, like its loader).
 */
export async function getVacationBalance(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  year: number,
  now: Date,
): Promise<VacationBalance | null> {
  const lookup = await getVacationEntitlement(db, employeeId, tenantId, year);
  if (!lookup?.entitlement) return null;
  return vacationBalanceForRow(db, lookup.entitlement, tenantId, now);
}
