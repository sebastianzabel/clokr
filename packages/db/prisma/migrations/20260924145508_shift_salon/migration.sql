-- Phase 325 (issue #325): Shift.salonId / PhorestAppointment.salonId become required FKs onto
-- Salon (onDelete: Restrict). Prisma's naive `ADD COLUMN "salonId" TEXT NOT NULL` cannot run
-- against the existing, non-empty Shift/PhorestAppointment tables (no DEFAULT to backfill with),
-- so this migration is hand-restructured into: (1) nullable ADD COLUMN, (2) a marker-delimited
-- data section that backfills every row, (3) SET NOT NULL, (4) the generated index + FK
-- statements verbatim. See CLAUDE.md "Creating a migration" and docs/migrations.md.

-- AlterTable (nullable — see data section below for the backfill before SET NOT NULL)
ALTER TABLE "PhorestAppointment" ADD COLUMN     "salonId" TEXT;

-- AlterTable (nullable — see data section below for the backfill before SET NOT NULL)
ALTER TABLE "Shift" ADD COLUMN     "salonId" TEXT;

-- 325-data-migration:begin
-- Phase 325 (issue #325), D-02/D-03/D-04: backfill every existing Shift/PhorestAppointment row
-- with its tenant's default salon before the column becomes NOT NULL.
--
-- Step 1 (this INSERT) and the UPDATEs below are independent of each other: this INSERT only
-- ever creates a Salon row for a tenant that has none yet (WHERE NOT EXISTS), so it may run
-- either before or after the nullable ADD COLUMN above — it is included here, inside the single
-- data-migration marker section, so `apps/api/src/__tests__/shift-salon-migration.test.ts`
-- (Phase 325) can replay this ENTIRE section as one unit and observe the same end state this
-- migration produces. It is copied verbatim from the 64b data section
-- (packages/db/prisma/migrations/20260924071637_add_salon/migration.sql) so that "no shift is
-- left without a salon" (AC-2) holds even for a tenant created outside 64b's own D-18 paths
-- (e.g. a tenant inserted directly by a script or a test between 64b and this migration).
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

-- Step 2: backfill Shift.salonId with its tenant's default salon (D-04 rule: earliest-created
-- ACTIVE salon; ORDER BY "isActive" DESC as a migration-only fallback to the earliest salon of
-- any state, for the edge case where a tenant somehow has salons but none active — should not
-- happen thanks to the last-active guard, but the migration must never leave a row NULL).
-- Shift has no tenantId column of its own; tenancy is via Shift.employeeId -> Employee.tenantId
-- (CLAUDE.md "No foreign keys between peer contexts"). This touches ALL rows, including
-- soft-deleted and past shifts, and sets ONLY "salonId" (D-03, AC-8 SHIFT_PAST_IMMUTABLE — every
-- other column is left untouched).
UPDATE "Shift" AS sh
SET "salonId" = (
  SELECT s."id" FROM "Salon" s WHERE s."tenantId" = e."tenantId" ORDER BY s."isActive" DESC, s."createdAt" ASC, s."id" ASC LIMIT 1
)
FROM "Employee" e
WHERE e."id" = sh."employeeId" AND sh."salonId" IS NULL;

-- Step 3: identical backfill for PhorestAppointment (also no tenantId column of its own; tenancy
-- via PhorestAppointment.employeeId -> Employee.tenantId).
UPDATE "PhorestAppointment" AS pa
SET "salonId" = (
  SELECT s."id" FROM "Salon" s WHERE s."tenantId" = e."tenantId" ORDER BY s."isActive" DESC, s."createdAt" ASC, s."id" ASC LIMIT 1
)
FROM "Employee" e
WHERE e."id" = pa."employeeId" AND pa."salonId" IS NULL;
-- 325-data-migration:end

-- AlterTable (now that every row has a salonId, the column can become required)
ALTER TABLE "PhorestAppointment" ALTER COLUMN "salonId" SET NOT NULL;

-- AlterTable (now that every row has a salonId, the column can become required)
ALTER TABLE "Shift" ALTER COLUMN "salonId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "PhorestAppointment_salonId_idx" ON "PhorestAppointment"("salonId");

-- CreateIndex
CREATE INDEX "Shift_salonId_idx" ON "Shift"("salonId");

-- AddForeignKey
ALTER TABLE "PhorestAppointment" ADD CONSTRAINT "PhorestAppointment_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "Salon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "Salon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
