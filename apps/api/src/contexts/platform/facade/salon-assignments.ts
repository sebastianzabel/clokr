/**
 * Phase 67b Plan 01 (issue #67) — Unterbau's `EmployeeSalonAssignment` read surface.
 *
 * ── Salon assignment rules (Phase 67b, Issue #67) ────────────────────────────────────────────
 * - Every employee has exactly one gapless, non-overlapping open HOME (Stammsalon) row for every
 *   day from the tenant-local `hireDate` on. A change ends the old row and creates a new one in
 *   ONE transaction — never a gap, never an overlap.
 * - Any number of DEPLOYMENT (Einsatzsalon) rows, each with its own validity period and optional
 *   weekdays (0 = Monday … 6 = Sunday).
 * - No delete function exists in this module or anywhere in the facade — rows are never deleted.
 *   The only permitted change to an existing row is setting `validUntil`.
 * - A row with `validUntil = validFrom − 1 day` is "voided" (D-03): effective on no day.
 * - `salonForDay`: the effective DEPLOYMENT whose weekdays contain the tenant-local weekday of the
 *   given day, first; else the effective HOME row; else `null`.
 * - Phase 67b Plan 05 (D-14): a salon that is, on the deactivation day, the current or future
 *   effective Stammsalon of at least one still-employed person cannot be deactivated
 *   ({@link homeSalonUsageFrom}) — exited employees never block.
 * - Phase 67b Plan 05 (D-15): deactivating a salon ends every running Einsatzsalon assignment to
 *   it at the deactivation date, voiding any that had not started yet
 *   ({@link endDeploymentsOnSalonDeactivation}).
 *
 * This module imports ONLY `@clokr/db` types, `../salon-assignment-rules` and the import-free
 * leaf `../employee-anonymization-filter` — never another context and never `./salons`. `contexts/platform/index.ts` re-exports this module's read
 * surface (D-16) and its own docblock forbids transitively reaching another context; a future
 * import of `contexts/working-time-account` here (e.g. for a lock check) would break that
 * invariant, which is exactly why Plan 02's lock-checked WRITE functions live in a separate module
 * the index does NOT re-export. `./salons` is avoided in the other direction: Plan 05 makes
 * `facade/salons.ts` import THIS module (to check whether a salon is anyone's Stammsalon before
 * deactivating it) — the reverse import here would create a cycle.
 *
 * Every export takes `db: Prisma.TransactionClient` first and a REQUIRED `tenantId` (F1/F3) —
 * `apps/api/scripts/lint-facade-signatures.ts` and `apps/api/scripts/lint-tenant-scoping.ts`
 * enforce this mechanically; this module is inside `SCOPED_DIRS` (`platform/facade/**`).
 */
import type { Prisma } from "@clokr/db";
import { NOT_ANONYMIZED_EMPLOYEE_WHERE } from "../employee-anonymization-filter";
import {
  addDays,
  dateToDay,
  dayToDate,
  isVoided,
  pickSalonForDay,
  tenantLocalDay,
  type AssignmentRow,
  type CalendarDay,
} from "../salon-assignment-rules";

const DEFAULT_TENANT_TIMEZONE = "Europe/Berlin";

/**
 * Reads the tenant's configured timezone, falling back to Europe/Berlin for a tenant without a
 * `TenantConfig` row. Same fallback `getTenantTimezone`
 * (`contexts/working-time-account/timezone.ts`) uses — that helper itself is not usable here
 * because its signature is `FastifyInstance["prisma"]`, not `Prisma.TransactionClient`-compatible;
 * precedent for a tx-compatible read with the identical fallback:
 * `apps/api/src/contexts/absence/shift-leave-recalc-resolver.ts:192-201`.
 */
export async function readTenantTimezone(
  db: Prisma.TransactionClient,
  tenantId: string,
): Promise<string> {
  const config = await db.tenantConfig.findUnique({
    where: { tenantId },
    select: { timezone: true },
  });
  return config?.timezone ?? DEFAULT_TENANT_TIMEZONE;
}

/** Tenant-scoped employee lookup — `null` for a foreign OR nonexistent id (T-100-09). */
export async function findEmployeeInTenant(
  db: Prisma.TransactionClient,
  tenantId: string,
  employeeId: string,
): Promise<{ id: string; hireDate: Date; exitDate: Date | null } | null> {
  return db.employee.findFirst({
    where: { id: employeeId, tenantId },
    select: { id: true, hireDate: true, exitDate: true },
  });
}

/**
 * Audit-only helper for this context's own route (`api/salon-assignments.ts`'s
 * `rejectUnknownEmployee`) — never loads the foreign row, its boolean answer never reaches the
 * client. Same shape as `salonExistsInForeignTenant` (`facade/salons.ts`).
 */
export async function employeeExistsInForeignTenant(
  db: Prisma.TransactionClient,
  tenantId: string,
  employeeId: string,
): Promise<boolean> {
  const count = await db.employee.count({ where: { id: employeeId, NOT: { tenantId } } });
  return count > 0;
}

/**
 * Phase 67b Plan 02 (issue #67, D-19) — audit-only helper for `api/salon-assignments.ts`'s
 * `rejectUnknownAssignment` (the `:assignmentId` path-parameter guard for `end`). Never loads the
 * foreign row, its boolean answer never reaches the client — same shape as
 * `employeeExistsInForeignTenant` above and `salonExistsInForeignTenant` (`facade/salons.ts`).
 */
export async function salonAssignmentExistsInForeignTenant(
  db: Prisma.TransactionClient,
  tenantId: string,
  assignmentId: string,
): Promise<boolean> {
  const count = await db.employeeSalonAssignment.count({
    where: { id: assignmentId, NOT: { tenantId } },
  });
  return count > 0;
}

/**
 * D-17: ALL of the employee's assignment rows, including ended and voided ones — "a beendete
 * Zuordnung bleibt abrufbar mit ursprünglichem gültig-ab" (AC). Ordered kind, then validFrom, then
 * id (HOME sorts before DEPLOYMENT alphabetically, matching D-17's "HOME first" requirement).
 */
export async function listSalonAssignments(
  db: Prisma.TransactionClient,
  tenantId: string,
  employeeId: string,
): Promise<AssignmentRow[]> {
  return db.employeeSalonAssignment.findMany({
    where: { tenantId, employeeId },
    orderBy: [{ kind: "asc" }, { validFrom: "asc" }, { id: "asc" }],
  });
}

/** The answer to "which salon does this employee probably work in on this day?" (D-16). */
export interface SalonForDay {
  salonId: string;
  kind: "HOME" | "DEPLOYMENT";
  assignmentId: string;
}

/**
 * D-16: `date` is an instant, converted to the tenant-local calendar day and weekday. Returns the
 * first effective DEPLOYMENT whose weekdays contain that weekday (unique by D-10), else the
 * effective HOME row, else `null` (no rows at all — e.g. a legacy fixture). Tenant required; a
 * foreign or nonexistent employeeId yields `null`.
 *
 * Review IN-02: a day before the employee's tenant-local `hireDate` always yields `null`, even when
 * a HOME row still covers it — D-07 deliberately leaves HOME rows before a hire date that moved
 * LATER in place ("harmless"), and this check is what keeps them harmless: D-16 specifies the
 * answer only from `hireDate` on.
 *
 * No `isActive` filter on the salon: the history of a since-deactivated salon stays answerable —
 * this function only asks "which salon was this employee assigned to", not "is that salon
 * currently operating".
 */
export async function salonForDay(
  db: Prisma.TransactionClient,
  tenantId: string,
  employeeId: string,
  date: Date,
): Promise<SalonForDay | null> {
  const tz = await readTenantTimezone(db, tenantId);
  const day = tenantLocalDay(date, tz);
  const dayAsDate = dayToDate(day);

  const employee = await db.employee.findFirst({
    where: { id: employeeId, tenantId },
    select: { hireDate: true },
  });
  if (!employee) return null;
  if (day < tenantLocalDay(employee.hireDate, tz)) return null;

  const rows = await db.employeeSalonAssignment.findMany({
    where: {
      tenantId,
      employeeId,
      validFrom: { lte: dayAsDate },
      OR: [{ validUntil: null }, { validUntil: { gte: dayAsDate } }],
    },
    orderBy: [{ validFrom: "asc" }, { id: "asc" }],
  });

  // Phase 71b (issue #71, D-04): the per-day pick itself is the ONE shared rule in
  // `salon-assignment-rules.ts` — this function's own contribution is only the tenant-timezone
  // day conversion and the hire-date/query steps above, never a re-implementation of the pick.
  return pickSalonForDay(rows, day);
}

/**
 * Phase 71b (issue #71, D-04): the BATCHED form of {@link salonForDay} — the central holiday
 * resolver's (`facade/holiday-resolution.ts`) no-entry fallback needs "which salon for employee E
 * on day D" for many employees and many days at once, and must never turn into an N+1 of
 * `salonForDay` calls (research Anti-Patterns; PERF-V1814-01 discipline). Built on the SAME pure
 * {@link pickSalonForDay} rule `salonForDay` uses — a parity test in `holiday-resolution.test.ts`
 * proves the two never disagree for any employee/day.
 *
 * Exactly ONE `db.employee.findMany` and ONE `db.employeeSalonAssignment.findMany`, regardless of
 * how many employees or days are asked for. `readTenantTimezone` runs once too. A day before an
 * employee's tenant-local `hireDate` maps to `null` — same rule as `salonForDay`. A foreign or
 * unknown `employeeId` is ABSENT from the returned map entirely (not present with an empty inner
 * map) — `salonsForDays` never claims to have an answer for someone it never queried employee data
 * for.
 *
 * An Einsatzsalon can differ by weekday (D-10) — never memoize one day's answer for another day;
 * each day is picked independently via {@link pickSalonForDay}.
 *
 * NOT re-exported from `contexts/platform/index.ts` (like `readTenantTimezone`) — this is a
 * building block of the holiday resolver, not a question another context asks directly.
 */
export async function salonsForDays(
  db: Prisma.TransactionClient,
  tenantId: string,
  employeeIds: readonly string[],
  fromDay: CalendarDay,
  toDay: CalendarDay,
): Promise<Map<string, Map<CalendarDay, string | null>>> {
  const result = new Map<string, Map<CalendarDay, string | null>>();
  if (employeeIds.length === 0 || fromDay > toDay) return result;

  const tz = await readTenantTimezone(db, tenantId);
  const idList = [...employeeIds];
  const fromDate = dayToDate(fromDay);
  const toDate = dayToDate(toDay);

  const employees = await db.employee.findMany({
    where: { tenantId, id: { in: idList } },
    select: { id: true, hireDate: true },
  });
  const employeeById = new Map(employees.map((employee) => [employee.id, employee]));

  const rows = await db.employeeSalonAssignment.findMany({
    where: {
      tenantId,
      employeeId: { in: idList },
      validFrom: { lte: toDate },
      OR: [{ validUntil: null }, { validUntil: { gte: fromDate } }],
    },
    orderBy: [{ validFrom: "asc" }, { id: "asc" }],
  });
  const rowsByEmployee = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = rowsByEmployee.get(row.employeeId);
    if (list) {
      list.push(row);
    } else {
      rowsByEmployee.set(row.employeeId, [row]);
    }
  }

  const days: CalendarDay[] = [];
  for (let day = fromDay; day <= toDay; day = addDays(day, 1)) days.push(day);

  for (const employeeId of idList) {
    const employee = employeeById.get(employeeId);
    if (!employee) continue; // foreign/unknown employeeId — absent from the result (T-100-09 safe)

    const hireDay = tenantLocalDay(employee.hireDate, tz);
    const employeeRows = rowsByEmployee.get(employeeId) ?? [];
    const dayMap = new Map<CalendarDay, string | null>();
    for (const day of days) {
      if (day < hireDay) {
        dayMap.set(day, null);
      } else {
        dayMap.set(day, pickSalonForDay(employeeRows, day)?.salonId ?? null);
      }
    }
    result.set(employeeId, dayMap);
  }

  return result;
}

/**
 * Phase 91b Plan 02 (issue #91, D-08) — the Stammsalon at an exact Stichtag, HOME-row only.
 *
 * This is deliberately NOT {@link salonForDay}: that function answers "which salon is this
 * employee probably WORKING at on this day" and therefore mixes in DEPLOYMENT weekday matching —
 * a DEPLOYMENT row effective on `date`, even one whose weekdays cover that day's weekday, is
 * IGNORED here. `homeSalonAt` answers a narrower question, "which salon is this employee's HOME
 * salon on this day", which `contexts/platform/scope-filter.ts` (Plan 91b-02 Tasks 2-3) needs as
 * its one shared primitive for every Stammsalon-dependent scope rule (D-09/D-10/D-12) — no
 * Stammsalon-at-a-date logic may be re-derived anywhere else (D-07).
 *
 * `date` is converted to the tenant-local calendar day exactly as {@link salonForDay} does. Unlike
 * `salonForDay`, this function applies NO hire-date floor (Open Question 1 / A1 in
 * 91b-RESEARCH.md): D-08's own text names no such floor, unlike `salonForDay`'s explicit IN-02
 * one — a HOME row that covers a day before the employee's `hireDate` still resolves here. This is
 * a deliberate, pinned decision (see 91b-02-SUMMARY.md), not an oversight; a HOME row realistically
 * never predates `hireDate` in practice ({@link fillHomeGapBeforeHireDate}'s own invariant), so the
 * omission is harmless in the data this system actually produces.
 *
 * No explicit `isVoided` post-filter is needed: a voided row's own `validFrom <= day <= validUntil`
 * window spans zero days by construction (`validUntil < validFrom`), so the `validFrom`/`validUntil`
 * predicate below already excludes it structurally — pinned by this module's own test, not merely
 * assumed by reasoning about it.
 *
 * Returns `null` when no HOME row covers `date` — the fail-closed input every scope-filter.ts
 * Stammsalon check treats as "not in scope for this branch" (D-08's own rule: no Stammsalon on the
 * Stichtag means out of scope). A foreign or nonexistent `employeeId` also yields `null` (T-100-09 —
 * this function never distinguishes the two cases).
 */
export async function homeSalonAt(
  db: Prisma.TransactionClient,
  tenantId: string,
  employeeId: string,
  date: Date,
): Promise<{ salonId: string; assignmentId: string } | null> {
  const tz = await readTenantTimezone(db, tenantId);
  const day = tenantLocalDay(date, tz);
  const dayAsDate = dayToDate(day);

  const home = await db.employeeSalonAssignment.findFirst({
    where: {
      tenantId,
      employeeId,
      kind: "HOME",
      validFrom: { lte: dayAsDate },
      OR: [{ validUntil: null }, { validUntil: { gte: dayAsDate } }],
    },
    orderBy: [{ validFrom: "asc" }, { id: "asc" }],
  });
  if (!home) return null;

  return { salonId: home.salonId, assignmentId: home.id };
}

// ── Phase 67b Plan 03 (issue #67) additions — the employee-lifecycle write helpers ───────────────
//
// These three functions keep the D-24 invariant ("exactly one HOME row per day from hireDate")
// true across `POST /employees` (D-22), `PATCH /employees/:id`'s hire-date gap-fill (D-07), and the
// CSV import (D-23). None of them needs `isSnapshotLocked` or a tenant-timezone helper from
// `working-time-account` — D-22/D-07 both explicitly carry NO lock check (a brand-new employee, or
// the days before an OLD hire date, can never have a closed-month time entry) — so, unlike
// `facade/salon-assignment-changes.ts`, they live in THIS read-oriented module without breaking its
// "no other context" invariant.

/** The outcome of resolving a NEW employee's Stammsalon (D-22). */
export type ResolveHomeSalonOutcome =
  | { status: "OK"; salonId: string }
  | { status: "SALON_NOT_FOUND" }
  | { status: "SALON_INACTIVE" }
  | { status: "HOME_SALON_REQUIRED" }
  | { status: "NO_ACTIVE_SALON" };

/**
 * D-22/D-02: resolves which salon a NEW employee's HOME row should point at. MUST be the FIRST
 * statement inside the employee-creating transaction (`db` is that transaction's client) — every
 * `FOR SHARE` lock below is released at the end of it, and a non-OK outcome must leave nothing
 * written, which only holds if every check upstream of the first write ran inside the same tx.
 *
 * An explicit `requestedSalonId` (an omitted key and an explicit `null` are treated identically,
 * D-22 — frontends send explicit null) is looked up and lock-checked directly: absent/inactive rows
 * return `SALON_NOT_FOUND`/`SALON_INACTIVE` — a foreign tenant's real salon and a nonexistent one
 * are indistinguishable at this layer (T-100-09); the ROUTE decides whether to additionally audit a
 * `CROSS_TENANT_ACCESS_DENIED` row for the foreign case. Omitted/null resolves against the tenant's
 * ACTIVE salons ordered `createdAt, id` (the 64b default-salon order): zero -> `NO_ACTIVE_SALON`,
 * more than one -> `HOME_SALON_REQUIRED`, exactly one -> `OK`. The `FOR SHARE` lock on every
 * candidate row serialises this resolution against a concurrent `deactivateSalon()`'s `FOR UPDATE`
 * over the same tenant's salons (D-02) — the two can never both believe they observed a stable
 * salon state. The rows are LOCKED in `id` order (the global salon lock order, review WR-01) and
 * only then sorted into the default-salon order in memory.
 */
export async function resolveHomeSalonForNewEmployee(
  db: Prisma.TransactionClient,
  tenantId: string,
  requestedSalonId: string | null | undefined,
): Promise<ResolveHomeSalonOutcome> {
  if (requestedSalonId) {
    const rows = await db.$queryRaw<{ id: string; isActive: boolean }[]>`
      SELECT "id", "isActive" FROM "Salon" WHERE "id" = ${requestedSalonId} AND "tenantId" = ${tenantId} FOR SHARE
    `;
    const salon = rows[0];
    if (!salon) return { status: "SALON_NOT_FOUND" };
    if (!salon.isActive) return { status: "SALON_INACTIVE" };
    return { status: "OK", salonId: salon.id };
  }

  // Review WR-01: rows are locked in the ONE global salon lock order, `ORDER BY "id"` — the order
  // `deactivateSalon`/`activateSalon` take their `FOR UPDATE` in. Postgres locks rows in ORDER BY
  // order, so locking here in `createdAt` order would deadlock against a concurrent deactivation
  // whenever the two orders differ (random UUIDs: about half the time with two salons). The
  // default-salon order (`createdAt, id`, 64b) is applied afterwards, in memory.
  const locked = await db.$queryRaw<{ id: string; createdAt: Date }[]>`
    SELECT "id", "createdAt" FROM "Salon" WHERE "tenantId" = ${tenantId} AND "isActive" = true
    ORDER BY "id" FOR SHARE
  `;
  const activeSalons = [...locked].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  if (activeSalons.length === 0) return { status: "NO_ACTIVE_SALON" };
  if (activeSalons.length > 1) return { status: "HOME_SALON_REQUIRED" };
  return { status: "OK", salonId: activeSalons[0].id };
}

/**
 * D-22: creates the open HOME row `[validFrom, null)`, `weekdays: []`, for a NEW employee. Only
 * valid for an employee created in the SAME transaction right after
 * {@link resolveHomeSalonForNewEmployee} locked the salon — a brand-new employee has no other
 * assignment rows (no overlap possible) and no time entries yet (no closed month, so no lock
 * check, D-12).
 */
export async function createInitialHomeAssignment(
  db: Prisma.TransactionClient,
  tenantId: string,
  employeeId: string,
  salonId: string,
  validFrom: CalendarDay,
): Promise<AssignmentRow> {
  return db.employeeSalonAssignment.create({
    data: {
      tenantId,
      employeeId,
      salonId,
      kind: "HOME",
      validFrom: dayToDate(validFrom),
      validUntil: null,
      weekdays: [],
    },
  });
}

/** The outcome of {@link fillHomeGapBeforeHireDate} (D-07). */
export type FillHomeGapOutcome =
  | { status: "NO_HOME_ROWS" }
  | { status: "NOT_NEEDED" }
  | { status: "FILLED"; created: AssignmentRow };

/**
 * D-07: when an employee's `hireDate` moves EARLIER than its earliest effective HOME row's
 * `validFrom`, fills the new gap with a HOME row `[newHireDay, earliest.validFrom - 1]` to the
 * EARLIEST row's OWN salon — extending that row's salon backwards, never choosing a different one
 * (D-13 exemption: no `isActive` check on that salon here). No lock check (D-12): the days this
 * fills lie strictly BEFORE the OLD hire date, which by construction can carry no time entry, so no
 * closed month can be affected. An employee with no (non-voided) HOME rows at all — a legacy
 * fixture predating this phase — returns `NO_HOME_ROWS` and writes nothing; a `newHireDay` that is
 * not earlier than the earliest row returns `NOT_NEEDED`.
 *
 * MUST be called inside the SAME transaction as the employee's `hireDate` update (research
 * Pitfall 2) — the employee row lock below is released at the end of that transaction, so calling
 * this with a bare `PrismaClient` gives no protection against a concurrent HOME-row write.
 */
export async function fillHomeGapBeforeHireDate(
  db: Prisma.TransactionClient,
  tenantId: string,
  employeeId: string,
  newHireDay: CalendarDay,
): Promise<FillHomeGapOutcome> {
  await db.$queryRaw`
    SELECT "id" FROM "Employee" WHERE "id" = ${employeeId} AND "tenantId" = ${tenantId} FOR UPDATE
  `;

  const rows = await db.employeeSalonAssignment.findMany({
    where: { tenantId, employeeId, kind: "HOME" },
  });
  const effectiveRows = rows.filter((row) => !isVoided(row));
  if (effectiveRows.length === 0) return { status: "NO_HOME_ROWS" };

  const earliest = effectiveRows.reduce((a, b) =>
    a.validFrom.getTime() <= b.validFrom.getTime() ? a : b,
  );
  const earliestDay = dateToDay(earliest.validFrom);
  if (newHireDay >= earliestDay) return { status: "NOT_NEEDED" };

  const created = await db.employeeSalonAssignment.create({
    data: {
      tenantId,
      employeeId,
      salonId: earliest.salonId,
      kind: "HOME",
      validFrom: dayToDate(newHireDay),
      validUntil: dayToDate(addDays(earliestDay, -1)),
      weekdays: [],
    },
  });
  return { status: "FILLED", created };
}

// ── Phase 67b Plan 05 (issue #67) additions — deactivateSalon's D-14/D-15 extension point ────────
//
// These two functions are called ONLY from `facade/salons.ts`'s `deactivateSalon()`, inside the
// same transaction as its `FOR UPDATE` lock over the tenant's Salon rows — that lock, taken by the
// CALLER before either of these runs, is what makes the "count employees as of D" read and the
// "end deployments as of D" write observe a stable salon set. Neither function takes its own new
// lock: `homeSalonUsageFrom` only reads, and `endDeploymentsOnSalonDeactivation` only ever narrows
// an existing row's `validUntil` (D-03/D-11's "only ever shortens" shape). The employee-facing
// write functions in `facade/salon-assignment-changes.ts` serialise against it by taking the SAME
// salon `FOR SHARE` (D-02) and reading every row they judge only AFTER that lock:
// `createDeploymentAssignment` and `changeHomeSalon` read the employee's rows after it, and
// `endSalonAssignment` reads only the row's `salonId` before it and re-reads the full row after it
// (review CR-01) — so none of them can act on a row version older than a committed deactivation.

/** The result of {@link homeSalonUsageFrom}: how many still-employed people have this salon as
 * their current or future Stammsalon, as of `deactivationDay`. */
export interface HomeSalonUsage {
  deactivationDay: CalendarDay;
  employeeCount: number;
}

/**
 * D-14: computes today's tenant-local calendar day ONCE (`deactivationDay`, D) and counts the
 * DISTINCT employees who (a) have an effective HOME row to `salonId` on some day `>= D` and (b)
 * are still employed at D (`exitDate` null or tenant-local `exitDate >= D`). A voided HOME row
 * (D-03) never counts — it is dropped in code via {@link isVoided} rather than the SQL `WHERE`,
 * because "voided" is a relationship between a row's OWN `validFrom`/`validUntil`, not something
 * the `validUntil >= D` filter alone can express (a far-future, already-voided row could still
 * satisfy that filter). Exited employees never block a deactivation — the issue's own decision,
 * restated in D-14 — regardless of how far in the future their Stammsalon runs.
 *
 * Review WR-02: a DSGVO-anonymized employee has left by definition and never blocks either, even
 * with `exitDate` null — `DELETE /employees/:id` neither sets nor requires one, D-25 migrates
 * anonymized employees too, and the count-only 409 plus the anonymized rows being hidden from the
 * employee list would leave an admin with no way to find or resolve the blocker. Excluded in SQL
 * via the shared sentinel {@link NOT_ANONYMIZED_EMPLOYEE_WHERE}.
 */
export async function homeSalonUsageFrom(
  db: Prisma.TransactionClient,
  tenantId: string,
  salonId: string,
): Promise<HomeSalonUsage> {
  const tz = await readTenantTimezone(db, tenantId);
  const deactivationDay = tenantLocalDay(new Date(), tz);
  const deactivationDate = dayToDate(deactivationDay);

  const rows = await db.employeeSalonAssignment.findMany({
    where: {
      tenantId,
      salonId,
      kind: "HOME",
      OR: [{ validUntil: null }, { validUntil: { gte: deactivationDate } }],
      employee: NOT_ANONYMIZED_EMPLOYEE_WHERE,
    },
    select: {
      employeeId: true,
      validFrom: true,
      validUntil: true,
      employee: { select: { exitDate: true } },
    },
  });

  const blockingEmployeeIds = new Set<string>();
  for (const row of rows) {
    if (isVoided(row)) continue;
    if (row.employee.exitDate !== null) {
      const exitDay = tenantLocalDay(row.employee.exitDate, tz);
      if (exitDay < deactivationDay) continue;
    }
    blockingEmployeeIds.add(row.employeeId);
  }

  return { deactivationDay, employeeCount: blockingEmployeeIds.size };
}

/** One `EmployeeSalonAssignment` row {@link endDeploymentsOnSalonDeactivation} changed — the shape
 * `api/salons.ts` needs to write its END audit row (old/new value). */
export interface EndedDeploymentAssignment {
  before: AssignmentRow;
  after: AssignmentRow;
}

/**
 * D-15: ends or voids every DEPLOYMENT row of `salonId` that is effective on some day
 * `>= deactivationDay` (D) — a row already ending at or before D is left untouched (no write, no
 * entry in the returned array, so `api/salons.ts` never audits a no-op). A voided row (D-03) is
 * always skipped too, via {@link isVoided}, for the same "already-voided rows never re-match"
 * reason {@link homeSalonUsageFrom} documents.
 *
 * For a row that had already started (`validFrom <= D`): `validUntil = D` — it ran up to and
 * including the deactivation day, matching the issue's literal wording "enden am
 * Deaktivierungsdatum". For a row that had not started yet (`validFrom > D`): `validUntil =
 * validFrom - 1` — voided (D-03), because a future Einsatzsalon assignment to a salon that will
 * never open again has no day left to be effective on. Every other field of the row (`weekdays`,
 * `salonId`, …) is left exactly as it was — the only field this ever changes is `validUntil`.
 *
 * No lock check (D-12): the days this can possibly change all lie `>= today` by construction (D is
 * `tenantLocalDay(new Date(), tz)`), and a day that has not happened yet can never lie inside an
 * already-closed month. MUST be called only from inside `deactivateSalon`'s transaction, after its
 * `FOR UPDATE` lock over the tenant's Salon rows has already been taken — this function takes no
 * lock of its own.
 */
export async function endDeploymentsOnSalonDeactivation(
  db: Prisma.TransactionClient,
  tenantId: string,
  salonId: string,
  deactivationDay: CalendarDay,
): Promise<EndedDeploymentAssignment[]> {
  const deactivationDate = dayToDate(deactivationDay);

  const rows = await db.employeeSalonAssignment.findMany({
    where: {
      tenantId,
      salonId,
      kind: "DEPLOYMENT",
      OR: [{ validUntil: null }, { validUntil: { gt: deactivationDate } }],
    },
  });

  const ended: EndedDeploymentAssignment[] = [];
  for (const row of rows) {
    if (isVoided(row)) continue;

    const validFromDay = dateToDay(row.validFrom);
    const newValidUntilDay =
      validFromDay <= deactivationDay ? deactivationDay : addDays(validFromDay, -1);

    const after = await db.employeeSalonAssignment.update({
      where: { id: row.id, tenantId },
      data: { validUntil: dayToDate(newValidUntilDay) },
    });
    ended.push({ before: row, after });
  }

  return ended;
}
