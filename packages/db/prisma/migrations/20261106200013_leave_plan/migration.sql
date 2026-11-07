-- CreateEnum
CREATE TYPE "LeavePlanStatus" AS ENUM ('OPEN', 'TAKEN_OVER');

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "leavePlanDeadlineLocksWishes" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "LeavePlan" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "deadline" DATE,
    "status" "LeavePlanStatus" NOT NULL DEFAULT 'OPEN',
    "openedByUserId" TEXT NOT NULL,
    "openedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "takenOverAt" TIMESTAMPTZ,
    "takenOverByUserId" TEXT,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "LeavePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeavePlanWish" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "halfDay" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "deletedAt" TIMESTAMPTZ,
    "deletedByUserId" TEXT,
    "leaveRequestId" TEXT,
    "takenOverAt" TIMESTAMPTZ,
    "refusalCode" TEXT,
    "refusalMessage" TEXT,
    "refusedAt" TIMESTAMPTZ,

    CONSTRAINT "LeavePlanWish_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeavePlan_tenantId_salonId_year_idx" ON "LeavePlan"("tenantId", "salonId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "LeavePlanWish_leaveRequestId_key" ON "LeavePlanWish"("leaveRequestId");

-- CreateIndex
CREATE INDEX "LeavePlanWish_tenantId_planId_deletedAt_idx" ON "LeavePlanWish"("tenantId", "planId", "deletedAt");

-- CreateIndex
CREATE INDEX "LeavePlanWish_employeeId_deletedAt_idx" ON "LeavePlanWish"("employeeId", "deletedAt");

-- AddForeignKey
ALTER TABLE "LeavePlan" ADD CONSTRAINT "LeavePlan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeavePlan" ADD CONSTRAINT "LeavePlan_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "Salon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeavePlanWish" ADD CONSTRAINT "LeavePlanWish_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeavePlanWish" ADD CONSTRAINT "LeavePlanWish_planId_fkey" FOREIGN KEY ("planId") REFERENCES "LeavePlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeavePlanWish" ADD CONSTRAINT "LeavePlanWish_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeavePlanWish" ADD CONSTRAINT "LeavePlanWish_leaveRequestId_fkey" FOREIGN KEY ("leaveRequestId") REFERENCES "LeaveRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

