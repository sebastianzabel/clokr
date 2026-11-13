/**
 * Issue #836 (D-836-04) — what the leave limits count, stated once.
 *
 * `LEAVE_LIMIT_COUNTED_CODES` is an ALLOW-list: a leave type counts toward a salon's parallel-leave
 * limit only when it is named here. Sick leave (SICK, SICK_CHILD) is not named and therefore never
 * counts; a new `LeaveTypeCode` does not count until someone adds it on purpose. It is never derived
 * by excluding the sick codes. `Absence` rows (imposed absences) are never read at all.
 *
 * This file carries no runtime import except the zero-import leaf `effective-leave-statuses`, so the
 * kernel can never join the absence/scheduling/time-tracking/working-time-account import cycle
 * (`measure-context-boundary-imports.ts --cycles --check 22`).
 */
import type { LeaveTypeCode } from "@clokr/db";
import { EFFECTIVE_LEAVE_STATUSES } from "../effective-leave-statuses";

/** Leave type codes that count toward a limit (allow-list, D-836-04). */
export const LEAVE_LIMIT_COUNTED_CODES = [
  "VACATION",
  "OVERTIME_COMP",
  "SPECIAL",
  "UNPAID",
  "EDUCATION",
] as const satisfies readonly LeaveTypeCode[];

/** Request statuses that count: the effective ones plus PENDING (a wish is planned load too). */
export const LEAVE_LIMIT_COUNTED_STATUSES = ["PENDING", ...EFFECTIVE_LEAVE_STATUSES] as const;

/** Membership check against the allow-list; takes a plain string because callers hold one. */
export function isLeaveLimitCountedCode(code: string): boolean {
  return (LEAVE_LIMIT_COUNTED_CODES as readonly string[]).includes(code);
}

/** Control code of the 409 on approval / correction over a limit (used from 836-04). */
export const LEAVE_LIMIT_EXCEPTION_REQUIRED = "LEAVE_LIMIT_EXCEPTION_REQUIRED";

/** Longest window the load read serves, in days (used from 836-05). */
export const LEAVE_LIMIT_LOAD_MAX_DAYS = 92;
