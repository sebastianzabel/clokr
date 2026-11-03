-- AlterTable
ALTER TABLE "TerminalApiKey" ADD COLUMN     "salonId" TEXT;

-- CreateIndex
CREATE INDEX "TerminalApiKey_salonId_idx" ON "TerminalApiKey"("salonId");

-- AddForeignKey
ALTER TABLE "TerminalApiKey" ADD CONSTRAINT "TerminalApiKey_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "Salon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

