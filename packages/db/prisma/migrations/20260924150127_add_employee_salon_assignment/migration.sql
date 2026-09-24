-- CreateEnum
CREATE TYPE "SalonAssignmentKind" AS ENUM ('HOME', 'DEPLOYMENT');

-- CreateTable
CREATE TABLE "EmployeeSalonAssignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "kind" "SalonAssignmentKind" NOT NULL,
    "validFrom" DATE NOT NULL,
    "validUntil" DATE,
    "weekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "EmployeeSalonAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeeSalonAssignment_tenantId_idx" ON "EmployeeSalonAssignment"("tenantId");

-- CreateIndex
CREATE INDEX "EmployeeSalonAssignment_employeeId_kind_validFrom_idx" ON "EmployeeSalonAssignment"("employeeId", "kind", "validFrom");

-- CreateIndex
CREATE INDEX "EmployeeSalonAssignment_salonId_idx" ON "EmployeeSalonAssignment"("salonId");

-- AddForeignKey
ALTER TABLE "EmployeeSalonAssignment" ADD CONSTRAINT "EmployeeSalonAssignment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSalonAssignment" ADD CONSTRAINT "EmployeeSalonAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSalonAssignment" ADD CONSTRAINT "EmployeeSalonAssignment_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "Salon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 67b-data-migration:begin
-- Phase 67b (issue #67), D-25: give every employee that existed before this migration — including
-- exited and anonymized employees, no filter on either — exactly one open HOME (Stammsalon) row,
-- from the tenant-local calendar day of hireDate, open-ended, weekdays [].
--
-- Default salon per tenant = the earliest-created ACTIVE salon (createdAt asc, tie-break id) —
-- binding decision from issue #64's Ready-Prüfung, mirrored by `listSalons`'s own ordering. A
-- tenant with no active salon at all falls back to its earliest-created INACTIVE salon (same
-- ordering) rather than leaving the employee without a HOME row. A tenant with NO salon at all
-- (cannot occur after 64b's own migration gave every existing tenant a default salon) gets no rows
-- for its employees — there is nothing to assign them to.
--
-- validFrom is computed from the employee's hireDate (a Timestamptz instant) converted to a
-- calendar day in the TENANT's local timezone, COALESCING to Europe/Berlin for a tenant that has
-- no TenantConfig row at all (same fallback `getTenantTimezone`/`todayInTz` use elsewhere).
--
-- NOT EXISTS (keyed on employeeId + kind = 'HOME') makes this idempotent: re-running this section
-- (or applying it a second time, as the tracer test's Task 2 cases do) creates nothing for an
-- employee that already has a HOME row, regardless of how that row was created.
INSERT INTO "EmployeeSalonAssignment"
  (id, "tenantId", "employeeId", "salonId", kind, "validFrom", "validUntil", weekdays, "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  e."tenantId",
  e.id,
  ds.id,
  'HOME',
  (e."hireDate" AT TIME ZONE COALESCE(tc.timezone, 'Europe/Berlin'))::date,
  NULL,
  '{}',
  NOW(),
  NOW()
FROM "Employee" e
LEFT JOIN "TenantConfig" tc ON tc."tenantId" = e."tenantId"
JOIN (
  SELECT DISTINCT ON ("tenantId") id, "tenantId"
  FROM "Salon"
  ORDER BY "tenantId", "isActive" DESC, "createdAt", id
) ds ON ds."tenantId" = e."tenantId"
WHERE NOT EXISTS (
  SELECT 1 FROM "EmployeeSalonAssignment" a
  WHERE a."employeeId" = e.id AND a.kind = 'HOME'
);
-- 67b-data-migration:end
