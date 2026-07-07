-- CreateIndex
CREATE INDEX "AuditLog_purgeable_idx" ON "AuditLog"("purgeable");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "LeaveRequest_startDate_endDate_idx" ON "LeaveRequest"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "OtpToken_userId_idx" ON "OtpToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex (partial — hand-authored; Prisma cannot express WHERE clause)
CREATE INDEX "TimeEntry_employeeId_open_idx" ON "TimeEntry"("employeeId") WHERE "endTime" IS NULL;
