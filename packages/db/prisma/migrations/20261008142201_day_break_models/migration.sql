-- CreateTable
CREATE TABLE "DayBreak" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startTime" TIMESTAMPTZ NOT NULL,
    "endTime" TIMESTAMPTZ NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ,
    "deletedBy" TEXT,

    CONSTRAINT "DayBreak_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DayBreakAck" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "reason" TEXT,
    "snapshot" JSONB NOT NULL,
    "acknowledgedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ,
    "deletedBy" TEXT,

    CONSTRAINT "DayBreakAck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DayBreak_employeeId_date_idx" ON "DayBreak"("employeeId", "date");

-- CreateIndex
CREATE INDEX "DayBreakAck_employeeId_date_idx" ON "DayBreakAck"("employeeId", "date");

-- AddForeignKey
ALTER TABLE "DayBreak" ADD CONSTRAINT "DayBreak_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DayBreakAck" ADD CONSTRAINT "DayBreakAck_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

