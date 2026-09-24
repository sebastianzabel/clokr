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
  dayToDate,
  mondayBasedWeekday,
  tenantLocalDay,
  type AssignmentRow,
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
