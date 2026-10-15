-- CreateEnum
CREATE TYPE "TenantModule" AS ENUM ('CHAIN', 'INTEGRATIONS', 'HARDWARE_CLOCK', 'ANALYTICS');

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "bookedModules" "TenantModule"[] DEFAULT ARRAY[]::"TenantModule"[],
ADD COLUMN     "salonQuota" INTEGER NOT NULL DEFAULT 1;


-- Hand-written DDL: Prisma cannot model a CHECK constraint, and `prisma migrate diff` ignores it, so
-- the CI drift guard stays empty. A salon quota below 1 would make the Ketten-Paket meaningless
-- (the Grundversion limit of one salon is expressed by "no CHAIN module", never by quota 0).
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_salonQuota_positive" CHECK ("salonQuota" >= 1);

-- Bestandsschutz (Phase 566, D-09): every tenant that exists at deploy time keeps what it already
-- uses. The packages are derived conservatively from the stored data, so a rule that did not exist
-- before this migration can never take away something a tenant already has: the salon quota is the
-- number of active salons (at least 1), and a module is granted when ANY signal of its use exists.
-- This over-grants on purpose (soft-deleted and revoked rows count) and includes deactivated
-- tenants; the operator corrects a grant afterwards. The guard on salonQuota/bookedModules makes
-- a second execution a no-op for any tenant that was granted anything or edited by an operator.
-- 566-data-migration:begin
UPDATE "Tenant" AS t
SET "salonQuota" = g."quota", "bookedModules" = g."modules"
FROM (
  SELECT x.id,
    GREATEST(1, x."activeSalons")::integer AS "quota",
    array_remove(ARRAY[
      CASE WHEN x."chain" THEN 'CHAIN'::"TenantModule" END,
      CASE WHEN x."integrations" THEN 'INTEGRATIONS'::"TenantModule" END,
      CASE WHEN x."hardware" THEN 'HARDWARE_CLOCK'::"TenantModule" END,
      CASE WHEN x."analytics" THEN 'ANALYTICS'::"TenantModule" END
    ], NULL) AS "modules"
  FROM (
    SELECT t2.id,
      (SELECT COUNT(*) FROM "Salon" s WHERE s."tenantId" = t2.id AND s."isActive") AS "activeSalons",
      ( (SELECT COUNT(*) FROM "Salon" s WHERE s."tenantId" = t2.id) > 1
        OR EXISTS (SELECT 1 FROM "AccessRole" r WHERE r."tenantId" = t2.id)
        OR EXISTS (SELECT 1 FROM "RoleAssignment" ra WHERE ra."tenantId" = t2.id AND ra."scopeType" IN ('SALONS', 'PERSONS'))
        OR EXISTS (SELECT 1 FROM "EmployeeSalonAssignment" a WHERE a."tenantId" = t2.id AND a."kind" = 'DEPLOYMENT')
      ) AS "chain",
      ( EXISTS (SELECT 1 FROM "SalonCoupling" c WHERE c."tenantId" = t2.id)
        OR EXISTS (SELECT 1 FROM "ApiKey" k WHERE k."tenantId" = t2.id)
        OR EXISTS (SELECT 1 FROM "TenantConfig" tc WHERE tc."tenantId" = t2.id AND (
             COALESCE(BTRIM(tc."phorestBusinessId"), '') <> ''
          OR COALESCE(BTRIM(tc."phorestUsername"), '') <> ''
          OR COALESCE(tc."phorestPassword", '') <> ''))
      ) AS "integrations",
      ( EXISTS (SELECT 1 FROM "TerminalApiKey" k WHERE k."tenantId" = t2.id)
        OR EXISTS (SELECT 1 FROM "PresenceSource" p WHERE p."tenantId" = t2.id)
      ) AS "hardware",
      ( EXISTS (SELECT 1 FROM "TimeEntry" te JOIN "Employee" e ON e.id = te."employeeId"
                WHERE e."tenantId" = t2.id AND te."activityKind" <> 'UNSPECIFIED')
        OR EXISTS (SELECT 1 FROM "TimeEntryActivityShare" sh
                   JOIN "TimeEntry" te ON te.id = sh."timeEntryId"
                   JOIN "Employee" e ON e.id = te."employeeId" WHERE e."tenantId" = t2.id)
      ) AS "analytics"
    FROM "Tenant" t2
  ) x
) g
WHERE g.id = t.id
  AND t."salonQuota" = 1
  AND COALESCE(cardinality(t."bookedModules"), 0) = 0;
-- 566-data-migration:end
