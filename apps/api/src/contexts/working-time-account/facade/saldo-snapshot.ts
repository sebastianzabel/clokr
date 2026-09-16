/**
 * Phase 100B Plan 07 (Wave 3, final) — Arbeitszeitkonto's `SaldoSnapshot` facade.
 *
 * ADR 0001 rule 3: no direct table access across foreign schemas; every caller outside this
 * context reaches `SaldoSnapshot` through one of the functions below, never through
 * `prisma.saldoSnapshot`/`tx.saldoSnapshot` directly. `saldoSnapshot` is added to `convertedModels`
 * in `apps/api/scripts/foreign-context-access-exceptions.json` in the same commit, so a future
 * direct access is a hard error, not a slip that has to be re-discovered.
 *
 * D-07: every export's first parameter is `db: Prisma.TransactionClient` — `PrismaClient` is
 * assignable to it, so the same function runs whether the caller is inside a `$transaction` or
 * not. `apps/api/scripts/lint-facade-signatures.ts` enforces this mechanically (F1/F2).
 *
 * ── W1 `isMonthClosed` — THE canonical Monatsabschluss signal ──────────────────────────────────
 * Five call sites asked "is employee X's month Y closed?" with the SAME MEANING but two
 * DIFFERENT `where` shapes:
 *
 *   | Site                                                    | shape (pre-plan)                    |
 *   |----------------------------------------------------------|-------------------------------------|
 *   | `absence/api/leave.ts` (`PATCH /requests/:id/correct`)    | `periodStartWindow(monthStart)`      |
 *   | `absence/api/vocational-school.ts` (`POST /manual-insert`)| bare `periodStart: monthStart`       |
 *   | `absence/api/vocational-school.ts` (`DELETE /:absenceId`) | bare `periodStart: monthStart`       |
 *   | `scheduling/api/shifts.ts` (`POST /:id/restore`)          | bare `periodStart: monthStart`       |
 *   | `time-tracking/api/time-entries.ts` (`validateTimeEntryInvariants`) | bare `periodStart: monthStart` |
 *
 * This plan's own Task 1/2 checkpoint originally framed that as a design choice (preserve / unify
 * / split, each changing the four bare sites' observable behaviour). **It turned out to be a
 * defect, not a design divergence.** `SaldoSnapshot.periodStart` is written by `monthRangeUtc()`
 * (tenant-local midnight of day 1, converted to UTC) — for Europe/Berlin the real stored value
 * falls on the LAST DAY OF THE PREVIOUS MONTH. All five sites above were already deriving
 * `monthStart` via `monthRangeUtc()` correctly by the time this plan resumed (fixed in
 * `8326859d`/`840d9976`/`39b9ade4`, issue #241, BEFORE this plan's Task 3 ran) — the divergence
 * that remained was never about WHICH `monthStart` value to compare, only about the SHAPE of the
 * comparison once both sides already agree on that value: an exact `periodStart: monthStart`
 * match, or a 2-day window (`periodStartWindow`, `../snapshot-period.ts`) that additionally
 * matches a legacy UTC-naive storage convention some rows still carry (confirmed still present —
 * see `leave-correct.test.ts:210`'s fixture comment and `snapshot-period.ts`'s own docblock).
 *
 * The window form is a PROVEN safe superset of the bare form for any correctly-derived
 * `monthStart`: it matches every row the bare form matches (`gte: monthStart` includes the exact
 * value) plus, additionally, any legacy-convention row for the same month — and, per
 * `periodStartWindow`'s own docblock, it provably excludes the NEXT month's TZ-converted
 * `periodStart` (the last day of THIS month), so it can never falsely report a DIFFERENT month as
 * closed. It is also already this context's OWN established internal convention
 * (`plugins/auto-close-month.ts`, `api/overtime.ts` — both use `periodStartWindow` exclusively,
 * never the bare form). Unifying `isMonthClosed` on `periodStartWindow` is therefore not a
 * re-litigation of the owner's D1 checkpoint (which was about the now-fixed tenant-TZ defect, not
 * about this window-vs-bare shape) — it is a monotonic strengthening in the same "correct
 * direction" the checkpoint's own RESEARCH note already named, applied to a question the
 * checkpoint's resolution explicitly closed: "the facade carries the `monthRangeUtc`-derived form.
 * There is no second form to preserve." Do not reopen either question here.
 *
 * `getMonthClosingBalance` (W4, `composition/reports.ts`) is a DIFFERENT function asking a
 * DIFFERENT question (the closing BALANCE for a month, not whether it is locked) and was never
 * part of the D1 divergence or the #241 defect (its `monthStart` was always correctly
 * `monthRangeUtc`-derived, and #241 never touched `reports.ts`) — its bare-form `where` is
 * preserved exactly as-is, not extended by this decision (D-13: no opportunistic improvement).
 */
import type { Prisma } from "@clokr/db";
import { periodStartWindow } from "../snapshot-period";

// ── Local helpers (module-private) ───────────────────────────────────────────────────────────

/** `periodStart` is `@db.Date` — Prisma reads a fetched row back as UTC midnight of its calendar
 * date, discarding any real time-of-day a freshly-computed `monthRangeUtc`/`monthLockBoundUtc`
 * value legitimately carries. Calendar-date-only comparison, mirroring the identical helper in
 * `scheduling/shift-cleanup.ts` and `absence/vocational-school-generator.ts` (issue #241, fifth
 * site) — not re-invented, mirrored. */
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── W1 — the month-lock signal ───────────────────────────────────────────────────────────────

/**
 * W1 — is `employeeId`'s month beginning at `monthStart` (a `monthRangeUtc`-derived value) closed?
 * THE canonical Monatsabschluss signal — see the module header above for the five call sites this
 * collapses and the D1 decision. `employee: { tenantId }` is a proven no-op strengthening at every
 * one of the five sites: each already tenant-validates `employeeId` immediately before reaching
 * this check (leave.ts: `existing.employee.tenantId` fetch-then-compare; vocational-school.ts:
 * `employee`/`absence` fetched with an inline `tenantId`/`employee:{tenantId}` filter;
 * shifts.ts: `shift` fetched with `employee:{tenantId: req.user.tenantId}`; time-entries.ts:
 * `validateTimeEntryInvariants` already takes `tenantId` as a declared parameter).
 */
export async function isMonthClosed(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  monthStart: Date,
): Promise<boolean> {
  const snapshot = await db.saldoSnapshot.findFirst({
    where: {
      employeeId,
      employee: { tenantId },
      periodType: "MONTHLY",
      periodStart: periodStartWindow(monthStart),
      superseded: false,
    },
    select: { id: true },
  });
  return snapshot !== null;
}

// ── W2 — bulk month-lock lookup ──────────────────────────────────────────────────────────────

/**
 * W2a — bulk locked-month lookup across `employeeIds` for a DISCRETE list of month starts
 * (`shift-cleanup.ts`'s shape — the exact set of months the affected shifts touch). ONE
 * `findMany` (R-B, mirrors `getConfirmedCarryOverBulk`'s N+1-free bulk shape). Returns a `Set`
 * keyed by `${employeeId}::${YYYY-MM-DD}` (calendar-date-only, per `toIsoDate` above) — the SAME
 * composite key format `getClosedMonthsInRange` (W2b) below returns; `shift-cleanup.ts` (a
 * single-employee caller) prefixes its lookup key with its own `employeeId` to match, exactly as
 * `vocational-school-generator.ts` already did before this plan.
 *
 * A separate function from `getClosedMonthsInRange`, not one function taking a discriminated
 * `{monthStarts} | {from,to}` union — `monthStarts`/`from`/`to` are bare top-level parameters of
 * THEIR OWN exported function, which is what makes each individually traceable by
 * `lint:saldo-lock-derivation`'s facade-parameter resolver (100B Plan 07): a parameter reached
 * only through PROPERTY ACCESS on a wrapping union object (`query.monthStarts`) is invisible to
 * that resolver's one-hop, bare-identifier-only design, and would have silently downgraded
 * `shift-cleanup.ts`'s and `vocational-school-generator.ts`'s own pre-plan "safe" verdicts to
 * "unknown" — exactly the regression this plan's own checkpoint explicitly forbids.
 */
export async function getClosedMonthsForDates(
  db: Prisma.TransactionClient,
  employeeIds: string[],
  tenantId: string,
  monthStarts: Date[],
): Promise<Set<string>> {
  if (employeeIds.length === 0) return new Set();
  const rows = await db.saldoSnapshot.findMany({
    where: {
      employeeId: { in: employeeIds },
      employee: { tenantId },
      periodType: "MONTHLY",
      periodStart: { in: monthStarts },
      superseded: false,
    },
    select: { employeeId: true, periodStart: true },
  });
  return new Set(rows.map((r) => `${r.employeeId}::${toIsoDate(r.periodStart)}`));
}

/**
 * W2b — bulk locked-month lookup across `employeeIds` for an INCLUSIVE range
 * (`vocational-school-generator.ts`'s shape — a retro/forward generation window). See
 * `getClosedMonthsForDates` (W2a) above for why this is a second, separately-named function
 * rather than one function over a discriminated query shape.
 */
export async function getClosedMonthsInRange(
  db: Prisma.TransactionClient,
  employeeIds: string[],
  tenantId: string,
  from: Date,
  to: Date,
): Promise<Set<string>> {
  if (employeeIds.length === 0) return new Set();
  const rows = await db.saldoSnapshot.findMany({
    where: {
      employeeId: { in: employeeIds },
      employee: { tenantId },
      periodType: "MONTHLY",
      periodStart: { gte: from, lte: to },
      superseded: false,
    },
    select: { employeeId: true, periodStart: true },
  });
  return new Set(rows.map((r) => `${r.employeeId}::${toIsoDate(r.periodStart)}`));
}

// ── W4 — a single month's closing balance ────────────────────────────────────────────────────

/**
 * W4 — the closing `balanceMinutes` for `employeeId`'s month beginning at `monthStart`, or `null`
 * if that month has no active (non-superseded) MONTHLY snapshot yet (still open). Sole caller:
 * `composition/reports.ts`'s `resolveReportOvertimeHours` (the legal Stundennachweis PDF). Its
 * bare `periodStart: monthStart` comparison is preserved EXACTLY — see the module header's note on
 * why this is a different question from W1's and was never part of the D1 divergence.
 */
export async function getMonthClosingBalance(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  monthStart: Date,
): Promise<number | null> {
  const snapshot = await db.saldoSnapshot.findFirst({
    where: {
      employeeId,
      employee: { tenantId },
      periodType: "MONTHLY",
      periodStart: monthStart,
      superseded: false,
    },
    select: { balanceMinutes: true },
  });
  return snapshot ? snapshot.balanceMinutes : null;
}

// ── W5 — snapshots in a range, for many employees ────────────────────────────────────────────

export type MonthlySnapshotRow = {
  id: string;
  employeeId: string;
  periodStart: Date;
  balanceMinutes: number;
  carryOver: number;
  closedAt: Date;
};

/**
 * W5 — every active (non-superseded) MONTHLY snapshot for `employeeIds`, optionally bounded below
 * by `from`, ordered `periodStart` ascending. The read shape is the verified UNION across both
 * call sites (`dashboard.ts`'s 6-month trend chart needs `employeeId`/`periodStart`/
 * `balanceMinutes`/`carryOver`; `activity.ts`'s "own monthly close" feed needs `id`/`periodStart`/
 * `closedAt`) — every field either site reads, read before writing this function, matching R-C.
 *
 * `activity.ts` passes a single-element `employeeIds` array and no `from` bound (it wants ALL of
 * an employee's history, not a 6-month window), then re-sorts the result by `closedAt` DESCENDING
 * and slices to its own `fetchLimit` in the caller — reproducing the original
 * `orderBy:{closedAt:"desc"}, take:fetchLimit` DB-level behaviour exactly (same top-N items,
 * verified equivalent since the underlying row set is identical either way).
 */
export async function getMonthlySnapshotsInRange(
  db: Prisma.TransactionClient,
  employeeIds: string[],
  tenantId: string,
  from?: Date,
): Promise<MonthlySnapshotRow[]> {
  if (employeeIds.length === 0) return [];
  return db.saldoSnapshot.findMany({
    where: {
      employeeId: { in: employeeIds },
      employee: { tenantId },
      periodType: "MONTHLY",
      // `periodStart: undefined` (not a conditional spread) — Prisma drops an `undefined`-valued
      // key from the `where` entirely, so this is behaviourally identical to the spread form this
      // replaced, but keeps `periodStart` a direct sibling of `periodType` in the SAME object
      // literal, which `lint:saldo-lock-derivation`'s candidate detector requires to recognise
      // this as a MONTHLY periodStart comparison at all (a conditional SPREAD hid this comparison
      // from the gate entirely — invisible, not merely "unknown" — until this was reworked).
      periodStart: from ? { gte: from } : undefined,
      superseded: false,
    },
    orderBy: { periodStart: "asc" },
    select: {
      id: true,
      employeeId: true,
      periodStart: true,
      balanceMinutes: true,
      carryOver: true,
      closedAt: true,
    },
  });
}

// ── W6 — team carry-over sum, by month ───────────────────────────────────────────────────────

export type CarryOverByMonth = { periodStart: Date; carryOver: number };

/**
 * W6 — `SUM(carryOver)` grouped by `periodStart`, MONTHLY only, for `employeeIds` from `from`
 * onward. Sole caller: `dashboard.ts`'s `GET /overtime-trend`.
 *
 * D2 (this plan's checkpoint, RESOLVED — do not reopen): the pre-facade `groupBy` at
 * `dashboard.ts:1322` omitted `superseded: false` while its sibling `findMany` at
 * `dashboard.ts:777` (now W5) carried it. Measured against the dev database for the same 6-month
 * window: BOTH forms return identical rows and identical `SUM(carryOver)` — there is not a single
 * `superseded: true` row anywhere in the dataset (2019-12-31…2026-07-31). This function keeps
 * `superseded: false` — the stricter, semantically correct form (a superseded row's `carryOver`
 * must never enter a team-wide sum) — deliberately, not incidentally: the omission at the old call
 * site was never a considered choice, and inert-on-today's-data is not the same as "safe to leave
 * out going forward" once a re-closed month starts producing a genuine superseded row.
 *
 * `tenantId` is declared (D-10/G4) but NOT used in the `where` — Prisma's `groupBy` does not
 * support relation filters (the ORIGINAL `dashboard.ts` code's own comment: "Prisma groupBy does
 * not support relation filters in `where`, so we resolve tenant scoping via a separate employee
 * query"), and that is exactly what the caller still does immediately before calling this function
 * — `employeeIds` is already tenant-scoped by the time it arrives here. Same shape as
 * `overtime-account.ts`'s `createOvertimeAccount` (plan 06): a declared-but-unused parameter,
 * reasoned, not silent.
 */
export async function sumCarryOverByMonth(
  db: Prisma.TransactionClient,
  employeeIds: string[],
  tenantId: string,
  from: Date,
): Promise<CarryOverByMonth[]> {
  void tenantId; // see docblock — groupBy cannot filter by the `employee` relation
  if (employeeIds.length === 0) return [];
  const grouped = await db.saldoSnapshot.groupBy({
    by: ["periodStart"],
    where: {
      employeeId: { in: employeeIds },
      periodType: "MONTHLY",
      periodStart: { gte: from },
      superseded: false, // D2 — deliberate, see docblock; not present at the old call site
    },
    _sum: { carryOver: true },
    orderBy: { periodStart: "asc" },
  });
  return grouped.map((g) => ({ periodStart: g.periodStart, carryOver: g._sum.carryOver ?? 0 }));
}

// ── W7 — retention count ─────────────────────────────────────────────────────────────────────

/**
 * W7 — how many `SaldoSnapshot` rows for `employeeIds` have `periodEnd <= cutoff`? Sole caller:
 * `platform/plugins/data-retention.ts`'s annual archival gate ("only archive if snapshots cover
 * the data we're about to soft-delete"). Unlike W6's `groupBy`, `count()` accepts the same
 * relation-filter `where` shape as `findMany` — `employee: { tenantId }` is a proven no-op
 * addition, since the caller derives `employeeIds` from its own tenant-scoped
 * `employee.findMany({ where: { tenantId } })` immediately above, per tenant, inside the
 * retention cron's own per-tenant loop.
 */
export async function countSnapshotsBefore(
  db: Prisma.TransactionClient,
  employeeIds: string[],
  tenantId: string,
  cutoff: Date,
): Promise<number> {
  if (employeeIds.length === 0) return 0;
  return db.saldoSnapshot.count({
    where: {
      employeeId: { in: employeeIds },
      employee: { tenantId },
      periodEnd: { lte: cutoff },
    },
  });
}
