-- CreateTable
CREATE TABLE "SupportAccess" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "endedAt" TIMESTAMPTZ,
    "endedBy" TEXT,
    "endedByUserId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupportAccess_tenantId_startedAt_idx" ON "SupportAccess"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "SupportAccess_operatorId_tenantId_idx" ON "SupportAccess"("operatorId", "tenantId");

-- AddForeignKey
ALTER TABLE "SupportAccess" ADD CONSTRAINT "SupportAccess_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAccess" ADD CONSTRAINT "SupportAccess_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "OperatorAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

