/**
 * Phase 91b (Issue #91), D-07 — the ONE module every context calls to answer "is this resource in
 * scope for the caller's resolved AccessReach" (a single boolean check) and "which rows/employees
 * are in scope for a list query" (a list-mode resolver). One function pair per resource-table row
 * from the issue's own table — no context (`time-tracking`, `absence`, `working-time-account`,
 * `scheduling`, `composition`) re-implements any of these rules inline; each calls the matching
 * exported function here instead. This mirrors the existing precedent
 * `resolveContractWorkDaysPerWeek()`/`employeeScopeWhere()` set (CLAUDE.md: "no other reader may
 * rebuild this chain inline").
 *
 * Every function takes a resolved {@link AccessReach} (`resolveAccessReach`,
 * `facade/role-assignments.ts`, Plan 91b-01) — never re-resolves it itself — plus the resource's own
 * date/salon/employee facts. `homeSalonAt` (`facade/salon-assignments.ts`, Plan 91b-02 Task 1) is
 * the ONE shared Stammsalon-at-a-Stichtag primitive every Stammsalon-dependent function below calls;
 * no function here re-derives HOME-row logic.
 *
 * Every list-mode resolver returns the sentinel `"all"` for a `wholeTenant` reach (apply no further
 * employeeId/id filter) or a concrete, possibly-empty array for a `scoped` reach. A `scoped` reach
 * with BOTH `salonIds` and `employeeIds` empty short-circuits to `[]` (or `false` for a single-row
 * check) with NO database read at all — D-03's "both empty means no reach at all", fail-closed.
 *
 * ── Index of the eight functions, one per resource-table row ────────────────────────────────────
 * - TimeEntry (D-09):                    {@link isTimeEntryInScope}, {@link scopedTimeEntryIds}
 * - leave/absence/saldo/exports (D-10):  {@link isStammsalonScopeMatch}, {@link resolveStammsalonScopedEmployeeIds}
 * - shifts (D-11):                       {@link isShiftInScope}, {@link shiftScopeWhere}
 * - person master data (D-12):           {@link isPersonMasterDataInScope}, {@link resolvePersonScopedEmployeeIds}
 */
import { Prisma } from "@clokr/db";
import type { AccessReach } from "./access-context";
import { homeSalonAt, readTenantTimezone } from "./facade/salon-assignments";
import { dayToDate, tenantLocalDay } from "./salon-assignment-rules";

// ── TimeEntry (D-09): the entry's own salon OR its Stammsalon at the entry's own date ───────────

/** The facts about one `TimeEntry` row {@link isTimeEntryInScope} needs — read from the row itself,
 * never from client input directly. */
export interface TimeEntryScopeFacts {
  readonly salonId: string;
  readonly employeeId: string;
  readonly date: Date;
}

/**
 * D-09: a `TimeEntry` is in scope under a `scoped` reach iff its own `salonId` is in
 * `reach.salonIds`, OR its `employeeId` is in `reach.employeeIds` (PERSONS — salon-independent),
 * OR its Stammsalon AT THE ENTRY'S OWN `date` ({@link homeSalonAt}) is in `reach.salonIds`. A
 * `wholeTenant` reach is always in scope, with no database read.
 *
 * `TimeEntry.salonId` is `NOT NULL` since #68b (CLAUDE.md § Time Entry Rules), so "no salon on the
 * entry" is never a real fail-closed case here — the fail-closed case is `homeSalonAt(...)`
 * returning `null` (no HOME row covers that date), which correctly resolves this branch to `false`.
 */
export async function isTimeEntryInScope(
  db: Prisma.TransactionClient,
  tenantId: string,
  reach: AccessReach,
  entry: TimeEntryScopeFacts,
): Promise<boolean> {
  if (reach.kind === "wholeTenant") return true;
  if (reach.salonIds.includes(entry.salonId)) return true;
  if (reach.employeeIds.includes(entry.employeeId)) return true;
  if (reach.salonIds.length === 0) return false;

  const home = await homeSalonAt(db, tenantId, entry.employeeId, entry.date);
  return home !== null && reach.salonIds.includes(home.salonId);
}

/**
 * D-09, list mode: the ids of every `TimeEntry` in `[dateFrom, dateTo]` (inclusive, `date` column)
 * that is in scope, `deletedAt: null` always applied. `wholeTenant` -> the sentinel `"all"` (apply
 * no further id filter). A `scoped` reach with both `salonIds` and `employeeIds` empty -> `[]` with
 * NO database query at all — an empty reach must never even attempt the query below.
 *
 * A plain Prisma `where` fragment cannot express the Stammsalon-OR-branch: it would need to compare
 * `TimeEntry.date` (the OUTER row's own column) against `EmployeeSalonAssignment.validFrom`/
 * `validUntil` (a SIBLING table's row) — Prisma has no mechanism for a relational filter to
 * reference a sibling field of the row being filtered (91b-RESEARCH.md Pitfall 2). This is
 * therefore answered by ONE parameterized raw SQL query, never a per-row loop that materializes
 * out-of-scope rows first.
 *
 * Every branch built from a possibly-empty id array is guarded with an explicit
 * `Prisma.sql\`FALSE\`` fallback when that array is empty. This is load-bearing for a REASON
 * measured empirically for this exact Prisma version (`@prisma/client` 7.6.0-line,
 * `@prisma/client-runtime-utils`): `Prisma.join([])` on an empty array throws a synchronous
 * `TypeError` ("Expected `join([])` to be called with an array of multiple elements, but got an
 * empty array") from `Prisma.join` itself — BEFORE any SQL is ever sent to Postgres. This differs
 * from 91b-CONTEXT.md's own text, which describes the failure as an invalid `IN ()` Postgres syntax
 * error; on the Prisma version actually running in this repo, the guard's own runtime validates the
 * array length first and never lets the malformed SQL reach the database at all. Either way the
 * outcome this guard protects is identical (a loud throw on every single-array-empty combination,
 * never a silent wrong answer) — see M3 in 91b-02-SUMMARY.md for the measured, verbatim proof.
 */
export async function scopedTimeEntryIds(
  db: Prisma.TransactionClient,
  tenantId: string,
  reach: AccessReach,
  dateFrom: Date,
  dateTo: Date,
): Promise<"all" | string[]> {
  if (reach.kind === "wholeTenant") return "all";
  if (reach.salonIds.length === 0 && reach.employeeIds.length === 0) return [];

  const salonBranch =
    reach.salonIds.length > 0
      ? Prisma.sql`te."salonId" IN (${Prisma.join([...reach.salonIds])})`
      : Prisma.sql`FALSE`;
  const employeeBranch =
    reach.employeeIds.length > 0
      ? Prisma.sql`te."employeeId" IN (${Prisma.join([...reach.employeeIds])})`
      : Prisma.sql`FALSE`;
  const homeSalonBranch =
    reach.salonIds.length > 0
      ? Prisma.sql`EXISTS (
          SELECT 1 FROM "EmployeeSalonAssignment" esa
          WHERE esa."employeeId" = te."employeeId"
            AND esa."kind" = 'HOME'
            AND esa."validFrom" <= te."date"
            AND (esa."validUntil" IS NULL OR esa."validUntil" >= te."date")
            AND esa."salonId" IN (${Prisma.join([...reach.salonIds])})
        )`
      : Prisma.sql`FALSE`;

  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT te."id" FROM "TimeEntry" te
    INNER JOIN "Employee" e ON e."id" = te."employeeId"
    WHERE e."tenantId" = ${tenantId}
      AND te."deletedAt" IS NULL
      AND te."date" >= ${dateFrom}
      AND te."date" <= ${dateTo}
      AND (${salonBranch} OR ${employeeBranch} OR ${homeSalonBranch})
  `);
  return rows.map((r) => r.id);
}

// ── Stammsalon-only (D-10): leave/absence/saldo/exports — NO entry-salon fallback ───────────────

/**
 * D-10, list mode: every employee whose Stammsalon AT `stichtag` ({@link homeSalonAt}'s underlying
 * HOME-row query, run in bulk here rather than per-employee) is in `reach.salonIds`, UNIONED with
 * `reach.employeeIds`, deduplicated. `wholeTenant` -> `"all"`. Both arrays empty -> `[]`, no query —
 * unlike TimeEntry's per-row Stichtag, this resource type's Stichtag is a single request-level date,
 * so a plain Prisma `where` suffices (no raw SQL needed, 91b-RESEARCH.md's own Summary).
 */
export async function resolveStammsalonScopedEmployeeIds(
  db: Prisma.TransactionClient,
  tenantId: string,
  reach: AccessReach,
  stichtag: Date,
): Promise<"all" | string[]> {
  if (reach.kind === "wholeTenant") return "all";
  if (reach.salonIds.length === 0 && reach.employeeIds.length === 0) return [];

  let homeIds: string[] = [];
  if (reach.salonIds.length > 0) {
    const rows = await db.employeeSalonAssignment.findMany({
      where: {
        tenantId,
        kind: "HOME",
        salonId: { in: [...reach.salonIds] },
        validFrom: { lte: stichtag },
        OR: [{ validUntil: null }, { validUntil: { gte: stichtag } }],
      },
      select: { employeeId: true },
    });
    homeIds = rows.map((r) => r.employeeId);
  }

  return Array.from(new Set([...homeIds, ...reach.employeeIds]));
}

/**
 * D-10, single-row mode: `wholeTenant` -> `true`. `employeeId` in `reach.employeeIds` -> `true`,
 * with no database read. Otherwise, only when `reach.salonIds` is non-empty, the employee's
 * Stammsalon AT `stichtag` ({@link homeSalonAt}) is checked against `reach.salonIds`. `stichtag`
 * genuinely matters here — the same reach can answer differently for two different Stichtag values
 * around a Stammsalon change, proven by this module's own test.
 */
export async function isStammsalonScopeMatch(
  db: Prisma.TransactionClient,
  tenantId: string,
  reach: AccessReach,
  employeeId: string,
  stichtag: Date,
): Promise<boolean> {
  if (reach.kind === "wholeTenant") return true;
  if (reach.employeeIds.includes(employeeId)) return true;
  if (reach.salonIds.length === 0) return false;

  const home = await homeSalonAt(db, tenantId, employeeId, stichtag);
  return home !== null && reach.salonIds.includes(home.salonId);
}

// ── Shifts (D-11): the shift's OWN salon only — NO Stammsalon fallback ──────────────────────────

/** The facts about one `Shift` row {@link isShiftInScope} needs. `employeeId` is `string | null` —
 * the current schema's `Shift.employeeId` column is NOT NULL (no "unassigned shift" concept exists
 * today), but this fact-shape and predicate keep the null case for D-11's own explicit "an
 * unassigned/open shift has no employee-scope path" wording and for forward compatibility; the null
 * case is exercised here with a directly-constructed fact object, never a real `Shift` row. */
export interface ShiftScopeFacts {
  readonly salonId: string;
  readonly employeeId: string | null;
}

/**
 * D-11: pure, no `db`/`tenantId` parameter — nothing to query. `wholeTenant` -> `true`.
 * `shift.salonId` in `reach.salonIds` -> `true`. `shift.employeeId` non-null and in
 * `reach.employeeIds` -> `true`. Otherwise `false` — deliberately NO Stammsalon fallback, unlike
 * TimeEntry (D-09): an unassigned shift in an out-of-scope salon is never in scope via any
 * employee-based path.
 */
export function isShiftInScope(reach: AccessReach, shift: ShiftScopeFacts): boolean {
  if (reach.kind === "wholeTenant") return true;
  if (reach.salonIds.includes(shift.salonId)) return true;
  if (shift.employeeId !== null && reach.employeeIds.includes(shift.employeeId)) return true;
  return false;
}

/**
 * D-11, list mode: pure `where`-fragment builder. `wholeTenant` -> `{}` (no added filter — spread
 * onto a base `where`, it narrows nothing). `scoped` -> `{ OR: [salonId in salonIds, employeeId in
 * employeeIds] }`. Both arrays empty still yields zero matches when spread into a real
 * `shift.findMany` call — Prisma's own query builder turns an empty `in` array into a no-match
 * condition, so (unlike {@link scopedTimeEntryIds}'s raw-SQL branches) no manual `FALSE` guard is
 * needed here; confirmed by this module's own integration test against a real query, not merely
 * asserted about the returned object's shape.
 */
export function shiftScopeWhere(reach: AccessReach): Prisma.ShiftWhereInput {
  if (reach.kind === "wholeTenant") return {};
  return {
    OR: [{ salonId: { in: [...reach.salonIds] } }, { employeeId: { in: [...reach.employeeIds] } }],
  };
}

// ── Person master data (D-12): Stammsalon-TODAY OR active-DEPLOYMENT-TODAY ──────────────────────

/**
 * D-12, list mode: `wholeTenant` -> `"all"`. Both arrays empty -> `[]`, no query. Otherwise the
 * union of (employees whose Stammsalon TODAY is in `reach.salonIds`), (employees with a currently
 * valid DEPLOYMENT row TODAY whose `salonId` is in `reach.salonIds` — validity-WINDOW check only, no
 * weekday filter: D-12's own text says "currently valid DEPLOYMENT row", not "scheduled to work
 * there today"; 91b-RESEARCH.md leaves the interpretation to the planner, and this is the pinned,
 * documented choice, not an open question left for a later reader), and `reach.employeeIds`,
 * deduplicated. "Today" is computed ONCE, tenant-local, via {@link readTenantTimezone} +
 * `tenantLocalDay` + `dayToDate` — the same pattern {@link homeSalonUsageFrom} already uses for its
 * own "today".
 */
export async function resolvePersonScopedEmployeeIds(
  db: Prisma.TransactionClient,
  tenantId: string,
  reach: AccessReach,
): Promise<"all" | string[]> {
  if (reach.kind === "wholeTenant") return "all";
  if (reach.salonIds.length === 0 && reach.employeeIds.length === 0) return [];

  let homeIds: string[] = [];
  let deploymentIds: string[] = [];
  if (reach.salonIds.length > 0) {
    const tz = await readTenantTimezone(db, tenantId);
    const todayDate = dayToDate(tenantLocalDay(new Date(), tz));
    const salonIdsIn = [...reach.salonIds];

    const [homeRows, deploymentRows] = await Promise.all([
      db.employeeSalonAssignment.findMany({
        where: {
          tenantId,
          kind: "HOME",
          salonId: { in: salonIdsIn },
          validFrom: { lte: todayDate },
          OR: [{ validUntil: null }, { validUntil: { gte: todayDate } }],
        },
        select: { employeeId: true },
      }),
      db.employeeSalonAssignment.findMany({
        where: {
          tenantId,
          kind: "DEPLOYMENT",
          salonId: { in: salonIdsIn },
          validFrom: { lte: todayDate },
          OR: [{ validUntil: null }, { validUntil: { gte: todayDate } }],
        },
        select: { employeeId: true },
      }),
    ]);
    homeIds = homeRows.map((r) => r.employeeId);
    deploymentIds = deploymentRows.map((r) => r.employeeId);
  }

  return Array.from(new Set([...homeIds, ...deploymentIds, ...reach.employeeIds]));
}

/**
 * D-12, single-row mode: `wholeTenant` -> `true`. `employeeId` in `reach.employeeIds` -> `true`,
 * with no database read. Otherwise Stammsalon-TODAY ({@link homeSalonAt}) OR an active-DEPLOYMENT-
 * TODAY row in `reach.salonIds` -> `true`; neither -> `false`.
 */
export async function isPersonMasterDataInScope(
  db: Prisma.TransactionClient,
  tenantId: string,
  reach: AccessReach,
  employeeId: string,
): Promise<boolean> {
  if (reach.kind === "wholeTenant") return true;
  if (reach.employeeIds.includes(employeeId)) return true;
  if (reach.salonIds.length === 0) return false;

  const home = await homeSalonAt(db, tenantId, employeeId, new Date());
  if (home !== null && reach.salonIds.includes(home.salonId)) return true;

  const tz = await readTenantTimezone(db, tenantId);
  const todayDate = dayToDate(tenantLocalDay(new Date(), tz));
  const deployment = await db.employeeSalonAssignment.findFirst({
    where: {
      tenantId,
      employeeId,
      kind: "DEPLOYMENT",
      salonId: { in: [...reach.salonIds] },
      validFrom: { lte: todayDate },
      OR: [{ validUntil: null }, { validUntil: { gte: todayDate } }],
    },
  });
  return deployment !== null;
}
