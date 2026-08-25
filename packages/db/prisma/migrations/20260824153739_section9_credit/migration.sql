-- CreateEnum
CREATE TYPE "Section9CreditStatus" AS ENUM ('AU_PENDING', 'CONFIRMED', 'REJECTED');

-- CreateTable
CREATE TABLE "Section9Credit" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "sickRequestId" TEXT NOT NULL,
    "vacationRequestId" TEXT NOT NULL,
    "overlapStart" DATE NOT NULL,
    "overlapEnd" DATE NOT NULL,
    "status" "Section9CreditStatus" NOT NULL DEFAULT 'AU_PENDING',
    "creditedStart" DATE,
    "creditedEnd" DATE,
    "creditedDays" DECIMAL(5,2),
    "attestSource" TEXT,
    "attestValidFrom" DATE,
    "attestValidTo" DATE,
    "documentPath" TEXT,
    "reason" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Section9Credit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Section9Credit_employeeId_idx" ON "Section9Credit"("employeeId");

-- CreateIndex
CREATE INDEX "Section9Credit_sickRequestId_idx" ON "Section9Credit"("sickRequestId");

-- CreateIndex
CREATE INDEX "Section9Credit_vacationRequestId_idx" ON "Section9Credit"("vacationRequestId");

-- CreateIndex
CREATE INDEX "Section9Credit_status_idx" ON "Section9Credit"("status");

-- AddForeignKey
ALTER TABLE "Section9Credit" ADD CONSTRAINT "Section9Credit_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Section9Credit" ADD CONSTRAINT "Section9Credit_sickRequestId_fkey" FOREIGN KEY ("sickRequestId") REFERENCES "LeaveRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Section9Credit" ADD CONSTRAINT "Section9Credit_vacationRequestId_fkey" FOREIGN KEY ("vacationRequestId") REFERENCES "LeaveRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

