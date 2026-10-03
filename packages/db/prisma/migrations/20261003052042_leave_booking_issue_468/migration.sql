-- CreateEnum
CREATE TYPE "ParentalLeaveReductionStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- AlterEnum
ALTER TYPE "Section9CreditStatus" ADD VALUE 'SUPERSEDED';

-- DropIndex
DROP INDEX "Section9Credit_sickRequestId_vacationRequestId_key";

-- AlterTable
ALTER TABLE "LeaveRequest" ADD COLUMN     "overtimeCompMinutes" INTEGER;

-- AlterTable
ALTER TABLE "Section9Credit" ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "supersedesId" TEXT;

-- CreateTable
CREATE TABLE "ParentalLeaveReduction" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveRequestId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "months" INTEGER NOT NULL,
    "reducedDays" DECIMAL(5,2) NOT NULL,
    "declaredAt" DATE NOT NULL,
    "status" "ParentalLeaveReductionStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ,
    "revokedBy" TEXT,

    CONSTRAINT "ParentalLeaveReduction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ParentalLeaveReduction_employeeId_idx" ON "ParentalLeaveReduction"("employeeId");

-- CreateIndex
CREATE INDEX "ParentalLeaveReduction_employeeId_year_idx" ON "ParentalLeaveReduction"("employeeId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "ParentalLeaveReduction_leaveRequestId_year_key" ON "ParentalLeaveReduction"("leaveRequestId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "Section9Credit_supersedesId_key" ON "Section9Credit"("supersedesId");

-- CreateIndex
CREATE UNIQUE INDEX "Section9Credit_sickRequestId_vacationRequestId_revision_key" ON "Section9Credit"("sickRequestId", "vacationRequestId", "revision");

-- AddForeignKey
ALTER TABLE "Section9Credit" ADD CONSTRAINT "Section9Credit_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "Section9Credit"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ParentalLeaveReduction" ADD CONSTRAINT "ParentalLeaveReduction_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParentalLeaveReduction" ADD CONSTRAINT "ParentalLeaveReduction_leaveRequestId_fkey" FOREIGN KEY ("leaveRequestId") REFERENCES "LeaveRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

