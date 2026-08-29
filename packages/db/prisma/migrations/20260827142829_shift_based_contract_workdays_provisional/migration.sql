-- AlterTable
ALTER TABLE "LeaveRequest" ADD COLUMN     "daysProvisional" BOOLEAN;

-- AlterTable
ALTER TABLE "WorkSchedule" ADD COLUMN     "contractWorkDaysPerWeek" INTEGER;


-- Phase 107 (D-03) backfill — WorkSchedule.contractWorkDaysPerWeek for existing SHIFT_BASED rows.
--
-- WorkSchedule had no field for "how many days per week does this contract say" (issue #94), so
-- the admin form was structurally forced to guess a concrete weekday SET from a plain count,
-- silently overwriting the real distribution while the displayed number stayed the same. Every
-- pre-existing SHIFT_BASED row still had the correct COUNT, even where the guessed weekday SET was
-- wrong (that correction is Phase 108 / issue #95) — so deriving the new count from the existing
-- cardinality here changes no balance, entitlement or saldo value for any employee.
--
-- Scoped to SHIFT_BASED only (the only type this column is ever populated for, D-01) and to rows
-- not already populated, so this UPDATE is safe to reason about as a one-shot, idempotent backfill.
-- No backfill is written for LeaveRequest.daysProvisional — null is the correct value for every
-- pre-existing request, all of which were computed under the old, non-provisional regime.
UPDATE "WorkSchedule"
SET "contractWorkDaysPerWeek" = cardinality("workDays")
WHERE "type" = 'SHIFT_BASED' AND "contractWorkDaysPerWeek" IS NULL;
