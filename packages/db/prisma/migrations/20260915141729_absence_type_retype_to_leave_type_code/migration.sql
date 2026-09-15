-- File 2 of 2 (Phase 98b, D-02). Retypes Absence.type onto LeaveTypeCode and drops the
-- now-unused AbsenceType enum. Must be a SEPARATE migration file from File 1
-- (..._leave_type_code_add_absence_values): PostgreSQL forbids using a newly added enum value
-- inside the transaction that added it.
--
-- HAND-AUTHORED, deliberately NOT `prisma migrate diff` output. The tool-generated diff for this
-- exact change emits `ALTER TABLE "Absence" DROP COLUMN "type", ADD COLUMN "type" "LeaveTypeCode"
-- NOT NULL` — it drops and recreates the column, discarding every row's value, and fails outright
-- on non-empty data ("column type of relation Absence contains null values"). The USING-cast form
-- below retypes the column IN PLACE. Do not regenerate this file with the diff tool.
--
-- The CASE performs the one-time spelling correction for the two values whose AbsenceType name
-- differed from its LeaveTypeCode counterpart (SPECIAL_LEAVE -> SPECIAL, UNPAID_LEAVE -> UNPAID).
-- The other six values are byte-identical strings on both sides and need no mapping.
ALTER TABLE "Absence"
  ALTER COLUMN "type" TYPE "LeaveTypeCode"
  USING (
    CASE "type"::text
      WHEN 'SPECIAL_LEAVE' THEN 'SPECIAL'
      WHEN 'UNPAID_LEAVE' THEN 'UNPAID'
      ELSE "type"::text
    END
  )::"LeaveTypeCode";

-- The @@unique([employeeId, startDate, type]) index (Absence_employeeId_startDate_type_key) is
-- rebuilt automatically by ALTER COLUMN ... TYPE — verified: same name, same columns, still
-- UNIQUE, in the same transaction. No manual DROP/CREATE INDEX is needed or wanted.
DROP TYPE "AbsenceType";
