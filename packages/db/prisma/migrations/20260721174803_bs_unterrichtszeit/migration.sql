-- AlterTable
ALTER TABLE "Absence" ADD COLUMN     "unterrichtsMinutes" INTEGER;

-- AlterTable
ALTER TABLE "EmployeeVocationalSchoolPattern" ADD COLUMN     "unterrichtsMinutenByDow" JSONB NOT NULL DEFAULT '{}';
