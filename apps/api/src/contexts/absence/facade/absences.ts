/**
 * Phase 100B Plan 12 (Wave 5, closing model) — Abwesenheiten's `Absence` facade.
 *
 * ADR 0001 rule 3: every caller outside this context reaches `Absence` through one of the
 * functions below, never through `prisma.absence`/`app.prisma.absence`/`tx.absence` directly.
 * `Absence` is added to `convertedModels` in `apps/api/scripts/foreign-context-access-exceptions.json`
 * in the same commit — a future direct access is a hard error, not a slip to re-discover.
 *
 * D-07: every export's first parameter is `db: Prisma.TransactionClient`.
 *
 * ── A4 vs A5 — the single highest-consequence grouping decision in this phase (D-09) ────────────
 * {@link getAbsencesOverlapping} (A4, 15 sites) and {@link getRosterSollAbsencesOverlapping} (A5,
 * 1 site, `contexts/scheduling/api/shifts.ts`'s roster-Soll query) look almost identical — both
 * take a date range and return overlapping `Absence` rows — and ask DIFFERENT questions. A4
 * answers "which absences does the calendar/close/cron path see" (every type, every source). A5
 * answers "which absences reduce a SHIFT_BASED employee's roster Soll", and its `where` therefore
 * ADDS `type: { not: "VOCATIONAL_SCHOOL" }` and `source: { not: "PATTERN" }`.
 *
 * `calcLeaveAbsenceMinutesTz()`'s own docblock (`working-time-account/timezone.ts:440-467`) states
 * this outright: "Absence TYPE and SOURCE filtering is deliberately NOT a precondition of this
 * function [...] `closeEmployeeMonth()` deliberately passes VOCATIONAL_SCHOOL / PATTERN rows IN
 * (v1.8.27 BS double-count fix): `contractSoll` (`avgWorkMinutesCore`) has no Berufsschule
 * awareness and already counts that day once via the average method, so the loop subtracts that
 * credit here and re-adds the precise BBiG § 15 slot credit separately [...] The roster path in
 * `routes/shifts.ts` deliberately does the opposite, excluding VOCATIONAL_SCHOOL in its `where`,
 * because a Berufsschule day is a working day for the roster's Soll view, not an absence from it."
 *
 * Merging A4 and A5 into one parameterised query would silently undo the v1.8.27 Berufsschule
 * double-count fix the moment a future reader "simplified" the two functions into one — a
 * payroll-relevant, audit-relevant saldo error. The safety net for the close/cron path is the
 * saldo golden (`measure-saldo-path-parity.ts`); the safety net for the ROSTER path is
 * `apps/api/src/__tests__/shift-week-leave-absence-minutes.test.ts`'s case F (plan 02) — the
 * golden does NOT cover the roster side, so that test is the only thing standing between a wrong
 * grouping and a silent regression. The membership test below
 * (`__tests__/facade-absences.test.ts`) asserts A4 and A5 return DIFFERENT sets over the SAME
 * fixture and was seen RED once per removed filter before being committed green.
 *
 * A5 has exactly one call site. D-02 says "a caller with a special case does not get its own
 * function with a passed-through `where`" — that rule is satisfied here because A5 is a
 * PURPOSE-NAMED function whose `where` is fixed by law (BBiG § 15), not a `where` pass-through: a
 * one-call-site function whose existence prevents a payroll error is not a smell.
 *
 * ── A4's select union (read all 15+ call sites' `select`/full-row reads before writing this) ────
 * Three shapes exist among the pre-facade call sites:
 *   - narrow display selects (`dashboard.ts`, `shifts.ts` calendar/generator reads): a subset of
 *     `{id, employeeId, startDate, endDate, type}`.
 *   - the close/cron Soll-input selects (`month-saldo.ts`, `recalculate-snapshots.ts`,
 *     `auto-close-month.ts`, `overtime.ts`'s `fetchCloseMonthData`): explicitly
 *     `{startDate, endDate, type, source, halfDay, unterrichtsMinutes}` — every field
 *     `calcLeaveAbsenceMinutesTz`'s caller threads into it (`close-employee-month.ts:374`).
 *   - two FULL-ROW reads with no `select` at all (`close-month-data.ts:73`,
 *     `time-tracking/api/time-entries.ts:2599`) — read forward to their own consumers
 *     (`overtime.ts:531/825`'s own comment: "full rows — halfDay + type + source included";
 *     `time-entries.ts:2685-2690`'s `.map` literally destructures only
 *     `startDate/endDate/type/source/halfDay/unterrichtsMinutes`) confirms neither needs `note`,
 *     `documentPath`, `days`, `createdAt`, `createdBy` or `deletedAt` — the FULL-ROW shape there is
 *     incidental (no `select` was ever written), not an essential wider need (R-C).
 * The union below (`id, employeeId, startDate, endDate, type, source, halfDay,
 * unterrichtsMinutes`) is therefore a strict superset of every real caller's actual field use;
 * every narrower need documented above is R-C incidental narrowing, matching S1
 * (`contexts/scheduling/facade/shifts.ts`)'s own precedent for the identical situation.
 *
 * `findShiftConflict` (`shifts.ts`'s module-private single-day conflict check, formerly a bare
 * `findFirst`) is A4 too — same `where` shape (employee-scoped, no type/source filter,
 * `deletedAt: null`), just `from === to`. Its two call sites pass a `tenantId` argument (threaded
 * from each route handler's own `req.user.tenantId`) that `EmployeeScope` carries in every variant
 * (D-10, T-100B-16). Since Phase 77b (Issue #77) `employeeScopeWhere` binds that tenant into the
 * query (`employee: { tenantId }`) and throws on an empty one — both sites already validate the
 * employee against `req.user.tenantId` upstream, so for them the binding is a proven no-op, while a
 * foreign employeeId can no longer match at all.
 *
 * ── A6 — VOCATIONAL_SCHOOL-only reads (8 sites, the mirror image of A5's exclusion) ─────────────
 * {@link getVocationalSchoolDays} (range) and {@link hasVocationalSchoolDay} (single-day
 * existence check, R-B sibling — both `findFirst` sites at `arbzg.ts:107` and
 * `vocational-school-saldo.ts:176` only ever test truthiness of the row, never read a field off
 * it) both filter `type: "VOCATIONAL_SCHOOL"` with `deletedAt: null`. Read all 8 originals: every
 * range site filters by `startDate` ALONE (`{gte, lte}` or the equivalent `{gte, lt: nextDay}`),
 * never by `endDate` — BS `Absence` rows are always exactly one calendar day (the Phase 62
 * generator's own doc comment: "emits exactly one row per BS day"; the `@@unique([employeeId,
 * startDate, type])` constraint corroborates this), so a `startDate`-only window is the correct,
 * already-uniform semantics, not a narrowing. The three `isoWeekBoundsUtc`-based sites
 * (`vocational-school-saldo.ts:128/282/317`) construct `{monday, nextMonday}` (exclusive upper
 * bound); `to` for those sites below is `nextMonday` minus one day (an exact same-day computation,
 * since `Absence.startDate` is a `@db.Date` with no time component) so every site can share
 * A6's single `{gte: from, lte: to}` shape rather than the facade carrying two boundary styles.
 *
 * `getVocationalSchoolDays`'s `tenantId` for `arbzg.ts`'s three sites comes from `checkArbZG`'s
 * own `employee.tenantId`, already fetched at the top of that function for an unrelated reason —
 * no new query. `vocational-school-saldo.ts`'s four sites (`countBsDaysInIsoWeek`,
 * `getVocationalSchoolMinutesForDate`, `sortedBsDatesInIsoWeek`, `bsUnterrichtsMinutesByDateForIsoWeek`)
 * have no tenantId in scope at any of their own external callers (`arbzg.ts`, `jarbschg.ts`,
 * `shifts.ts`'s Soll-Korrelation) — following Plan 11's own precedent for
 * `getActiveBsPattern`/`bsUnterrichtsMinutesByDateForIsoWeek` in this SAME file (D-10, T-100B-16),
 * each of the four resolves `tenantId` via its own small `prisma.employee.findFirst` lookup
 * (`employee` is a platform/Unterbau model, never a FOREIGN access regardless of which context
 * reads it) rather than threading a new public parameter through every one of their own external
 * callers. `getVocationalSchoolMinutesForDate`'s existing `employeeSlots` lookup (already needed
 * for the bsSlot* hierarchy) is reordered to run BEFORE its `bs` existence check instead of after
 * it, so the SAME query answers both needs — the only behaviour difference is one extra query in
 * the early-return ("no BS day") path, never a correctness change.
 *
 * `services/phorest/sync-shifts.ts:385` is one of exactly TWO genuine boundary crossings out of
 * `services/` (ADR entry F) — its own `tenantId` parameter is already threaded through the
 * function, so its `EmployeeScope` is `{ kind: "employees", employeeIds: mappedEmployeeIds,
 * tenantId }`, a bulk read across the window's mapped employees in ONE query, unchanged from today.
 *
 * ── The three DSGVO/hard-delete/retention compliance functions (D-08, H3) ───────────────────────
 * {@link getAbsenceDocumentPaths}, {@link anonymizeAbsencesForEmployee} and
 * {@link hardDeleteAbsencesForEmployee} deliberately carry NO `deletedAt: null` guard — Art. 17
 * erasure and a hard delete must both reach soft-deleted rows, or a deleted employee's absence
 * documents/notes survive the "deletion". Each carries a named F3 exception (no `tenantId`
 * parameter) because each one's SOLE caller already tenant-validates `employeeId` upstream, before
 * this function is ever reached — same shape as `hardDeleteEntitlementsForEmployee` (plan 10) and
 * `hardDeleteOvertimeDataForEmployee` (plan 06).
 *
 * {@link archiveAbsencesBefore} is the ONE exception among the four that DOES carry `deletedAt:
 * null` in its `where` — but that clause is an IDEMPOTENCY guard (running the nightly retention
 * archival job twice must archive each row exactly once), NOT a soft-delete filter of the D-08
 * kind. Conflating the two readings is the exact failure mode this docblock exists to prevent: a
 * future reader seeing `deletedAt: null` next to three siblings that omit it might "simplify" it
 * away as a duplicate soft-delete guard, silently making the archival job re-touch (and re-log)
 * already-archived rows on every run. Same shape and same named precedent as
 * `archiveEntriesBefore` (`contexts/time-tracking/facade/time-entries.ts`, plan 08, T9) — it also
 * carries a `tenantId` parameter (unlike the other three compliance functions here) because its
 * caller (`data-retention.ts`'s per-tenant loop) already has one, making the added `employee:
 * {tenantId}` defence-in-depth a proven no-op rather than a new constraint.
 */
import type { LeaveTypeCode, AbsenceSource, Prisma } from "@clokr/db";
import { type EmployeeScope, employeeScopeWhere } from "../../platform";

// ── A4 — the general overlap read, every type/source, deletedAt-filtered ────────────────────────

export interface OverlappingAbsence {
  id: string;
  employeeId: string;
  startDate: Date;
  endDate: Date;
  type: LeaveTypeCode;
  source: AbsenceSource;
  halfDay: boolean;
  unterrichtsMinutes: number | null;
}

/**
 * A4 — every `Absence` (any `type`, any `source`) overlapping `[from, to]` for the given
 * {@link EmployeeScope}, soft-delete-filtered. The calendar/close/cron read: this is what
 * `closeEmployeeMonth()` deliberately receives UNFILTERED (v1.8.27 BS double-count fix) — see this
 * module's own header for why {@link getRosterSollAbsencesOverlapping} (A5) is a SEPARATE
 * function, never this one with an extra `where` clause bolted on.
 *
 * Sites: `composition/dashboard.ts` (4×, calendar/team-status reads), `contexts/scheduling/api/
 * shifts.ts` (`/shifts/week` calendar overlay, `generate-week`, `copy-week` skip-logic, plus
 * `findShiftConflict`'s single-day conflict check with `from === to`),
 * `contexts/time-tracking/api/time-entries.ts` (Bug-5 open-month recompute — SALDO INPUT),
 * `contexts/working-time-account/{close-month-data,month-saldo,recalculate-snapshots}.ts` and
 * `plugins/auto-close-month.ts` (2×) — the close/cron path, ALL feeding `calcLeaveAbsenceMinutesTz`
 * through `closeEmployeeMonth()` — SALDO INPUT, and `api/overtime.ts`'s `fetchCloseMonthData`
 * bulk pre-fetch.
 */
export async function getAbsencesOverlapping(
  db: Prisma.TransactionClient,
  scope: EmployeeScope,
  from: Date,
  to: Date,
): Promise<OverlappingAbsence[]> {
  return db.absence.findMany({
    where: {
      ...employeeScopeWhere(scope),
      deletedAt: null,
      startDate: { lte: to },
      endDate: { gte: from },
    },
    select: {
      id: true,
      employeeId: true,
      startDate: true,
      endDate: true,
      type: true,
      source: true,
      halfDay: true,
      unterrichtsMinutes: true,
    },
  });
}

// ── A5 — the roster-Soll read, EXCLUDING VOCATIONAL_SCHOOL/PATTERN (D-09, NOT to be merged) ──────

export interface RosterSollAbsence {
  employeeId: string;
  startDate: Date;
  endDate: Date;
  halfDay: boolean;
}

/**
 * A5 — tenant-wide `Absence` overlap for the roster-Soll subtraction, EXCLUDING
 * `type: "VOCATIONAL_SCHOOL"` (BBiG § 15: a BS day is a working day for the roster's Soll view,
 * not an absence from it) and `source: "PATTERN"` (auto-generated rows are not an approved
 * absence). See this module's own header (D-09) for the full v1.8.27 reasoning and why this must
 * NEVER be merged with {@link getAbsencesOverlapping} (A4) even though both take a date range and
 * return `Absence` rows.
 *
 * Sole site: `contexts/scheduling/api/shifts.ts`'s `/shifts/week` Soll-Korrelation row
 * (`absencesForSoll`). Guarded by `apps/api/src/__tests__/shift-week-leave-absence-minutes.test.ts`
 * case F (plan 02) — the saldo golden does not cover the roster side, so that test is the ONLY
 * thing standing between a wrong grouping decision here and a silent payroll regression.
 */
export async function getRosterSollAbsencesOverlapping(
  db: Prisma.TransactionClient,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<RosterSollAbsence[]> {
  return db.absence.findMany({
    where: {
      employee: { tenantId },
      deletedAt: null,
      type: { not: "VOCATIONAL_SCHOOL" },
      source: { not: "PATTERN" },
      startDate: { lte: to },
      endDate: { gte: from },
    },
    select: {
      employeeId: true,
      startDate: true,
      endDate: true,
      halfDay: true,
    },
  });
}

// ── A6 — VOCATIONAL_SCHOOL-only reads (the mirror image of A5's exclusion) ───────────────────────

export interface VocationalSchoolDay {
  employeeId: string;
  startDate: Date;
  unterrichtsMinutes: number | null;
}

/**
 * A6 — every `VOCATIONAL_SCHOOL` `Absence` with `startDate` in `[from, to]` (both inclusive) for
 * the given {@link EmployeeScope}, soft-delete-filtered. BS `Absence` rows are always exactly one
 * calendar day (see this module's own header), so a `startDate`-only window is the correct,
 * already-uniform semantics every one of the 6 range-based pre-facade sites used.
 *
 * Sites: `contexts/time-tracking/arbzg.ts`'s §3 weekly-sum and §3 24-week-average BS minute sums,
 * `contexts/working-time-account/vocational-school-saldo.ts`'s `countBsDaysInIsoWeek`,
 * `sortedBsDatesInIsoWeek` and `bsUnterrichtsMinutesByDateForIsoWeek`, and
 * `services/phorest/sync-shifts.ts`'s bulk "BS gewinnt" pre-fetch (one of exactly two genuine
 * boundary crossings out of `services/`, ADR entry F).
 */
export async function getVocationalSchoolDays(
  db: Prisma.TransactionClient,
  scope: EmployeeScope,
  from: Date,
  to: Date,
): Promise<VocationalSchoolDay[]> {
  return db.absence.findMany({
    where: {
      ...employeeScopeWhere(scope),
      type: "VOCATIONAL_SCHOOL",
      deletedAt: null,
      startDate: { gte: from, lte: to },
    },
    orderBy: [{ startDate: "asc" }],
    select: {
      employeeId: true,
      startDate: true,
      unterrichtsMinutes: true,
    },
  });
}

/**
 * A6's R-B single-day sibling — does a `VOCATIONAL_SCHOOL` `Absence` exist for `employeeId` on
 * `date`. Both pre-facade `findFirst` sites (`arbzg.ts`'s §3 daily mixed-day check,
 * `vocational-school-saldo.ts`'s `getVocationalSchoolMinutesForDate` gate) only ever tested the
 * row's truthiness — neither dereferenced a field off it — so this returns a `boolean`, matching
 * `hasApprovedLeaveOnDate`'s own naming/return-shape convention (`leave-check.ts`) rather than a
 * function with an option flag threaded into {@link getVocationalSchoolDays} (D-02).
 *
 * `lint:tenant-scoping` note (Plan 12 gate reconciliation): this `findFirst` is NOT a D-12
 * candidate — `date` reaches the `where` only through `start`/`next`, two local variables computed
 * via `new Date(Date.UTC(...))` (a `CallExpression`), which `lint-tenant-scoping-candidates.ts`'s
 * provenance walker deliberately treats as opaque ("carries no identifiable client-supplied signal
 * for this walk"), by the SAME rule that keeps a `findMany`'s date-range filter from producing a
 * false positive elsewhere. This is a genuine gate BLIND SPOT, not a gap in tenant safety: both
 * `employeeId` and `employee: { tenantId }` are present in the `where` regardless of what the gate
 * can see. Rewriting the range computation inline to make `date` itself reachable would deviate
 * from every other date-range query in this codebase (`{ gte: start, lt: next }` computed ahead of
 * the query, never `{ equals: date }` against a `@db.Date` column) for a detectability gain, not a
 * correctness one — not worth the behavioural risk. Filed as a known gap, not fixed here.
 */
export async function hasVocationalSchoolDay(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  date: Date,
): Promise<boolean> {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const next = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const row = await db.absence.findFirst({
    where: {
      employeeId,
      employee: { tenantId },
      type: "VOCATIONAL_SCHOOL",
      deletedAt: null,
      startDate: { gte: start, lt: next },
    },
    select: { id: true },
  });
  return row !== null;
}

// ── Compliance slices (D-08) — deliberately NOT soft-delete-guarded, three ways ──────────────────

/**
 * F3 exception (D-08, no `tenantId` parameter): every non-null `documentPath` of every `Absence`
 * for `employeeId`, regardless of `deletedAt` — a deleted employee's absence documents (AU
 * certificates) must be cleaned up in MinIO too, so a soft-deleted row's document must still be
 * found. Site: `platform/api/employees.ts`'s `DELETE /:id` (`ANONYMIZE`) handler, called BEFORE
 * the anonymisation `$transaction` opens (MinIO deletes happen after commit — MinIO is not
 * transactional with Postgres). Its handler validates `id` against `req.user.tenantId` before this
 * function is ever reached. Same shape as `getSection9DocumentPaths` (plan 11).
 */
export async function getAbsenceDocumentPaths(
  db: Prisma.TransactionClient,
  employeeId: string,
): Promise<Array<{ documentPath: string | null }>> {
  return db.absence.findMany({
    where: { employeeId, documentPath: { not: null } },
    select: { documentPath: true },
  });
}

/**
 * F3 exception (D-08, no `tenantId` parameter): DSGVO Art. 17 anonymisation — nulls `note` and
 * `documentPath` for every `Absence` row belonging to `employeeId`, regardless of `deletedAt` (a
 * soft-deleted row's PII must be scrubbed too, same as every other field
 * `platform/anonymize.ts`'s `anonymizeEmployeeData()` clears). Runs inside the CALLER's own
 * `$transaction` (`db` is a `tx`, D-07) — `anonymize.ts`'s handler validates `id` against
 * `req.user.tenantId` before this transaction is ever opened.
 */
export async function anonymizeAbsencesForEmployee(
  db: Prisma.TransactionClient,
  employeeId: string,
): Promise<void> {
  await db.absence.updateMany({
    where: { employeeId },
    data: { note: null, documentPath: null },
  });
}

/**
 * F3 exception (D-08, no `tenantId` parameter): HARD delete of every `Absence` row for
 * `employeeId`, invoked ONLY from `platform/api/employees.ts`'s `DELETE /:id/hard-delete`
 * sequence inside its own `$transaction`, whose handler already validates `id` against
 * `req.user.tenantId` before this function is ever reached. No `deletedAt` guard — a hard delete
 * must reach soft-deleted rows too. `onDelete: Restrict` on `Absence.employee` makes the CALLER's
 * ordering (Break → TimeEntry → LeaveRequest → Absence → ...) the invariant (H5) — this function
 * is called IN PLACE in that sequence, unchanged.
 */
export async function hardDeleteAbsencesForEmployee(
  db: Prisma.TransactionClient,
  employeeId: string,
): Promise<void> {
  await db.absence.deleteMany({ where: { employeeId } });
}

/**
 * Retention archival (§ 16 Abs. 2 ArbZG / CLAUDE.md § Data Retention): soft-deletes every
 * `Absence` for the given `employeeIds` whose `endDate` is at or before `cutoff`. The `deletedAt:
 * null` clause in the `where` below is an IDEMPOTENCY guard — it keeps a second run of the nightly
 * retention job from re-touching (and re-logging) rows a previous run already archived — NOT a
 * soft-delete-read filter of the kind the other three compliance functions above deliberately
 * omit. Conflating the two readings is exactly the mistake this docblock exists to prevent (see
 * this module's own header). Same shape and precedent as `archiveEntriesBefore`
 * (`contexts/time-tracking/facade/time-entries.ts`, plan 08, T9): `tenantId` is present (unlike
 * the other three compliance functions here) because the sole caller
 * (`data-retention.ts`'s per-tenant loop) already has one in scope, making `employee: {tenantId}`
 * a proven no-op defence-in-depth addition, not a new constraint.
 */
export async function archiveAbsencesBefore(
  db: Prisma.TransactionClient,
  employeeIds: string[],
  tenantId: string,
  cutoff: Date,
): Promise<number> {
  if (employeeIds.length === 0) return 0;
  const result = await db.absence.updateMany({
    where: {
      employeeId: { in: employeeIds },
      employee: { tenantId },
      deletedAt: null, // idempotency guard — see module header, NOT a soft-delete read filter
      endDate: { lte: cutoff },
    },
    data: { deletedAt: new Date() },
  });
  return result.count;
}
