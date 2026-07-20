-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "bsSlotBlockWeekMinutes" INTEGER,
ADD COLUMN     "bsSlotFirstLongDayMinutes" INTEGER,
ADD COLUMN     "bsSlotSecondLongDayMinutes" INTEGER,
ADD COLUMN     "bsSlotShortDayMinutes" INTEGER;

-- AlterTable
ALTER TABLE "EmployeeVocationalSchoolPattern" ADD COLUMN     "bsSlotBlockWeekMinutes" INTEGER,
ADD COLUMN     "bsSlotFirstLongDayMinutes" INTEGER,
ADD COLUMN     "bsSlotSecondLongDayMinutes" INTEGER,
ADD COLUMN     "bsSlotShortDayMinutes" INTEGER;

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "bsSlotBlockWeekMinutes" INTEGER,
ADD COLUMN     "bsSlotFirstLongDayMinutes" INTEGER,
ADD COLUMN     "bsSlotSecondLongDayMinutes" INTEGER,
ADD COLUMN     "bsSlotShortDayMinutes" INTEGER;
