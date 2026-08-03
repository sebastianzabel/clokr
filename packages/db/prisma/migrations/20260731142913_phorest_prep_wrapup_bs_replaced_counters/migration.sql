-- AlterTable
ALTER TABLE "PhorestSyncRun" ADD COLUMN     "replaced" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "skippedVocationalSchool" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "phorestPrepMinutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "phorestWrapupMinutes" INTEGER NOT NULL DEFAULT 0;

