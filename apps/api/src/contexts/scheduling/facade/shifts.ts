/**
 * Phase 100B Plan 05 (Wave 2) — Schichtplanung's `Shift`-model facade.
 *
 * ADR 0001 rule 3: no direct table access across foreign schemas; every caller outside this
 * context reaches `Shift` through one of the three named functions below, never through
 * `prisma.shift`/`tx.shift` directly. `apps/api/scripts/measure-foreign-context-access.ts` lists
 * `shift` in `convertedModels` once this lands, so a future direct access is a hard error, not a
 * slip that has to be re-discovered.
 *
 * D-07: every export's first parameter is `db: Prisma.TransactionClient` — `PrismaClient` is
 * assignable to it, so the SAME function runs whether the caller is inside a `$transaction` or
 * not. `apps/api/scripts/lint-facade-signatures.ts` enforces this mechanically (F1/F2).
 *
 * ── S1 getShiftsInRange — the collapse ────────────────────────────────────────────────────────
 * 17 raw `shift.findMany(...)` call sites over a date window collapse into ONE function taking an
 * `EmployeeScope` (per-employee / bulk / tenant-wide — `contexts/platform/facade/employee-scope.ts`,
 * plan 04). All 17 original `select`/`include` sets were read (not assumed) before writing this
 * function's own select:
 *
 *   | Field                    | Needed by (representative sites)                                  |
 *   |---------------------------|-------------------------------------------------------------------|
 *   | `id`                      | `settings.ts:854` (built `futureShiftIds` for S3)                  |
 *   | `employeeId`               | `dashboard.ts:408` (tenant-wide: buckets shifts per employee)      |
 *   | `date`                     | every one of the 17 (the window itself)                            |
 *   | `startTime`/`endTime`      | `dashboard.ts:408/952`, `leave.ts:3822`, `settings.ts:854`,        |
 *   |                            | `time-entries.ts:2572`, `overtime.ts:1148`, `month-saldo.ts:194`,  |
 *   |                            | `recalculate-snapshots.ts:350`, `auto-close-month.ts:558`          |
 *   | `label`                    | `dashboard.ts:408/952` (falls back to `template.name`)             |
 *   | `template.name`/`.color`   | `dashboard.ts:408/952` (`include: { template: { select: ... } }`)  |
 *
 * The remaining 8 sites (`dashboard.ts:1171`, `attendance-checker.ts:668/844`,
 * `overtime.ts:532/828`, `month-saldo.ts:194`†, `auto-close-month.ts:360`) select only `date` (or
 * `date`+`startTime`+`endTime`) — a NARROWER read than this union. R-C: that narrowing is
 * INCIDENTAL (the caller only happens to use fewer fields), not ESSENTIAL — none of the 17 filter
 * a field this union omits, or apply a different status/type predicate. Returning the union and
 * letting each caller read only the fields it needs is the one query this design rule calls for.
 * †`month-saldo.ts:194`/`recalculate-snapshots.ts:350`/`auto-close-month.ts:558` select
 * `date`+`startTime`+`endTime` (no `id`/`label`/`template`); listed once above, not duplicated.
 *
 * Ordering: `[{ date: "asc" }, { startTime: "asc" }]` on EVERY call — `leave.ts:3822`
 * (`getScheduledHours`, "first rostered shift" for a half-day credit) is the one site that already
 * needed this exact tie-break (D-07/WR-02: `Shift` has no unique constraint on
 * `(employeeId, date)`, so same-day split shifts tie under `date`-only ordering with no guaranteed
 * row order from Postgres/Prisma). The other 15 sites had no `orderBy` at all; giving them the same
 * deterministic order is a safe, uniform default, not a behaviour change any of them depended on
 * NOT having (none of them assume the earlier undefined order).
 *
 * `deletedAt: null` (D-08, Phase 67.2) is in the `where` unconditionally — read all 17 originals,
 * every one already carried it, and there is no deliberate "…WithDeleted" variant among them. Its
 * absence here would be a finding, not a design choice; there isn't one to make.
 *
 * Tenant: `EmployeeScope`'s `"tenant"` variant constrains via `employee: { tenantId }`
 * (`employeeScopeWhere`, plan 04). The `"employee"`/`"employees"` variants constrain by
 * `employeeId` ONLY, exactly matching what all 16 read call sites of that shape do today (none of
 * them additionally filter `employee: { tenantId }` — `dashboard.ts:1171` is the one exception that
 * DOES carry the extra clause today; removing it here is a no-op because a single `employeeId`
 * already denotes exactly one employee in exactly one tenant). `getShiftsInRange` is not itself a
 * gate-relevant method (`findMany` is not in `RELEVANT_METHODS`, `lint-tenant-scoping-types.ts`),
 * so this is a read-shape decision, not a tenant-scoping-gate requirement.
 *
 * ── S2 flagShiftsConflictingWithLeave ──────────────────────────────────────────────────────────
 * `leave.ts:1424` (`findMany`) + `:1435` (`updateMany`) is ONE operation, not two independent
 * queries a caller has to keep in step — the ids the `updateMany` flags are exactly the rows the
 * `findMany` just read, so splitting them across the facade boundary would recreate the very
 * caller-side bookkeeping this phase removes elsewhere. Read-then-flag returns the flagged rows so
 * `leave.ts`'s own per-shift audit-log loop (unchanged, stays in `leave.ts` — auditing a
 * cross-context side effect is the CALLER's compliance duty, not this facade's) keeps working
 * unmodified.
 *
 * Tenant addition (same class of change as S3 below, not called out separately in the plan's own
 * text but required by the SAME reasoning): today's `:1424`/`:1435` queries filter only by
 * `employeeId`, with no `employee: { tenantId }` clause. `employeeId` here is `existing.employeeId`
 * — `existing` is the `LeaveRequest` fetched at `leave.ts:935` and tenant-verified via
 * `existing.employee.tenantId !== req.user.tenantId` (fetch-then-compare, `leave.ts:940`) BEFORE
 * this function is ever reached. Adding `employee: { tenantId }` to both the `findMany` and the
 * `updateMany` here is therefore a proven no-op — the identical reasoning `cancelOrphanShifts`
 * documents for `settings.ts:939` below — and it is what makes `updateMany` (a gate-RELEVANT
 * method) score `inline-relation-filter` instead of `UNSCOPED` once this call moves behind
 * `SCOPED_DIRS` (plan 05 Task 3's derivation requires exactly this, not a new exception entry).
 *
 * ── S3 cancelOrphanShifts ──────────────────────────────────────────────────────────────────────
 * `settings.ts:939`'s `tx.shift.deleteMany({ where: { id: { in: futureShiftIds } } })` had NO
 * tenant constraint at all. Adding `employee: { tenantId }` here is a behaviour change in the safe
 * direction (narrows what can be deleted, never widens it) — and it is a PROVEN no-op, not merely
 * a plausible one: `futureShiftIds` comes from `settings.ts:854`'s `getShiftsInRange` call, which
 * IS tenant-validated (the route's own top-of-handler `employee.tenantId !== req.user.tenantId`
 * check at `settings.ts:807-808` gates entry to this whole branch before `:854` ever runs) — so
 * every id in `shiftIds` already belongs to `tenantId` before this function is called; the added
 * clause can only ever match everything it already would have. `db` here is a `tx` — per D-07 this
 * function participates in the caller's transaction by construction, never reaching for a second
 * client.
 */
import type { Prisma } from "@clokr/db";
import { type EmployeeScope, employeeScopeWhere } from "../../platform";

/**
 * S1 — the one date-range read for `Shift`, covering all three `EmployeeScope` variants in ONE
 * query. `to === null` (the default) means "no upper bound" — `settings.ts:854`'s "all future
 * shifts from today onward" is the one of the 17 sites with an open-ended range; every other site
 * passes an explicit `to`.
 */
export async function getShiftsInRange(
  db: Prisma.TransactionClient,
  scope: EmployeeScope,
  from: Date,
  to: Date | null = null,
) {
  return db.shift.findMany({
    where: {
      ...employeeScopeWhere(scope),
      date: to ? { gte: from, lte: to } : { gte: from },
      deletedAt: null, // Phase 67.2 (D-08) — hide soft-deleted shifts from every caller
    },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
    select: {
      id: true,
      employeeId: true,
      date: true,
      startTime: true,
      endTime: true,
      label: true,
      template: { select: { name: true, color: true } },
    },
  });
}

/**
 * S2 — the leave-approval reverse-hook (Phase 43-04): flags every ACTIVE, not-yet-flagged shift of
 * `employeeId` inside `[from, to]` as `conflictsWithLeave: true`, and returns the rows it flagged
 * so the caller can audit each one (`leave.ts`'s own per-shift `SHIFT_MARKED_CONFLICTING` loop is
 * unchanged and stays in `leave.ts` — see module docblock).
 */
export async function flagShiftsConflictingWithLeave(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  from: Date,
  to: Date,
) {
  const conflictingShifts = await db.shift.findMany({
    where: {
      employeeId,
      employee: { tenantId },
      date: { gte: from, lte: to },
      conflictsWithLeave: false,
      deletedAt: null, // Phase 67.2 — the reverse-hook only flags ACTIVE shifts
    },
    select: { id: true, date: true, startTime: true, endTime: true, label: true },
  });

  if (conflictingShifts.length > 0) {
    await db.shift.updateMany({
      where: { id: { in: conflictingShifts.map((s) => s.id) }, employee: { tenantId } },
      data: { conflictsWithLeave: true },
    });
  }

  return conflictingShifts;
}

/**
 * S3 — hard-deletes exactly `shiftIds` (the orphan future shifts a schedule-type switch away from
 * SHIFT_BASED made obsolete), scoped to `tenantId` (see module docblock for why this is a proven
 * no-op against today's caller). `db` is expected to be the caller's own `tx` — this function never
 * opens its own transaction or reaches for a second Prisma client (D-07).
 */
export async function cancelOrphanShifts(
  db: Prisma.TransactionClient,
  tenantId: string,
  shiftIds: string[],
) {
  return db.shift.deleteMany({ where: { id: { in: shiftIds }, employee: { tenantId } } });
}
