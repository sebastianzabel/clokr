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
 * This module imports ONLY `@clokr/db` types and `./` sibling `../salon-assignment-rules` — never
 * another context and never `./salons`. `contexts/platform/index.ts` re-exports this module's read
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
import {
  addDays,
  dateToDay,
  dayToDate,
  isVoided,
  mondayBasedWeekday,
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
 * effective HOME row, else `null` (before hireDate / no rows at all — e.g. a legacy fixture).
 * Tenant required; a foreign employeeId yields `null` (no rows can match a tenantId it doesn't
 * belong to).
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
  const weekday = mondayBasedWeekday(date, tz);
  const dayAsDate = dayToDate(day);

  const rows = await db.employeeSalonAssignment.findMany({
    where: {
      tenantId,
      employeeId,
      validFrom: { lte: dayAsDate },
      OR: [{ validUntil: null }, { validUntil: { gte: dayAsDate } }],
    },
    orderBy: [{ validFrom: "asc" }, { id: "asc" }],
  });

  const deployment = rows.find(
    (row) => row.kind === "DEPLOYMENT" && row.weekdays.includes(weekday),
  );
  if (deployment) {
    return { salonId: deployment.salonId, kind: "DEPLOYMENT", assignmentId: deployment.id };
  }

  const home = rows.find((row) => row.kind === "HOME");
  if (home) {
    return { salonId: home.salonId, kind: "HOME", assignmentId: home.id };
  }

  return null;
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
 * salon state.
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

  const activeSalons = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Salon" WHERE "tenantId" = ${tenantId} AND "isActive" = true
    ORDER BY "createdAt", "id" FOR SHARE
  `;
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
// an existing row's `validUntil` (D-03/D-11's "only ever shortens" shape), which cannot conflict
// with anything the employee-facing write functions in `facade/salon-assignment-changes.ts` do
// (those always lock the SAME salon `FOR SHARE` first, D-02).

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
