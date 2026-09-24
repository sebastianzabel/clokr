-- CreateTable
CREATE TABLE "Salon" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "street" TEXT,
    "postalCode" TEXT,
    "city" TEXT,
    "openingHours" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Salon_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Salon_tenantId_idx" ON "Salon"("tenantId");

-- AddForeignKey
ALTER TABLE "Salon" ADD CONSTRAINT "Salon_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 64b-data-migration:begin
-- Phase 64b (issue #64), D-14: give every tenant that existed before this migration exactly one
-- active default salon, named like the tenant, with no address, whose opening hours are copied
-- from TenantConfig.storeHours. COALESCE falls back to the exact schema.prisma:217 column default
-- for a tenant that has no TenantConfig row at all (the column default is what that tenant
-- effectively has today). NOT EXISTS makes this idempotent: re-running this section (or applying
-- it a second time, as the tracer test below does) creates nothing for a tenant that already has
-- a Salon row, regardless of how that row was created.
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
-- 64b-data-migration:end
