-- DropIndex
DROP INDEX "TimeEntry_employeeId_date_idx";
-- CreateIndex (partial unique — Prisma schema cannot express the WHERE clause)
CREATE UNIQUE INDEX "TimeEntry_employeeId_date_unique_not_deleted"
  ON "TimeEntry"("employeeId", "date")
  WHERE "deletedAt" IS NULL;
