-- DropIndex (plain unique index on all rows — replaced by partial unique below)
DROP INDEX IF EXISTS "SaldoSnapshot_employeeId_periodType_periodStart_key";

-- CreateIndex (partial unique — COMP-V1814-04; Prisma DSL cannot express WHERE clause)
-- Only one active (superseded=false) row per (employeeId, periodType, periodStart) is allowed.
-- Superseded rows (superseded=true) coexist without constraint, preserving audit history.
CREATE UNIQUE INDEX "SaldoSnapshot_active_unique"
  ON "SaldoSnapshot" ("employeeId", "periodType", "periodStart")
  WHERE "superseded" = false;
