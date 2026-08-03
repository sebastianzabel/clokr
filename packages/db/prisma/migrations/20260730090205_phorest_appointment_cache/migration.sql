-- AlterTable
ALTER TABLE "PhorestSyncRun" ADD COLUMN     "appointmentError" TEXT,
ADD COLUMN     "appointmentsRemoved" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "appointmentsStored" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "phorestAppointmentHorizonDays" INTEGER NOT NULL DEFAULT 90;

-- CreateTable
CREATE TABLE "PhorestAppointment" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "externalId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhorestAppointment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PhorestAppointment_externalId_key" ON "PhorestAppointment"("externalId");

-- CreateIndex
CREATE INDEX "PhorestAppointment_employeeId_date_idx" ON "PhorestAppointment"("employeeId", "date");

-- CreateIndex
CREATE INDEX "PhorestAppointment_date_idx" ON "PhorestAppointment"("date");

-- AddForeignKey
ALTER TABLE "PhorestAppointment" ADD CONSTRAINT "PhorestAppointment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
