-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "annualVacationDays" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "defaultApprenticeVacationDays" DECIMAL(5,2) NOT NULL DEFAULT 20;

