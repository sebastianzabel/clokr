-- CreateTable
CREATE TABLE "AccessRole" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "permissions" TEXT[],
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "AccessRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccessRole_tenantId_idx" ON "AccessRole"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AccessRole_tenantId_nameKey_key" ON "AccessRole"("tenantId", "nameKey");

-- AddForeignKey
ALTER TABLE "AccessRole" ADD CONSTRAINT "AccessRole_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
