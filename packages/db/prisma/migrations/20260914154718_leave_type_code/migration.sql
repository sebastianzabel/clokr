-- CreateEnum
CREATE TYPE "LeaveTypeCode" AS ENUM ('VACATION', 'OVERTIME_COMP', 'SPECIAL', 'UNPAID', 'SICK', 'SICK_CHILD', 'EDUCATION', 'MATERNITY', 'PARENTAL');

-- AlterTable
ALTER TABLE "LeaveType" ADD COLUMN     "code" "LeaveTypeCode";

