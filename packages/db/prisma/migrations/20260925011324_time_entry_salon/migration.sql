-- Phase 68b (issue #68): TimeEntry.salonId becomes a required FK onto Salon (onDelete: Restrict)
-- — the place where the work was done. Prisma's naive `ADD COLUMN "salonId" TEXT NOT NULL` cannot
-- run against the existing, non-empty TimeEntry table (no DEFAULT to backfill with), so this
-- migration is hand-restructured into four stages, exactly like the Phase 325 shift_salon
-- migration: (1) nullable ADD COLUMN, (2) a marker-delimited data section that backfills every
-- row, (3) SET NOT NULL, (4) the generated index + FK statements verbatim. See CLAUDE.md
-- "Creating a migration" and docs/migrations.md.

-- AlterTable (nullable — see data section below for the backfill before SET NOT NULL)
ALTER TABLE "TimeEntry" ADD COLUMN     "salonId" TEXT;

-- 68b-data-migration:begin
-- Phase 68b (issue #68), D-02/D-03: backfill every existing TimeEntry row with its tenant's
-- default salon before the column becomes NOT NULL. This section is replayed verbatim by
-- `apps/api/src/__tests__/time-entry-salon-migration.test.ts`, so it must stay DML-only.
--
-- Step 1 (this INSERT) is copied verbatim from the Phase 325 / 64b data sections. It only ever
-- creates a Salon row for a tenant that has none yet (WHERE NOT EXISTS), so it is a no-op on any
-- database that went through 64b/325; it is kept as belt-and-suspenders so that "no entry is left
-- without a salon" (AC-2) holds even for a tenant created outside the 64b/67b paths (e.g. a
-- tenant inserted directly by a script).
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

-- Step 2: backfill TimeEntry.salonId with its tenant's default salon. The ORDER BY encodes the
-- default-salon rule of `findDefaultSalon` (earliest-created ACTIVE salon) plus a migration-only
-- fallback to the earliest salon of any state (ORDER BY "isActive" DESC), so the migration can
-- never leave a row NULL even for a tenant whose salons are all deactivated.
-- TimeEntry has no tenantId column of its own; tenancy runs through
-- TimeEntry.employeeId -> Employee.tenantId.
-- The UPDATE touches ALL rows — locked, soft-deleted, retro-pending and invalid ones — and sets
-- ONLY "salonId" (D-03). Per issue #68 "Rechtlicher Bezug" this is the one-time introduction of a
-- new attribute with one value for all legacy data, not a business change of a locked entry.
-- "updatedAt" does not move: it is maintained client-side by Prisma (@updatedAt) and no trigger
-- exists on TimeEntry. By owner decision no per-row AuditLog is written — this migration itself
-- and the release notes are the record.
UPDATE "TimeEntry" AS te
SET "salonId" = (
  SELECT s."id" FROM "Salon" s WHERE s."tenantId" = e."tenantId" ORDER BY s."isActive" DESC, s."createdAt" ASC, s."id" ASC LIMIT 1
)
FROM "Employee" e
WHERE e."id" = te."employeeId" AND te."salonId" IS NULL;
-- 68b-data-migration:end

-- AlterTable (now that every row has a salonId, the column can become required)
ALTER TABLE "TimeEntry" ALTER COLUMN "salonId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "TimeEntry_salonId_idx" ON "TimeEntry"("salonId");

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "Salon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
