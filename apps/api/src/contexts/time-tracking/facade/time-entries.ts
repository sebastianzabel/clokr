/**
 * Phase 100B Plan 08 (Wave 4) — Zeiterfassung's `TimeEntry`/`Break` facade.
 *
 * ADR 0001 rule 3: no direct table access across foreign schemas; every caller outside this
 * context reaches `TimeEntry`/`Break` through one of the functions below, never through
 * `prisma.timeEntry`/`tx.timeEntry`/`prisma.break`/`tx.break` directly. Both models are added to
 * `convertedModels` in `apps/api/scripts/foreign-context-access-exceptions.json` in the same
 * commit, so a future direct access is a hard error, not a slip that has to be re-discovered.
 *
 * D-07: every export's first parameter is `db: Prisma.TransactionClient` — `PrismaClient` is
 * assignable to it, so the SAME function runs whether the caller is inside a `$transaction` or
 * not. `apps/api/scripts/lint-facade-signatures.ts` enforces this mechanically (F1/F2).
 *
 * `Break` is in this plan and not its own because `platform/api/employees.ts`'s
 * `tx.break.deleteMany` is the first step of the hard-delete sequence whose second step is
 * `tx.timeEntry.deleteMany`; `onDelete: Restrict` makes the ORDER the invariant, so both models
 * convert together in {@link hardDeleteTimeDataForEmployee} (T11) below.
 *
 * ── T1 vs T2 — the sharpest hazard in this plan, kept as two functions on purpose ─────────────
 * `getValidWorkedEntriesInRange` (T1, the SALDO INPUT — 4 sites) and `getWorkedEntriesInRange`
 * (T2, the DISPLAY SET's strict subset — 4 sites) differ by exactly one clause: `isInvalid: false`.
 * T1 feeds Monatsabschluss/close-employee-month; T2's callers (`close-month-data.ts`'s bulk
 * break-status/BREAK-05 fetch, `auto-close-month.ts`'s per-month gap-readiness re-check,
 * `dashboard.ts`'s "heute"/"woche" worked-minutes cards) flag invalid entries themselves and must
 * not have T1's stricter filter silently applied for them. Merging the two would either make the
 * saldo start counting entries invalidated during a pending leave cancellation (CLAUDE.md § 8
 * BUrlG) or make the display cards stop showing them. `__tests__/facade-time-entries.test.ts`
 * pins the exact membership difference over one shared fixture set.
 *
 * ── The T2 regrouping — 4 of the plan's originally-claimed 9 "T2" sites do NOT share T1's
 *    `endTime: { not: null }` clause, and one has no `type`/`isInvalid` filter at all ────────────
 * Read all 13 candidate sites before writing this file (rule R-C), not assumed from the plan's own
 * shorthand. Four of the nine — `dashboard.ts`'s team-week calendar, team-today presence board,
 * personal week view, and the missing-workdays detector — need OPEN entries too:
 * `dashboard.ts`'s team-today board literally reads `isClockedIn = entries.some(e => !e.endTime)`,
 * and the missing-workdays detector's `entryDates` set must NOT drop a day whose entry is still
 * open (unclosed clock-in), or a forgotten clock-out would be double-counted as BOTH "still open"
 * and "missing" for the same day — pinned by `__tests__/facade-time-entries.test.ts`. Filtering
 * `endTime: { not: null }` at the DB level for these four sites (T2's actual clause) would silently
 * drop those rows from the result set entirely — not a display nuance, an observable regression
 * (the "clocked in" badge would never show, and a forgotten clock-out would double-flag). These
 * four collapse into {@link getRecordedWorkEntriesInRange} instead, a genuinely different
 * question ("what has been recorded, open or closed, valid or invalid") from T2's ("what CLOSED
 * work happened, valid or invalid"). `dashboard.ts`'s own single-entry "heute" card (`todayEntries`)
 * DOES fit T2 exactly, despite lacking the `endTime` clause in its pre-facade `where` — its own
 * loop only ever sums a row when `e.endTime` is truthy, so T2's DB-level filter is a proven no-op
 * there (same rows sum to the same total either way); it stays a T2 site.
 *
 * `absence/vocational-school-generator.ts`'s conflict-detection read differs even further — no
 * `type` filter (an `OVERTIME`/`PUBLIC_HOLIDAY`-typed entry must ALSO block a Berufsschule
 * generation on that day, per its own pre-existing docblock), no `endTime`/`isInvalid` filter
 * either. Its own where-clause is a THIRD, looser shape and gets its own
 * {@link getClaimedEntryDatesInRange}.
 *
 * This mirrors exactly the precedent Plan 07 set with W2a/W2b: when a shape genuinely diverges,
 * split into a separately-named function rather than force one signature or accept a silent
 * behaviour change — the total READ site count across the T1/T2 family is unchanged (13), only
 * the grouping is corrected. Four functions instead of two; fourteen facade functions in total
 * instead of the plan's own estimate of twelve, for the same reason plan 07's W2 became W2a/W2b:
 * the estimate is the planner's; the shape is the code's, and the code wins (see this plan's own
 * task instruction: "if a site differs in another way, it belongs to neither and the grouping is
 * wrong").
 *
 * ── H1/D-08 — the soft-delete carve-out, two named functions, not a uniform guard ──────────────
 * {@link clearEntryNotesForEmployee} (T10) and {@link hardDeleteTimeDataForEmployee} (T11)
 * deliberately omit `deletedAt: null`: DSGVO Art. 17 anonymisation and a hard delete must both
 * reach soft-deleted rows too. Both carry named `lint-facade-signatures` F3 exceptions (no
 * `tenantId` parameter — see each function's own docblock for the legal/structural basis) — the
 * same pattern plan 06 used for `hardDeleteOvertimeDataForEmployee`. Every other function in this
 * file carries `deletedAt: null` and a `tenantId` (via `EmployeeScope` or an explicit parameter).
 *
 * ── H2 — `isLocked` is Revisionssicherheit, not a filter ────────────────────────────────────────
 * {@link revalidateLeaveCancellationEntries} (T6) never touches a row with `isLocked: true` or
 * `deletedAt != null` — CLAUDE.md § "Immutability after lock". {@link lockEntriesForMonth} (T7)
 * and {@link unlockEntriesForMonth} (T8) use DAY bounds (`monthDayBounds()`), not the raw
 * month-start/end timestamps — the timestamp lower bound casts to the PREVIOUS month's last day
 * for a UTC+ tenant and would lock/unlock one day too many; copied verbatim from
 * `auto-close-month.ts`'s own comment, not re-derived.
 */
import type { Prisma } from "@clokr/db";
import { type EmployeeScope, employeeScopeWhere } from "../../platform";
import { CLEARED_INVALID_REASON } from "../invalid-reason";

/** `periodStart`-style calendar-date keying, mirrored (not shared) from the identical helper in
 * `working-time-account/facade/saldo-snapshot.ts` / `scheduling/shift-cleanup.ts` /
 * `absence/vocational-school-generator.ts` — same reasoning: `TimeEntry.date` is `@db.Date`, and a
 * `toISOString().slice(0, 10)` key is the calendar-date-only projection every one of those bulk
 * lookups needs. */
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── T1 — the saldo input ─────────────────────────────────────────────────────────────────────

/**
 * T1 — every CLOSED, VALID `WORK` entry for `scope` in `[from, to]`. THE SALDO INPUT: feeds
 * `closeEmployeeMonth()` at all 4 call sites (`month-saldo.ts`, `recalculate-snapshots.ts`,
 * `overtime.ts`'s manual close, `auto-close-month.ts`'s cron close) — see the module header for
 * why this must never be merged with {@link getWorkedEntriesInRange} (T2).
 */
export async function getValidWorkedEntriesInRange(
  db: Prisma.TransactionClient,
  scope: EmployeeScope,
  from: Date,
  to: Date,
) {
  return db.timeEntry.findMany({
    where: {
      ...employeeScopeWhere(scope),
      deletedAt: null,
      date: { gte: from, lte: to },
      endTime: { not: null },
      type: "WORK",
      isInvalid: false,
    },
    select: { date: true, startTime: true, endTime: true, breakMinutes: true },
  });
}

// ── T2 — the closed-entry display set (strict: 4 sites) ─────────────────────────────────────

/**
 * T2 — every CLOSED `WORK` entry for `scope` in `[from, to]`, valid or invalid — same as T1 minus
 * `isInvalid`. Sites: `close-month-data.ts`'s bulk BREAK-05 fetch, `auto-close-month.ts`'s
 * per-month gap-readiness re-check, and `dashboard.ts`'s "heute"/"woche" worked-minutes cards (see
 * the module header for why `todayEntries` fits this shape despite its pre-facade `where` lacking
 * the `endTime` clause — a proven no-op there, not an approximation).
 *
 * Phase 71b (issue #71): `salonId` is selected additively — no existing reader is affected — so
 * callers can hand these rows to the Unterbau's central holiday resolver
 * (`contexts/platform`'s `holidaysAtWorkLocation`) as the per-day work location, without the
 * Unterbau ever reading `TimeEntry` itself.
 */
export async function getWorkedEntriesInRange(
  db: Prisma.TransactionClient,
  scope: EmployeeScope,
  from: Date,
  to: Date,
) {
  return db.timeEntry.findMany({
    where: {
      ...employeeScopeWhere(scope),
      deletedAt: null,
      date: { gte: from, lte: to },
      endTime: { not: null },
      type: "WORK",
    },
    select: {
      id: true,
      employeeId: true,
      date: true,
      startTime: true,
      endTime: true,
      breakMinutes: true,
      breakStatus: true,
      isLocked: true,
      salonId: true,
    },
  });
}

// ── T2-regrouped — recorded (open or closed, valid or invalid) WORK entries ──────────────────

/**
 * Recorded `WORK` entries for `scope` in `[from, to]` — OPEN (unclosed clock-in) and INVALID rows
 * included, unlike T1/T2. See the module header's "T2 regrouping" section for the 4 sites this
 * covers (`dashboard.ts`'s team-week calendar, team-today presence board, personal week view, and
 * the missing-workdays detector's `entryDates` set) and why each of them observably needs the open
 * rows T2's `endTime: { not: null }` clause would silently drop.
 */
export async function getRecordedWorkEntriesInRange(
  db: Prisma.TransactionClient,
  scope: EmployeeScope,
  from: Date,
  to: Date,
) {
  return db.timeEntry.findMany({
    where: {
      ...employeeScopeWhere(scope),
      deletedAt: null,
      date: { gte: from, lte: to },
      type: "WORK",
    },
    select: {
      employeeId: true,
      date: true,
      startTime: true,
      endTime: true,
      breakMinutes: true,
      isInvalid: true,
    },
  });
}

// ── T2-regrouped — any claimed entry-date, any TimeEntryType ─────────────────────────────────

/**
 * Which `${employeeId}::${isoDate}` pairs already have ANY non-deleted `TimeEntry` (any
 * `TimeEntryType` — `WORK`, `OVERTIME`, or `PUBLIC_HOLIDAY`) in `[from, to]`? Sole caller:
 * `absence/vocational-school-generator.ts`'s conflict detector — a day already carrying recorded
 * time (of ANY type) blocks an automatic Berufsschule-day insert by default (its own pre-existing
 * docblock explains why: an `isInvalid` row still occupies the day's only slot and still
 * represents someone's claim of presence). Deliberately the loosest of the four read shapes in
 * this file — no `type`, `endTime`, or `isInvalid` filter — because narrowing it to `type: "WORK"`
 * would let an `OVERTIME`/`PUBLIC_HOLIDAY` entry silently stop blocking the generator, a real
 * behaviour change this plan does not make (D-13).
 */
export async function getClaimedEntryDatesInRange(
  db: Prisma.TransactionClient,
  employeeIds: string[],
  tenantId: string,
  from: Date,
  to: Date,
): Promise<Set<string>> {
  if (employeeIds.length === 0) return new Set();
  const rows = await db.timeEntry.findMany({
    where: {
      employeeId: { in: employeeIds },
      employee: { tenantId },
      deletedAt: null,
      date: { gte: from, lte: to },
    },
    select: { employeeId: true, date: true },
  });
  return new Set(rows.map((r) => `${r.employeeId}::${toIsoDate(r.date)}`));
}

// ── T3 — the month-lock signal snapshot-lock.ts derives from TimeEntry ───────────────────────

/**
 * T3 — how many non-deleted `TimeEntry` rows for `employeeId` in `[periodStart, periodEnd]` carry
 * `isLocked: true`? Sole caller: `working-time-account/snapshot-lock.ts`'s `isSnapshotLocked()`,
 * which reduces this to a boolean — see that file's own docblock for the "TimeEntry-derived, not a
 * SaldoSnapshot column" design and its recorded limitation (a closed month with ZERO entries never
 * registers as locked by this signal).
 */
export async function countLockedEntries(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<number> {
  return db.timeEntry.count({
    where: {
      employeeId,
      employee: { tenantId },
      deletedAt: null,
      date: { gte: periodStart, lte: periodEnd },
      isLocked: true,
    },
  });
}

// ── T4 — invalid-entry count for the dashboard "Fehlt" family ────────────────────────────────

/**
 * T4 — every non-deleted `isInvalid: true` entry for `employeeId`, any type. Sole caller:
 * `dashboard.ts`'s open-items card (invalidEntriesCount). No date range and no `type` filter —
 * matches the pre-facade query exactly.
 */
export async function getInvalidEntries(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
) {
  return db.timeEntry.findMany({
    where: { employeeId, employee: { tenantId }, deletedAt: null, isInvalid: true },
    select: { id: true },
  });
}

// ── T5 — the "own activity" feed, ordered by createdAt (not date) ───────────────────────────

/**
 * T5 — the most recent `TimeEntry` rows for `employeeId` created since `since`, newest first,
 * capped at `limit`. Sole caller: `platform/api/activity.ts`'s "Aktivität" widget. Ordered by
 * `createdAt` — an essential difference from every other function in this file, which order (or
 * filter) by `date`: this feed renders "Einstempeln um HH:mm" / "Ausstempeln um HH:mm" as they
 * were RECORDED, not as they occurred.
 */
export async function getEntryActivityFeed(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  since: Date,
  limit: number,
) {
  return db.timeEntry.findMany({
    where: { employeeId, employee: { tenantId }, deletedAt: null, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

// ── T6 — leave-cancellation revalidation ─────────────────────────────────────────────────────

/**
 * T6 — clears the `LEAVE_CANCELLATION_PENDING` invalidation for every entry of `employeeId` in
 * `[from, to]`. H2: never touches a row with `isLocked: true` or `deletedAt != null` — dropping
 * either guard would let a cancellation-approval/correction modify a locked month's entry, exactly
 * the invariant CLAUDE.md § "Immutability after lock" exists to prevent. Two call sites in
 * `absence/api/leave.ts`: the cancellation-approval handler (`app.prisma`) and the
 * PATCH `/requests/:id/correct` handler's own delta-reversal `tx`.
 */
export async function revalidateLeaveCancellationEntries(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<void> {
  if (from > to) return;
  await db.timeEntry.updateMany({
    where: {
      employeeId,
      employee: { tenantId },
      date: { gte: from, lte: to },
      isInvalid: true,
      invalidReasonCode: "LEAVE_CANCELLATION_PENDING",
      deletedAt: null, // H2/D-08 — never touch a soft-deleted entry
      isLocked: false, // H2 — never mutate a locked-month entry (Revisionssicherheit)
    },
    data: { isInvalid: false, ...CLEARED_INVALID_REASON },
  });
}

// ── T7/T8 — Monatsabschluss lock / unlock ────────────────────────────────────────────────────

/**
 * T7 — locks every non-deleted entry of `employeeId` in `[from, to]` (`isLocked: true,
 * lockedAt`). `from`/`to` MUST already be DAY bounds (`monthDayBounds()`), not the raw
 * month-start/end timestamps — see the module header. Two call sites, both on a `tx`:
 * `overtime.ts`'s manual close and `auto-close-month.ts`'s cron close.
 */
export async function lockEntriesForMonth(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<void> {
  await db.timeEntry.updateMany({
    where: { employeeId, employee: { tenantId }, deletedAt: null, date: { gte: from, lte: to } },
    data: { isLocked: true, lockedAt: new Date() },
  });
}

/**
 * T8 — the inverse of {@link lockEntriesForMonth}: unlocks every non-deleted entry of
 * `employeeId` in `[from, to]` (`isLocked: false, lockedAt: null`). Sole caller: `overtime.ts`'s
 * `POST /unlock-month`, on its own `tx`.
 */
export async function unlockEntriesForMonth(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<void> {
  await db.timeEntry.updateMany({
    where: { employeeId, employee: { tenantId }, deletedAt: null, date: { gte: from, lte: to } },
    data: { isLocked: false, lockedAt: null },
  });
}

// ── T9 — retention archival ───────────────────────────────────────────────────────────────────

/**
 * T9 — soft-deletes every non-deleted entry of `employeeIds` with `date <= cutoff`, returns the
 * count archived. Sole caller: `platform/plugins/data-retention.ts`'s annual archival cron, inside
 * its own per-tenant loop (same file, same loop as `countSnapshotsBefore`/W7 — `tenantId` is a
 * proven no-op here for the identical reason: `employeeIds` already comes from that loop's own
 * `employee.findMany({ where: { tenantId } })`).
 */
export async function archiveEntriesBefore(
  db: Prisma.TransactionClient,
  employeeIds: string[],
  tenantId: string,
  cutoff: Date,
): Promise<number> {
  if (employeeIds.length === 0) return 0;
  const result = await db.timeEntry.updateMany({
    where: {
      employeeId: { in: employeeIds },
      employee: { tenantId },
      deletedAt: null,
      date: { lte: cutoff },
    },
    data: { deletedAt: new Date() },
  });
  return result.count;
}

// ── T10 — DSGVO Art. 17: clear notes, deliberately reaching soft-deleted rows ────────────────

/**
 * T10 — DSGVO Art. 17 anonymisation: sets `note: null` on every entry of `employeeId` that has a
 * note, INCLUDING soft-deleted rows (no `deletedAt: null` guard — Art. 17 must reach a
 * soft-deleted row's PII too, exactly like every other field `platform/anonymize.ts` clears).
 * Carries a named `lint-facade-signatures` F3 exception (no `tenantId` parameter): its sole
 * caller, `anonymizeEmployeeData()`, already resolves and validates `employeeId` before this
 * function is ever reached, and this is a hard `note` scrub with nothing left to constrain by
 * tenant that the caller hasn't already fixed. Runs on the caller's own `tx` (the whole
 * anonymisation sequence is one transaction).
 */
export async function clearEntryNotesForEmployee(
  db: Prisma.TransactionClient,
  employeeId: string,
): Promise<void> {
  await db.timeEntry.updateMany({
    where: { employeeId, note: { not: null } },
    data: { note: null },
  });
}

// ── T11 — hard delete: Break before TimeEntry, the ORDER is the invariant ────────────────────

/**
 * T11 — hard-deletes every `Break` row for `employeeId` (via its `TimeEntry` relation), THEN every
 * `TimeEntry` row for `employeeId`. `Break` before `TimeEntry` — `Break.timeEntry` is
 * `onDelete: Cascade` but `TimeEntry.employee` is `onDelete: Restrict`, and Postgres evaluates
 * FK constraints per-statement, not per-transaction, so deleting `TimeEntry` rows that still have
 * `Break` children in a DIFFERENT unrelated Restrict chain is not the risk here — the ORDER that
 * matters is this file's own hard-delete SEQUENCE (`platform/api/employees.ts`'s
 * `DELETE /:id/hard-delete`), which deletes several Restrict-protected models in a fixed order
 * inside one `$transaction`; this pair is placed exactly where it was before this plan (immediately
 * before `leaveRequest`/`absence`), so the sequence order is unchanged. No `deletedAt: null`, no
 * `tenantId` parameter — a HARD delete by definition reaches everything, and this function's sole
 * caller validates `id` against `req.user.tenantId` at the top of its own handler, BEFORE the
 * hard-delete `$transaction` — and therefore before this function — is ever reached. Carries a
 * named `lint-facade-signatures` F3 exception for exactly that reason (same shape as plan 06's
 * `hardDeleteOvertimeDataForEmployee`).
 */
export async function hardDeleteTimeDataForEmployee(
  db: Prisma.TransactionClient,
  employeeId: string,
): Promise<void> {
  await db.break.deleteMany({ where: { timeEntry: { employeeId } } });
  await db.timeEntry.deleteMany({ where: { employeeId } });
}

// ── T12 — CSV bulk import ─────────────────────────────────────────────────────────────────────

export type ImportedTimeEntryData = {
  employeeId: string;
  date: Date;
  startTime: Date;
  endTime: Date;
  breakMinutes: number;
  note: string | null;
  /**
   * Phase 68b (issue #68), D-11: the caller resolves this through `resolveEntrySalon` for the
   * same tenant as `employeeId`, so the entry's salon and employee share a tenant by construction.
   */
  salonId: string;
};

/**
 * T12 — creates one imported `TimeEntry` row (`type: "WORK"`, `source: "MANUAL"`). No `where` (a
 * `create`), no `tenantId` parameter needed: `employeeId` is nested inside `data`, not a top-level
 * `*Id` parameter, so `lint-facade-signatures`'s F3 does not apply here, and its sole caller
 * (`platform/api/imports.ts`) already resolves+validates `employeeId` via
 * `validateTimeEntryInvariants({ ..., tenantId: req.user.tenantId })` immediately before calling
 * this.
 */
export async function createImportedTimeEntry(
  db: Prisma.TransactionClient,
  data: ImportedTimeEntryData,
) {
  return db.timeEntry.create({
    data: {
      employeeId: data.employeeId,
      date: data.date,
      startTime: data.startTime,
      endTime: data.endTime,
      breakMinutes: data.breakMinutes,
      note: data.note,
      type: "WORK",
      source: "MANUAL",
      salonId: data.salonId, // Phase 68b (issue #68), D-11
    },
  });
}
