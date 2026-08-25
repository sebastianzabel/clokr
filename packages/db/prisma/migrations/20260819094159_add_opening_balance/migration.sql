-- CreateEnum
CREATE TYPE "OpeningBalanceSource" AS ENUM ('MIGRATED_FROM_SNAPSHOT', 'RECONSTRUCTED', 'ADMIN_ENTRY');

-- CreateTable
CREATE TABLE "OpeningBalance" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "evidenceRef" TEXT,
    "source" "OpeningBalanceSource" NOT NULL,
    "createdBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "superseded" BOOLEAN NOT NULL DEFAULT false,
    "supersededReason" TEXT,
    "supersededBy" TEXT,

    CONSTRAINT "OpeningBalance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpeningBalance_employeeId_idx" ON "OpeningBalance"("employeeId");

-- AddForeignKey
ALTER TABLE "OpeningBalance" ADD CONSTRAINT "OpeningBalance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Phase 99 (OB-01) — partial unique index; Prisma DSL cannot express the WHERE clause.
-- At most one ACTIVE opening balance per employee; superseded history rows are unconstrained.
CREATE UNIQUE INDEX "OpeningBalance_active_unique"
  ON "OpeningBalance" ("employeeId")
  WHERE "superseded" = false;
