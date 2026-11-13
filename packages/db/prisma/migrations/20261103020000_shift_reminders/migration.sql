-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "reminderDayCloseOff" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reminderShiftEndOff" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reminderShiftStartOff" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "reminderDayCloseEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reminderDayCloseTime" VARCHAR(5) NOT NULL DEFAULT '20:00',
ADD COLUMN     "reminderOffsetMinutes" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "reminderShiftEndEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reminderShiftStartEnabled" BOOLEAN NOT NULL DEFAULT false;

