-- Phase 71b (issue #71): D-01 `Salon.federalState` (required, no default) and D-02
-- `PublicHoliday.salonId` (required FK onto Salon, onDelete: Restrict, uniqueness moves from
-- [tenantId, date] to [salonId, date]). Prisma's naive diff would emit both new columns as a
-- plain `ADD COLUMN ... NOT NULL`, which cannot run against the existing, non-empty Salon and
-- PublicHoliday tables (no DEFAULT to backfill with). This migration is hand-restructured into
-- four stages, exactly like the Phase 325 shift_salon and Phase 68b time_entry_salon migrations:
-- (1) nullable ADD COLUMN for both columns, (2) a marker-delimited data section that backfills
-- every row, (3) SET NOT NULL on both columns, (4) the generated index + FK statements verbatim.
-- See CLAUDE.md "Creating a migration" and docs/migrations.md.

-- AlterTable (nullable — see data section below for the backfill before SET NOT NULL)
ALTER TABLE "Salon" ADD COLUMN "federalState" "FederalState";
ALTER TABLE "PublicHoliday" ADD COLUMN "salonId" TEXT;

-- 71b-data-migration:begin
-- Phase 71b (issue #71), D-01/D-02/D-03: backfill every existing Salon row's federalState from
-- its tenant, and every existing PublicHoliday row's salonId from its tenant's default salon,
-- before either column becomes NOT NULL. This section is replayed verbatim by
-- `apps/api/src/__tests__/holiday-salon-migration.test.ts`, so it must stay DML-only.
--
-- Step 1 (this INSERT) is copied verbatim from the Phase 64b/325/68b data sections, with
-- "federalState" added to the column list and the tenant's own federalState to the SELECT — a
-- salon created here for a salonless tenant inherits the tenant's state (D-01 in SQL). It only
-- ever creates a Salon row for a tenant that has none yet (WHERE NOT EXISTS), so it is a no-op on
-- any database that already went through 64b/325/68b; it is kept as belt-and-suspenders so that
-- "every Salon row has a federalState" and "no PublicHoliday row is left without a salonId" hold
-- even for a tenant created outside those paths (e.g. a tenant inserted directly by a script).
INSERT INTO "Salon" ("id", "tenantId", "name", "federalState", "openingHours", "isActive", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  t."id",
  t."name",
  t."federalState",
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

-- Step 2: every Salon row of a tenant gets that tenant's CURRENT federalState
-- (Tenant.federalState keeps existing, D-01 — it becomes purely the default a NEW salon is
-- created with when no state is given). "IS NULL" guards idempotency: a re-run changes nothing.
UPDATE "Salon" AS s
SET "federalState" = t."federalState"
FROM "Tenant" t
WHERE t."id" = s."tenantId" AND s."federalState" IS NULL;

-- Step 3: backfill PublicHoliday.salonId with its tenant's default salon. The ORDER BY encodes
-- the default-salon rule of `findDefaultSalon` (earliest-created ACTIVE salon) plus a
-- migration-only fallback to the earliest salon of any state (ORDER BY "isActive" DESC), so the
-- migration can never leave a row NULL even for a tenant whose salons are all deactivated. The
-- old unique [tenantId, date] implies the new [salonId, date] holds for backfilled rows because
-- every row of one tenant goes to that same tenant's one default salon. By owner decision, no
-- per-row AuditLog is written for this one-time backfill — this migration and the release notes
-- are the record.
UPDATE "PublicHoliday" AS ph
SET "salonId" = (
  SELECT s."id" FROM "Salon" s WHERE s."tenantId" = ph."tenantId" ORDER BY s."isActive" DESC, s."createdAt" ASC, s."id" ASC LIMIT 1
)
WHERE ph."salonId" IS NULL;
-- 71b-data-migration:end

-- AlterTable (now that every row has a value, both columns can become required)
ALTER TABLE "Salon" ALTER COLUMN "federalState" SET NOT NULL;
ALTER TABLE "PublicHoliday" ALTER COLUMN "salonId" SET NOT NULL;

-- DropIndex
DROP INDEX "PublicHoliday_tenantId_date_key";

-- CreateIndex
CREATE UNIQUE INDEX "PublicHoliday_salonId_date_key" ON "PublicHoliday"("salonId", "date");

-- AddForeignKey
ALTER TABLE "PublicHoliday" ADD CONSTRAINT "PublicHoliday_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "Salon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
