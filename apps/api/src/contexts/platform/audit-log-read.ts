import { z } from "zod";
import { fromZonedTime } from "date-fns-tz";
import type { Prisma } from "@clokr/db";
import type { FastifyInstance } from "fastify";

/**
 * Issue #583 (Phase 854, D-854-11, D-854-19) - the NON-tenant half of an AuditLog read.
 *
 * The list (`GET /audit-logs`) and the CSV export (`GET /audit-logs/export`) parse the same filters
 * and build the same filter clause here, so the file always holds exactly the rows the list shows.
 * The TENANT scope is deliberately NOT built here: the tenant-scoping gate does not follow helpers,
 * so the two-branch `OR` stays spelled inline in `api/audit-logs.ts` as its own AND member, and
 * this module only produces the second member. No filter in here can widen the first.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar day `YYYY-MM-DD` that exists (rejects 2026-02-31). */
const dayString = z
  .string()
  .regex(DAY, "Datum im Format JJJJ-MM-TT erwartet")
  .refine((value) => {
    const [y, m, d] = value.split("-").map(Number);
    const probe = new Date(Date.UTC(y, m - 1, d));
    return (
      probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
    );
  }, "Ungültiges Datum");

const filterShape = {
  page: z.string().regex(/^\d+$/).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  action: z.string().min(1).max(64).optional(),
  entity: z.string().min(1).max(64).optional(),
  userId: z.string().uuid().optional(),
  employeeId: z.string().uuid().optional(),
};

function toNotBeforeFrom(value: { from?: string; to?: string }): boolean {
  return !value.from || !value.to || value.to >= value.from;
}

const TO_BEFORE_FROM = { message: "Das Enddatum liegt vor dem Startdatum", path: ["to"] };

/** The list's query: every filter optional. */
export const auditFilterQuerySchema = z
  .object({ ...filterShape, from: dayString.optional(), to: dayString.optional() })
  .refine(toNotBeforeFrom, TO_BEFORE_FROM);

/** The export's query: the period is mandatory (a file needs a bounded set). */
export const auditExportQuerySchema = z
  .object({
    ...filterShape,
    from: dayString,
    to: dayString,
  })
  .refine(toNotBeforeFrom, TO_BEFORE_FROM);

export type AuditFilters = z.infer<typeof auditFilterQuerySchema>;

function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Number of calendar days from `from` to `to`, both inclusive. */
export function inclusiveDayCount(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
}

export type PeriodBounds = { gte?: Date; lt?: Date };

/**
 * Half-open instants of the tenant-local calendar days `from`..`to` (inclusive): the start of
 * `from` up to, excluding, the start of the day after `to`. `createdAt` is a timestamptz, so the
 * bounds are instants; the zone conversion handles DST days of 23 or 25 hours.
 */
export function periodBounds(from: string | undefined, to: string | undefined, tz: string) {
  const bounds: PeriodBounds = {};
  if (from) bounds.gte = fromZonedTime(`${from}T00:00:00`, tz);
  if (to) bounds.lt = fromZonedTime(`${addDays(to, 1)}T00:00:00`, tz);
  return bounds;
}

/**
 * The non-tenant AND member of the read. A person filter matches a row about that Employee, or a
 * row whose before/after value names the person under `employeeId` (the same selector the
 * anonymisation redactors use). Documented residue: a row that carries no `employeeId` anywhere
 * is not found by the person filter.
 */
export function auditFilterWhere(
  filters: Pick<AuditFilters, "action" | "entity" | "userId" | "employeeId">,
  bounds: PeriodBounds,
): Prisma.AuditLogWhereInput {
  const { action, entity, userId, employeeId } = filters;
  return {
    ...(action ? { action } : {}),
    ...(entity ? { entity } : {}),
    ...(userId ? { userId } : {}),
    ...(bounds.gte || bounds.lt
      ? {
          createdAt: {
            ...(bounds.gte ? { gte: bounds.gte } : {}),
            ...(bounds.lt ? { lt: bounds.lt } : {}),
          },
        }
      : {}),
    ...(employeeId
      ? {
          OR: [
            { entity: "Employee", entityId: employeeId },
            { newValue: { path: ["employeeId"], equals: employeeId } },
            { oldValue: { path: ["employeeId"], equals: employeeId } },
          ],
        }
      : {}),
  };
}

type AffectedSource = {
  entity: string;
  entityId: string | null;
  oldValue: unknown;
  newValue: unknown;
};

function employeeIdIn(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const id = (value as { employeeId?: unknown }).employeeId;
  return typeof id === "string" && id.length > 0 && id.length <= 64 ? id : null;
}

/** The person a row is about: the Employee itself, else the `employeeId` its values name. */
export function affectedEmployeeIdOf(row: AffectedSource): string | null {
  if (row.entity === "Employee") return row.entityId;
  return employeeIdIn(row.newValue) ?? employeeIdIn(row.oldValue);
}

/**
 * What a row shows about its person. Deliberately NO id: the list already carries the id wherever
 * the person is the row's entity, and a second copy would add an identifier to every response
 * (the permission neutrality matrix compares the ids of a body as a multiset).
 */
export type AffectedEmployee = {
  firstName: string;
  lastName: string;
  employeeNumber: string;
};

/**
 * Adds `affectedEmployee` (or `null`) to every row with ONE tenant-scoped employee read, so an id
 * of another tenant resolves to `null` and never leaks a name.
 */
export async function attachAffectedEmployees<T extends AffectedSource>(
  prisma: FastifyInstance["prisma"],
  tenantId: string,
  rows: readonly T[],
): Promise<(T & { affectedEmployee: AffectedEmployee | null })[]> {
  const ids = new Set<string>();
  for (const row of rows) {
    const id = affectedEmployeeIdOf(row);
    if (id) ids.add(id);
  }
  const byId = new Map<string, AffectedEmployee>();
  if (ids.size > 0) {
    const employees = await prisma.employee.findMany({
      where: { tenantId, id: { in: [...ids] } },
      select: { id: true, firstName: true, lastName: true, employeeNumber: true },
    });
    for (const { id, ...shown } of employees) byId.set(id, shown);
  }
  return rows.map((row) => {
    const id = affectedEmployeeIdOf(row);
    return { ...row, affectedEmployee: (id && byId.get(id)) || null };
  });
}

/** The tenant's time zone (the column defaults to Europe/Berlin, so a missing row reads the same). */
export async function auditTenantTimezone(
  prisma: FastifyInstance["prisma"],
  tenantId: string,
): Promise<string> {
  const config = await prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { timezone: true },
  });
  return config?.timezone ?? "Europe/Berlin";
}
