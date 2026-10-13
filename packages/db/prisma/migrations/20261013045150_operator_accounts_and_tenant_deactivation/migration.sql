-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "deactivatedAt" TIMESTAMPTZ,
ADD COLUMN     "deactivatedByOperatorId" TEXT,
ADD COLUMN     "deactivatedReason" TEXT;

-- CreateTable
CREATE TABLE "OperatorAccount" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "totpSecretEnc" TEXT,
    "totpEnabledAt" TIMESTAMPTZ,
    "lastTotpStep" INTEGER,
    "recoveryCodeHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ,
    "lastFailedLoginAt" TIMESTAMPTZ,
    "lastLoginAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "OperatorAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatorAuditLog" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT,
    "action" TEXT NOT NULL,
    "subjectTenantId" TEXT,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "oldValue" JSONB,
    "newValue" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperatorAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OperatorAccount_email_key" ON "OperatorAccount"("email");

-- CreateIndex
CREATE INDEX "OperatorAuditLog_operatorId_idx" ON "OperatorAuditLog"("operatorId");

-- CreateIndex
CREATE INDEX "OperatorAuditLog_subjectTenantId_createdAt_idx" ON "OperatorAuditLog"("subjectTenantId", "createdAt");

-- CreateIndex
CREATE INDEX "OperatorAuditLog_createdAt_idx" ON "OperatorAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "Tenant_deactivatedAt_idx" ON "Tenant"("deactivatedAt");

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_deactivatedByOperatorId_fkey" FOREIGN KEY ("deactivatedByOperatorId") REFERENCES "OperatorAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorAuditLog" ADD CONSTRAINT "OperatorAuditLog_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "OperatorAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

