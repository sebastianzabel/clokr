/**
 * Phase 100b Plan 01 (AC-1/AC-2, D-06) — Arbeitszeitkonto's public surface.
 *
 * What is exported here is this context's public surface — ADR 0001 rule 3 (no direct table
 * access across foreign schemas; access only through the owning context's public interface) is
 * why this file exists at all. Anything NOT exported here is
 * module-internal and may change at any time without notice — a caller outside this context that
 * needs a new question answered gets a new named export, never a reach-around import of an
 * internal module.
 *
 * The implementation lives in `./facade/` (added wave by wave from plan 100B-06/07 onward) — that
 * is where a new facade function goes, not here. This file is a PURE re-export surface and
 * contains no Prisma call: it deliberately sits outside `SCOPED_DIRS`
 * (`apps/api/scripts/lint-tenant-scoping-types.ts`), and only `./facade/**` is walked by plan
 * 100B-04's tenant-gate extension. A query placed directly in this file would be invisible to
 * that gate — do not "helpfully" move one here.
 *
 * D-02: a facade function expresses the QUESTION a caller asks, not the caller's `where`. Two
 * callers with the same question share one function; a caller with a special case does not get a
 * function with a passed-through `where`.
 *
 * D-07: every facade function's first parameter is `db: Prisma.TransactionClient`, never
 * `app: FastifyInstance`. `apps/api/scripts/lint-facade-signatures.ts` (plan 03) enforces this
 * mechanically.
 *
 * D-08: the soft-delete guard is NOT applied uniformly across this surface. Reading functions
 * carry `deletedAt: null`; the named compliance functions this context exposes for DSGVO Art. 17
 * anonymisation, hard delete, and retention archival deliberately OMIT it and say so in their own
 * docblock — a blanket guard here would be an Art. 17 regression, not an improvement.
 *
 * Plan 100B-06 (Wave 3) adds the `OvertimeAccount`/`OvertimeTransaction` facade — W8–W15, all
 * `db: Prisma.TransactionClient`-first from day one (`./facade/overtime-account.ts`).
 *
 * Plan 100B-07 (Wave 3, final) adds the `SaldoSnapshot` facade — W1–W7 (`./facade/saldo-snapshot.ts`)
 * — and converts `confirmed-saldo.ts` to `db: Prisma.TransactionClient` (D-07). This was the LAST
 * `app: FastifyInstance` facade in the tree; it no longer exists as a citable precedent. Wave 3 is
 * now complete: Arbeitszeitkonto is converted whole (D-01) — none of its three models
 * (`OvertimeAccount`, `OvertimeTransaction`, `SaldoSnapshot`) is reachable directly from outside.
 */
export { getConfirmedCarryOver, getConfirmedCarryOverBulk } from "./confirmed-saldo";
export {
  getOvertimeAccount,
  listOvertimeAccountsForTenant,
  getBalances,
  bookOvertimeCompensation,
  reverseOvertimeCompensation,
  createOvertimeAccount,
  setOvertimeAccountBalance,
  hardDeleteOvertimeDataForEmployee,
} from "./facade/overtime-account";
export {
  isMonthClosed,
  getClosedMonthsForDates,
  getClosedMonthsInRange,
  getMonthClosingBalance,
  getMonthlySnapshotsInRange,
  sumCarryOverByMonth,
  countSnapshotsBefore,
  type MonthlySnapshotRow,
  type CarryOverByMonth,
} from "./facade/saldo-snapshot";

// ── Missing-entries-window default (issue #246, E-6) ─────────────────────────────────────────
// Declared public: a constant carries no query semantics, no soft-delete guard, no tenant scope
// — the number itself IS the invariant, so a value re-export needs no facade function around it.
export { DEFAULT_MISSING_ENTRIES_DAYS, resolveMissingEntriesDays } from "./missing-entries-window";

// ── Phase 101B (Issue #101, AC-2) ────────────────────────────────────────────────────────────
// Declared public because a caller outside this context already depended on them. These are
// re-exports of existing modules, not new facade functions: this file remains a PURE re-export
// surface with no Prisma call (see this file's own docblock — it sits outside SCOPED_DIRS, so a
// query placed here would be invisible to the tenant-scoping gate).
export {
  calcExpectedMinutesTz,
  calcLeaveAbsenceMinutesTz,
  dateStrInTz,
  getDayHoursFromSchedule,
  getDayOfWeekInTz,
  getTenantTimezone,
  iterateDaysInTz,
  monthDayBounds,
  monthRangeUtc,
  timeStrInTz,
  todayInTz,
  weekRangeUtc,
} from "./timezone";
export { recalculateSnapshots } from "./recalculate-snapshots";
export {
  bsUnterrichtsMinutesByDateForIsoWeek,
  computeDailySollMinutes,
  countBsDaysInIsoWeek,
  getVocationalSchoolMinutesForDate,
  sortedBsDatesInIsoWeek,
} from "./vocational-school-saldo";
export { findMissingWorkdays } from "./find-missing-workdays";
export { computeMonthSaldo } from "./month-saldo";
export { loadNegativeBalanceTolerance } from "./negative-balance-tolerance";
export { isSnapshotLocked } from "./snapshot-lock";
export { closeEmployeeMonth } from "./close-employee-month";
export { fetchCloseMonthData } from "./close-month-data";
// Phase 101B plan 04 moved these here out of time-tracking/api/time-entries.ts (Arbeitszeitkonto
// subject matter in a Zeiterfassung route file — owner Nebenbefund, measured cycle-neutral).
// `computeOvertimeBalanceHours` stayed off this surface through waves 5-8 deliberately (no
// production caller outside time-entries.ts's own forwarding re-export needed it yet) — wave 9
// (Issue #101, the phase's closing wave) closes that loop: time-entries.ts's own forwarding
// import is itself a real, extant cross-context need (time-tracking consuming
// working-time-account), so it now goes through this index like its two siblings, and the last
// deep import in the tree disappears rather than becoming a seventh register exception.
export {
  updateOvertimeAccount,
  computeOvertimeBalanceBreakdown,
  computeOvertimeBalanceHours,
} from "./overtime-balance";
export type { OvertimeBalanceBreakdown } from "./overtime-balance";
