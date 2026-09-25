-- Phase 65b (issue #65): a new Schichtplanung table "SalonCoupling" (one external branch per
-- salon) replaces TenantConfig.phorestBranchId as the Phorest sync's source of the branch, and
-- PhorestSyncRun.salonId becomes a required FK onto Salon (onDelete: Restrict). Prisma's naive
-- `ADD COLUMN "salonId" TEXT NOT NULL` cannot run against the existing, non-empty PhorestSyncRun
-- table (no DEFAULT to backfill with), and every existing phorestBranchId must become a coupling,
-- so this migration is hand-restructured into: (1) the generated SalonCoupling DDL verbatim
-- (placed first, so the backfill INSERT below is checked by the same unique constraints and FKs
-- the application relies on), (2) a nullable ADD COLUMN on PhorestSyncRun, (3) a marker-delimited
-- data section, (4) SET NOT NULL, (5) the generated PhorestSyncRun index + FK statements
-- verbatim. See CLAUDE.md "Creating a migration" and docs/migrations.md.

-- CreateEnum
CREATE TYPE "SalonCouplingProvider" AS ENUM ('PHOREST');

-- CreateTable
CREATE TABLE "SalonCoupling" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "provider" "SalonCouplingProvider" NOT NULL,
    "externalBranchId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "SalonCoupling_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SalonCoupling_salonId_key" ON "SalonCoupling"("salonId");

-- CreateIndex
CREATE INDEX "SalonCoupling_tenantId_idx" ON "SalonCoupling"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "SalonCoupling_tenantId_provider_externalBranchId_key" ON "SalonCoupling"("tenantId", "provider", "externalBranchId");

-- AddForeignKey
ALTER TABLE "SalonCoupling" ADD CONSTRAINT "SalonCoupling_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalonCoupling" ADD CONSTRAINT "SalonCoupling_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "Salon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable (nullable — see data section below for the backfill before SET NOT NULL)
ALTER TABLE "PhorestSyncRun" ADD COLUMN     "salonId" TEXT;

-- 65b-data-migration:begin
-- Phase 65b (issue #65), D-05: turn every existing TenantConfig.phorestBranchId into a PHOREST
-- coupling on the tenant's default salon, and give every existing PhorestSyncRun that default
-- salon, before PhorestSyncRun.salonId becomes NOT NULL.
--
-- This section is replayed as ONE unit by apps/api/src/__tests__/salon-coupling-migration.test.ts,
-- which observes the same end state this migration produces.
--
-- "Default salon" = findDefaultSalon()'s rule (apps/api/src/contexts/platform/facade/salons.ts):
-- the earliest-created ACTIVE salon. ORDER BY "isActive" DESC is a migration-only fallback to the
-- earliest salon of any state, for the edge case where a tenant has salons but none active —
-- should not happen thanks to the last-active guard, but the migration must never leave a run
-- NULL (same wording and rule as the 325 data section).
--
-- Step 1: copied verbatim from the 325 data section
-- (packages/db/prisma/migrations/20260924145508_shift_salon/migration.sql). It only ever creates a
-- Salon row for a tenant that has none yet (WHERE NOT EXISTS), so no coupling and no run is left
-- without a salon even for a tenant created outside the 64b/325 paths.
INSERT INTO "Salon" ("id", "tenantId", "name", "openingHours", "isActive", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  t."id",
  t."name",
  COALESCE(
    tc."storeHours",
    '[{"day":0,"open":"08:00","close":"20:00"},{"day":1,"open":"08:00","close":"20:00"},{"day":2,"open":"08:00","close":"20:00"},{"day":3,"open":"08:00","close":"20:00"},{"day":4,"open":"08:00","close":"20:00"},{"day":5,"open":"08:00","close":"20:00"},{"day":6,"open":"08:00","close":"20:00","closed":true}]'::jsonb
  ),
  true,
  NOW(),
  NOW()
FROM "Tenant" t
LEFT JOIN "TenantConfig" tc ON tc."tenantId" = t."id"
WHERE NOT EXISTS (SELECT 1 FROM "Salon" s WHERE s."tenantId" = t."id");

-- Step 2: one PHOREST coupling per tenant with a non-blank phorestBranchId, on its default salon,
-- with the trimmed branch id. A tenant without a (non-blank) phorestBranchId gets NO coupling. The
-- NOT EXISTS is a no-op on the freshly created, empty table and makes the section replay-safe.
-- phorestBranchId is deliberately NOT cleared: the column is deprecated but stays as the rollback
-- path (owner decision, like TenantConfig.storeHours in #64).
INSERT INTO "SalonCoupling" ("id", "tenantId", "salonId", "provider", "externalBranchId", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  tc."tenantId",
  (SELECT s."id" FROM "Salon" s WHERE s."tenantId" = tc."tenantId" ORDER BY s."isActive" DESC, s."createdAt" ASC, s."id" ASC LIMIT 1),
  'PHOREST'::"SalonCouplingProvider",
  TRIM(tc."phorestBranchId"),
  NOW(),
  NOW()
FROM "TenantConfig" tc
WHERE NULLIF(TRIM(tc."phorestBranchId"), '') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "SalonCoupling" sc WHERE sc."tenantId" = tc."tenantId");

-- Step 3: every existing sync run gets its tenant's default salon (the only salon any run could
-- have synced before this phase).
UPDATE "PhorestSyncRun" AS r
SET "salonId" = (
  SELECT s."id" FROM "Salon" s WHERE s."tenantId" = r."tenantId" ORDER BY s."isActive" DESC, s."createdAt" ASC, s."id" ASC LIMIT 1
)
WHERE r."salonId" IS NULL;
-- 65b-data-migration:end

-- AlterTable (now that every run has a salonId, the column can become required)
ALTER TABLE "PhorestSyncRun" ALTER COLUMN "salonId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "PhorestSyncRun_salonId_idx" ON "PhorestSyncRun"("salonId");

-- AddForeignKey
ALTER TABLE "PhorestSyncRun" ADD CONSTRAINT "PhorestSyncRun_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "Salon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
