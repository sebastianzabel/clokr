-- File 1 of 2 (Phase 98b, D-02). Adds both new LeaveTypeCode values and NOTHING else.
-- This MUST stay its own migration file: PostgreSQL forbids using a newly added enum value
-- inside the transaction that added it ("unsafe use of new value ... New enum values must be
-- committed before they can be used"). File 2 retypes Absence.type onto LeaveTypeCode.
-- Measured: prisma migrate deploy applies each migration file in its OWN committed transaction,
-- so both files may be pending at the same time and applied in a single deploy invocation.
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LeaveTypeCode" ADD VALUE 'VOCATIONAL_SCHOOL';
ALTER TYPE "LeaveTypeCode" ADD VALUE 'OTHER';

