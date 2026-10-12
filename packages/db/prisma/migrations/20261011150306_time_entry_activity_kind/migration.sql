-- CreateEnum
CREATE TYPE "ActivityKind" AS ENUM ('UNSPECIFIED', 'PRODUCTIVE', 'SETUP_CLEANING');

-- AlterTable
ALTER TABLE "TimeEntry" ADD COLUMN     "activityKind" "ActivityKind" NOT NULL DEFAULT 'UNSPECIFIED';

-- CreateTable
CREATE TABLE "TimeEntryActivityShare" (
    "id" TEXT NOT NULL,
    "timeEntryId" TEXT NOT NULL,
    "kind" "ActivityKind" NOT NULL,
    "minutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeEntryActivityShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TimeEntryActivityShare_timeEntryId_kind_key" ON "TimeEntryActivityShare"("timeEntryId", "kind");

-- AddForeignKey
ALTER TABLE "TimeEntryActivityShare" ADD CONSTRAINT "TimeEntryActivityShare_timeEntryId_fkey" FOREIGN KEY ("timeEntryId") REFERENCES "TimeEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

