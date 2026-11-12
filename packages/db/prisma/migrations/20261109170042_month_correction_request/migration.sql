-- Issue #599 - correction requests for a day of a CLOSED month (Arbeitszeitkonto).
-- Additive: a new enum, a new table, two FKs (Employee and OvertimeTransaction, both RESTRICT).
-- No existing table, column or row is changed. Generated with `prisma migrate diff` against a
-- shadow DB; the CHECK at the end is hand-written (Prisma models no CHECK, the drift check stays empty).

-- CreateEnum
CREATE TYPE "MonthCorrectionRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "MonthCorrectionRequest" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "targetDate" DATE NOT NULL,
    "startTime" TEXT,
    "endTime" TEXT,
    "breakMinutes" INTEGER,
    "reason" TEXT NOT NULL,
    "status" "MonthCorrectionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedByUserId" TEXT NOT NULL,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMPTZ,
    "reviewNote" TEXT,
    "correctionMinutes" INTEGER,
    "bookingDate" DATE,
    "overtimeTransactionId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "MonthCorrectionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MonthCorrectionRequest_overtimeTransactionId_key" ON "MonthCorrectionRequest"("overtimeTransactionId");

-- CreateIndex
CREATE INDEX "MonthCorrectionRequest_employeeId_status_idx" ON "MonthCorrectionRequest"("employeeId", "status");

-- CreateIndex
CREATE INDEX "MonthCorrectionRequest_employeeId_bookingDate_idx" ON "MonthCorrectionRequest"("employeeId", "bookingDate");

-- AddForeignKey
ALTER TABLE "MonthCorrectionRequest" ADD CONSTRAINT "MonthCorrectionRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthCorrectionRequest" ADD CONSTRAINT "MonthCorrectionRequest_overtimeTransactionId_fkey" FOREIGN KEY ("overtimeTransactionId") REFERENCES "OvertimeTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written backstop of the approval shape: an APPROVED row always carries its booking (minutes,
-- day, journal row), no other status carries one, and a booked correction is never 0 minutes.
ALTER TABLE "MonthCorrectionRequest" ADD CONSTRAINT "MonthCorrectionRequest_booking_shape_check" CHECK (
  ("status" = 'APPROVED') = ("correctionMinutes" IS NOT NULL AND "bookingDate" IS NOT NULL AND "overtimeTransactionId" IS NOT NULL)
  AND ("correctionMinutes" IS NULL OR "correctionMinutes" <> 0)
);
