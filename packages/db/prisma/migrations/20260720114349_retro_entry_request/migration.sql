-- CreateEnum
CREATE TYPE "RetroEntryStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'USED');

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "closeMonthWithGapsAllowed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "retroEntryWindowDays" INTEGER NOT NULL DEFAULT 10;

-- CreateTable
CREATE TABLE "RetroEntryRequest" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "targetDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "RetroEntryStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMPTZ,
    "reviewNote" TEXT,
    "deletedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "RetroEntryRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RetroEntryRequest_employeeId_idx" ON "RetroEntryRequest"("employeeId");

-- CreateIndex
CREATE INDEX "RetroEntryRequest_employeeId_targetDate_idx" ON "RetroEntryRequest"("employeeId", "targetDate");

-- CreateIndex
CREATE INDEX "RetroEntryRequest_employeeId_status_idx" ON "RetroEntryRequest"("employeeId", "status");

-- AddForeignKey
ALTER TABLE "RetroEntryRequest" ADD CONSTRAINT "RetroEntryRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
