-- CreateEnum
CREATE TYPE "LeaveLimitGroupKind" AS ENUM ('ALL', 'CLASSIFICATION', 'ACCESS_ROLE');

-- CreateTable
CREATE TABLE "LeaveLimitRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "salonId" TEXT,
    "groupKind" "LeaveLimitGroupKind" NOT NULL,
    "classification" "EmployeeClassification",
    "accessRoleId" TEXT,
    "maxPersons" INTEGER NOT NULL,
    "validFrom" DATE,
    "validUntil" DATE,
    "name" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "deletedAt" TIMESTAMPTZ,
    "deletedByUserId" TEXT,

    CONSTRAINT "LeaveLimitRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeaveLimitRule_tenantId_deletedAt_idx" ON "LeaveLimitRule"("tenantId", "deletedAt");

-- CreateIndex
CREATE INDEX "LeaveLimitRule_salonId_idx" ON "LeaveLimitRule"("salonId");

-- CreateIndex
CREATE INDEX "LeaveLimitRule_accessRoleId_idx" ON "LeaveLimitRule"("accessRoleId");

-- AddForeignKey
ALTER TABLE "LeaveLimitRule" ADD CONSTRAINT "LeaveLimitRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveLimitRule" ADD CONSTRAINT "LeaveLimitRule_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "Salon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveLimitRule" ADD CONSTRAINT "LeaveLimitRule_accessRoleId_fkey" FOREIGN KEY ("accessRoleId") REFERENCES "AccessRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

