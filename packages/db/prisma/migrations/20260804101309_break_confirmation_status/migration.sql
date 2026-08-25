-- CreateEnum
CREATE TYPE "BreakStatus" AS ENUM ('AUTO', 'CONFIRMED', 'WAIVED');

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "blockMonthCloseOnUnconfirmedBreak" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "enforceBreakConfirmation" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TimeEntry" ADD COLUMN     "breakStatus" "BreakStatus" NOT NULL DEFAULT 'CONFIRMED',
ADD COLUMN     "breakWaivedReason" TEXT;

