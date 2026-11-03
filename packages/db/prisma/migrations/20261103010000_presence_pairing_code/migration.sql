-- CreateEnum
CREATE TYPE "PresencePairedVia" AS ENUM ('MANUAL', 'QR');

-- AlterTable
ALTER TABLE "PresenceDevice" ADD COLUMN     "lastSeenAt" TIMESTAMPTZ,
ADD COLUMN     "pairedVia" "PresencePairedVia" NOT NULL DEFAULT 'MANUAL';

-- CreateTable
CREATE TABLE "PresencePairingCode" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "presenceSourceId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "mac" TEXT NOT NULL,
    "hostname" TEXT,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "consumedAt" TIMESTAMPTZ,
    "consumedByUserId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PresencePairingCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PresencePairingCode_codeHash_key" ON "PresencePairingCode"("codeHash");

-- CreateIndex
CREATE INDEX "PresencePairingCode_tenantId_mac_idx" ON "PresencePairingCode"("tenantId", "mac");

-- CreateIndex
CREATE INDEX "PresencePairingCode_createdAt_idx" ON "PresencePairingCode"("createdAt");

-- CreateIndex
CREATE INDEX "PresencePairingCode_consumedByUserId_idx" ON "PresencePairingCode"("consumedByUserId");

-- AddForeignKey
ALTER TABLE "PresencePairingCode" ADD CONSTRAINT "PresencePairingCode_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresencePairingCode" ADD CONSTRAINT "PresencePairingCode_presenceSourceId_fkey" FOREIGN KEY ("presenceSourceId") REFERENCES "PresenceSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

