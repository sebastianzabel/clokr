-- AlterTable
ALTER TABLE "CoverageRule" ADD COLUMN     "salonId" TEXT;

-- CreateIndex
CREATE INDEX "CoverageRule_salonId_idx" ON "CoverageRule"("salonId");

-- AddForeignKey
ALTER TABLE "CoverageRule" ADD CONSTRAINT "CoverageRule_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "Salon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

