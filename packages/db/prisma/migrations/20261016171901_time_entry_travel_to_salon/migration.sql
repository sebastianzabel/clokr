-- AlterTable
ALTER TABLE "TimeEntry" ADD COLUMN     "travelToSalonId" TEXT;

-- CreateIndex
CREATE INDEX "TimeEntry_travelToSalonId_idx" ON "TimeEntry"("travelToSalonId");

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_travelToSalonId_fkey" FOREIGN KEY ("travelToSalonId") REFERENCES "Salon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

