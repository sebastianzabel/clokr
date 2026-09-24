/**
 * Phase 64b Plan 03 (issue #64, D-18) — the seeds' own copy of the default salon
 * opening-hours constant. Phase 67b Plan 04 (issue #67, D-24) adds this module's second
 * export: an idempotent seed helper that creates an employee's Stammsalon (HOME) row.
 *
 * `packages/db` cannot import from `apps/api` (the dependency runs the other way:
 * the API imports `@clokr/db`), so this is a deliberate second copy of
 * `DEFAULT_SALON_OPENING_HOURS` in `apps/api/src/contexts/platform/facade/salons.ts`.
 * Both constants must stay byte-identical to `TenantConfig.storeHours`'s Prisma
 * column default (`packages/db/prisma/schema.prisma`) — that equality is pinned by
 * `apps/api/src/__tests__/salon-migration.test.ts` on the API side.
 *
 * `seed.ts` and `seed-demo.ts` write this SAME constant into both
 * `TenantConfig.storeHours` and the tenant's default `Salon.openingHours`, so a
 * freshly bootstrapped tenant and its default salon agree by construction — even
 * if the schema default ever changes, both seed-written values change together.
 *
 * No side effects on import — this module only exports data plus one idempotent seed
 * helper, so it is safe to pull into any seed script without affecting `main()`'s own
 * idempotency checks.
 *
 * {@link createDefaultHomeAssignment} computes the tenant-local hire day with the
 * built-in `Intl.DateTimeFormat` rather than `date-fns-tz` (no such dependency here,
 * and `packages/db` cannot import `apps/api`'s `tenantLocalDay()` either). The result
 * equals both the plan-01 migration's `(hire_date AT TIME ZONE tz)::date` SQL and the
 * API's `tenantLocalDay()` (`apps/api/src/contexts/platform/salon-assignment-rules.ts`)
 * for the same instant + timezone — all three are IANA-timezone-to-calendar-day
 * conversions of the same value, `Intl.DateTimeFormat("en-CA", ...)` just reaches the
 * `YYYY-MM-DD` string a different way.
 */
import type { PrismaClient } from "../generated/client";

/** Mirrors `SalonOpeningHours`'s shape in the API facade — day 0 = Monday … 6 = Sunday. */
export interface SeedSalonOpeningHours {
  day: number;
  open: string;
  close: string;
  closed?: boolean;
}

export const DEFAULT_SALON_OPENING_HOURS: SeedSalonOpeningHours[] = [
  { day: 0, open: "08:00", close: "20:00" },
  { day: 1, open: "08:00", close: "20:00" },
  { day: 2, open: "08:00", close: "20:00" },
  { day: 3, open: "08:00", close: "20:00" },
  { day: 4, open: "08:00", close: "20:00" },
  { day: 5, open: "08:00", close: "20:00" },
  { day: 6, open: "08:00", close: "20:00", closed: true },
];

const DEFAULT_TENANT_TIMEZONE = "Europe/Berlin";

/**
 * D-24: creates `employeeId`'s Stammsalon (HOME) row, from its tenant-local hire day, to
 * its tenant's default salon (earliest-created active, tie-break id — the same #64
 * default-salon rule `listSalons()`/the plan-01 migration use). Idempotent: returns
 * without writing when the employee already has ANY HOME row. No audit trail write — a
 * seed script has no request principal, same reasoning as every other seeding call in
 * `seed.ts`/`seed-demo.ts`.
 *
 * Throws a plain English `Error` naming the tenant when it has no active salon — every
 * caller of this helper runs against a tenant that was just given its own salon a few
 * lines earlier in the same script, so this is a "should never happen" guard, not a
 * user-facing outcome (contrast `POST /api/v1/test/bootstrap-terminal`'s 409, which DOES
 * face a caller that can hit a salon-less tenant).
 */
export async function createDefaultHomeAssignment(
  prisma: PrismaClient,
  employeeId: string,
): Promise<void> {
  const existingHome = await prisma.employeeSalonAssignment.findFirst({
    where: { employeeId, kind: "HOME" },
  });
  if (existingHome) return;

  const employee = await prisma.employee.findUniqueOrThrow({
    where: { id: employeeId },
    select: { tenantId: true, hireDate: true },
  });

  const activeSalons = await prisma.salon.findMany({
    where: { tenantId: employee.tenantId, isActive: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const defaultSalon = activeSalons[0];
  if (!defaultSalon) {
    throw new Error(
      `createDefaultHomeAssignment: tenant ${employee.tenantId} has no active salon.`,
    );
  }

  const tenantConfig = await prisma.tenantConfig.findUnique({
    where: { tenantId: employee.tenantId },
    select: { timezone: true },
  });
  const timezone = tenantConfig?.timezone ?? DEFAULT_TENANT_TIMEZONE;

  // `en-CA` formats as `YYYY-MM-DD` — the tenant-local calendar day of the hire instant.
  const tenantLocalDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(employee.hireDate);
  const [year, month, day] = tenantLocalDay.split("-").map(Number);
  const validFrom = new Date(Date.UTC(year, month - 1, day));

  await prisma.employeeSalonAssignment.create({
    data: {
      tenantId: employee.tenantId,
      employeeId,
      salonId: defaultSalon.id,
      kind: "HOME",
      validFrom,
      validUntil: null,
      weekdays: [],
    },
  });
}
