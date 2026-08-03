-- CreateEnum
CREATE TYPE "ShiftOrigin" AS ENUM ('MANUAL', 'PHOREST');

-- AlterTable
ALTER TABLE "Shift" ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "origin" "ShiftOrigin" NOT NULL DEFAULT 'MANUAL';

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "phorestSyncWindowDays" INTEGER NOT NULL DEFAULT 7;

-- CreateTable
CREATE TABLE "PhorestStaffMapping" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phorestStaffId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "PhorestStaffMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhorestSyncRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ,
    "status" TEXT NOT NULL,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "cancelled" INTEGER NOT NULL DEFAULT 0,
    "unmapped" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "PhorestSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PhorestStaffMapping_tenantId_idx" ON "PhorestStaffMapping"("tenantId");

-- CreateIndex
CREATE INDEX "PhorestStaffMapping_employeeId_idx" ON "PhorestStaffMapping"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "PhorestStaffMapping_tenantId_phorestStaffId_key" ON "PhorestStaffMapping"("tenantId", "phorestStaffId");

-- CreateIndex
CREATE INDEX "PhorestSyncRun_tenantId_startedAt_idx" ON "PhorestSyncRun"("tenantId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Shift_externalId_key" ON "Shift"("externalId");

-- CreateIndex
CREATE INDEX "Shift_origin_date_idx" ON "Shift"("origin", "date");

-- AddForeignKey
ALTER TABLE "PhorestStaffMapping" ADD CONSTRAINT "PhorestStaffMapping_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhorestStaffMapping" ADD CONSTRAINT "PhorestStaffMapping_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhorestSyncRun" ADD CONSTRAINT "PhorestSyncRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
