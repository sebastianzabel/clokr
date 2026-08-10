-- AlterTable
ALTER TABLE "TimeEntry" ADD COLUMN     "retroRequestId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "TimeEntry_retroRequestId_key" ON "TimeEntry"("retroRequestId");

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_retroRequestId_fkey" FOREIGN KEY ("retroRequestId") REFERENCES "RetroEntryRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

