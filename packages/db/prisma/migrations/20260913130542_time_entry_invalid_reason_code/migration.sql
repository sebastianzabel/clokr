-- CreateEnum
CREATE TYPE "InvalidReasonCode" AS ENUM ('MISSING_CLOCK_OUT', 'LEAVE_CANCELLATION_PENDING', 'RETRO_APPROVAL_PENDING', 'LEGACY_UNMAPPED');

-- AlterTable
ALTER TABLE "TimeEntry" ADD COLUMN     "invalidReasonCode" "InvalidReasonCode";


-- Phase 96 (AC-3) — re-encode the meaning of existing rows into the new code column.
-- This is a re-encoding, not a deletion: invalidReason keeps its text, AuditLog is untouched (D-10).
-- The third statement writes the en dash as U&'\2013' rather than as a literal character, so the
-- mapping cannot be silently broken by file encoding, a copy-paste, or an editor's dash
-- autocorrection (D-06).
UPDATE "TimeEntry" SET "invalidReasonCode" = 'MISSING_CLOCK_OUT'
  WHERE "invalidReason" = 'Ausstempeln fehlt';
UPDATE "TimeEntry" SET "invalidReasonCode" = 'LEAVE_CANCELLATION_PENDING'
  WHERE "invalidReason" = 'Urlaubsstornierung ausstehend';
UPDATE "TimeEntry" SET "invalidReasonCode" = 'RETRO_APPROVAL_PENDING'
  WHERE "invalidReason" = 'Nachtrag ' || U&'\2013' || ' Genehmigung ausstehend';
-- Catch-all LAST: anything still uncoded but non-null keeps its own text under LEGACY_UNMAPPED,
-- so no row with a meaning is left without a code. Ordering matters — this must not run first.
UPDATE "TimeEntry" SET "invalidReasonCode" = 'LEGACY_UNMAPPED'
  WHERE "invalidReason" IS NOT NULL AND "invalidReasonCode" IS NULL;
