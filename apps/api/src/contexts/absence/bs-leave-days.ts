// Issue #448 — a Berufsschultag (vocational-school day) can never be a leave day.
//
// Legal basis: § 15 BBiG — the trainee is released from work for vocational-school
// instruction; the employer cannot discharge that instruction obligation by granting leave
// over it. § 19 Abs. 3 JArbSchG additionally steers a minor's leave into the school
// holidays. Owner decision on Issue #448 (01.10.2026) + the implementation decisions comment
// of 02.10.2026: ONE place removes BS dates from a leave request's priced day count
// (resolveLeaveDays in ./leave-days.ts, D-02); this module owns only the rule itself — what
// counts as a Berufsschultag, which leave types it displaces, and the rejection text/code.
//
// D-01: "Berufsschultag" = every non-deleted `Absence` of type `VOCATIONAL_SCHOOL`,
// regardless of `source` (PATTERN from the generator, or MANUAL from the one-off endpoint),
// read through the canonical A6 facade reader `getVocationalSchoolDays()`
// (contexts/absence/facade/absences.ts). This is a DIFFERENT, intentionally wider scope than
// `isBsAbsence()` in working-time-account/close-employee-month.ts, which stays PATTERN-only
// for its own, unrelated purpose (the absence-loop carve-out) — see that function's doc
// comment for the pointer back here.

import { FastifyInstance } from "fastify";
import { Prisma } from "@clokr/db";
import { type EmployeeScope } from "../platform";
import { getVocationalSchoolDays } from "./facade/absences";

// Prisma client shape shared by `app.prisma` (top-level) and a `$transaction` tx handle —
// mirrors leave-days.ts's own private DbClient alias (not exported there, so repeated here;
// plan 02's correction-booking runs this inside a transaction and needs the same union).
type DbClient = FastifyInstance["prisma"] | Prisma.TransactionClient;

/** The owner's exact rejection text (Issue #448, binding comment 01.10.2026) — copied
 * byte-for-byte, en dash U+2013, no surrounding quotes. Never used as a control value by
 * itself; pair with {@link BS_ONLY_LEAVE_ERROR_CODE} for branching (CLAUDE.md: never use a
 * new display string as a control value). */
export const BS_ONLY_LEAVE_ERROR =
  "An Berufsschultagen kann kein Urlaub genommen werden – der Azubi ist für den Unterricht freigestellt.";

/** The control value POST/PUT/PATCH leave handlers and their tests branch on — never the
 * German text above (CLAUDE.md). */
export const BS_ONLY_LEAVE_ERROR_CODE = "VOCATIONAL_SCHOOL_DAY";

/** Display-only label for a BS date inside an otherwise-priced leave range (D-05, consumed by
 * plan 03's request dialog preview and Beleg list) — never compared against, only rendered. */
export const BS_NO_LEAVE_LABEL = "Berufsschule – kein Urlaub";

/**
 * D-02: a Berufsschultag displaces a leave day only for `VACATION` (request mode) — SICK,
 * SPECIAL, OVERTIME_COMP and every other leave type price exactly as before. An Azubi who
 * falls ill on a school day must still be able to report it; nothing in § 15 BBiG / § 19
 * Abs. 3 JArbSchG speaks to involuntary absence types. The saldo rule (D-03, see
 * close-employee-month.ts) is separate and type-agnostic — it reduces Soll once for ANY
 * leave type that lands on a BS date, because that invariant is about Soll, not about which
 * leave type "won" the day.
 */
export function vocationalSchoolDisplacesLeave(leaveTypeCode: string | null | undefined): boolean {
  return leaveTypeCode === "VACATION";
}

/**
 * D-01: the set of Berufsschultag dates (UTC `YYYY-MM-DD`, the same key format `holidays`
 * Sets and both pricing kernels already use) for `employeeId` inside `[start, end]`
 * (inclusive), read through the canonical A6 facade reader — no second query shape. `db` is
 * typed to accept a `$transaction` tx handle (see {@link DbClient}) so plan 02's correction
 * booking can call this from inside its own transaction.
 */
export async function vocationalSchoolDateSet(
  db: DbClient,
  employeeId: string,
  tenantId: string,
  start: Date,
  end: Date,
): Promise<Set<string>> {
  const scope: EmployeeScope = { kind: "employee", employeeId, tenantId };
  const rows = await getVocationalSchoolDays(db, scope, start, end);
  return new Set(rows.map((r) => r.startDate.toISOString().slice(0, 10)));
}
