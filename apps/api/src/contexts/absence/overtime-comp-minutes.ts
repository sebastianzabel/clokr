/**
 * Issue #468 (D-01/D-02) — the ONE Überstundenausgleich amount: `scheduledLeaveMinutes` prices a
 * request range, `overtimeCompReversalMinutes` decides what a reversal gives back (the STORED
 * booking, never a recomputation; only a legacy row without a stored value is recomputed).
 *
 * Issue #614: moved out of `api/leave.ts` so the exit path in `employment-exit.ts` reuses the one
 * rule instead of copying it. The function bodies are moved verbatim.
 *
 * Deliberately NOT re-exported from `contexts/absence/index.ts` (import-cycle cap 22): the
 * importers are `api/leave.ts` and `employment-exit.ts`, both inside this context.
 */
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import { contractWorkDaysPerWeekFrom, usualWorkDaysFrom } from "./leave-days";
import { shiftBasedLeaveMinutesForRequest } from "./vacation-calc";
import { vocationalSchoolDateSet } from "./bs-leave-days";
import { calcLeaveAbsenceMinutesTz } from "../working-time-account";

type DbClient = FastifyInstance["prisma"] | Prisma.TransactionClient;

/**
 * Issue #468 (D-01) — the ONE function behind every Überstundenausgleich amount: the POST/PATCH
 * negative-balance gate, the approval booking, the cancellation-reversal legacy fallback, the
 * `/correct` reverse/apply pair, and GET /hours-preview all call this, never a second formula.
 *
 * SHIFT_BASED keeps the #293/#429 "receipt follows the account" branch verbatim — do not route
 * it through `calcLeaveAbsenceMinutesTz` (that function's own SHIFT_BASED branch is a DIFFERENT,
 * already-correct formula per #429, see its own docblock).
 *
 * Every other schedule type calls `calcLeaveAbsenceMinutesTz` below — the Arbeitszeitkonto's own
 * per-row credit/withdrawal function (`close-employee-month.ts` uses the SAME call for the
 * saldo's non-SHIFT leave credit, #220 model B) — reached through the
 * `contexts/working-time-account` facade, never a local `{day}Hours` placeholder read. This is
 * what makes a FLEXTIME day cost the real Ø-Methode average (480 min, not the measured
 * placeholder's 60) and keeps MONTHLY_HOURS following whatever the Arbeitszeitkonto returns
 * (hard 0 until Phase 433 merges, a real rate afterward) rather than a number hardcoded here.
 *
 * Holidays AND Berufsschultage are excluded exactly like the saldo's own `excludeHolidays` set
 * (#448 D-03) — an Azubi's Ausgleichstag on a school day costs nothing, mirroring the saldo,
 * which never withdraws for that day either.
 */
export async function scheduledLeaveMinutes(
  db: DbClient,
  employeeId: string,
  tenantId: string,
  start: Date,
  end: Date,
  halfDay: boolean,
  holidays: Set<string>,
  tz: string,
): Promise<number> {
  const employee = await db.employee.findUnique({
    where: { id: employeeId },
    include: {
      workSchedules: {
        where: { validFrom: { lte: start } },
        orderBy: { validFrom: "desc" },
        take: 1,
      },
    },
  });
  const ws = employee?.workSchedules[0] ?? null;
  const cfg = await db.tenantConfig.findUnique({ where: { tenantId } });

  // SHIFT_BASED (issue #293/#429): the receipt follows the account — see the docblock above.
  // Returns BEFORE the saldo-facade path below, which stays untouched for every other type.
  if (ws?.type === "SHIFT_BASED") {
    // Issue #429, D-13: `c` via the SAME fallback chain the saldo uses (Phase 107, D-04) —
    // `contractWorkDaysPerWeek` -> `workDays.length` -> tenant `defaultWorkDays.length` -> 5.
    const c = contractWorkDaysPerWeekFrom(ws, cfg?.defaultWorkDays);

    // `shiftBasedLeaveMinutesForRequest` is timezone-free (it operates on calendar `Date`
    // boundaries via `leaveDaysPerWeek`, like the saldo's `shiftBasedLeaveCreditByDate`) and,
    // mirroring `close-employee-month.ts`'s D-05 decision, is never given a holiday set — a
    // holiday inside a leave range keeps being a Soll-free day via the leave itself. Phase 436
    // (D-03): the Angabe follows the receipt through the same `usualWorkDaysFrom()` reader.
    return shiftBasedLeaveMinutesForRequest(ws, start, end, halfDay, c, usualWorkDaysFrom(ws));
  }

  // Issue #468 (D-01): the WorkSchedule row when present, else the tenant-default
  // FIXED_SCHEDULE shape — mirrors `getEffectiveSchedule()`'s shape (entry-invariants.ts), not
  // imported (that helper takes `app`, a time-tracking module this file does not reach into).
  const schedule =
    ws ??
    ({
      type: "FIXED_SCHEDULE" as const,
      weeklyHours: cfg?.defaultWeeklyHours ?? 40,
      monthlyHours: null,
      mondayHours: cfg?.defaultMondayHours ?? 8,
      tuesdayHours: cfg?.defaultTuesdayHours ?? 8,
      wednesdayHours: cfg?.defaultWednesdayHours ?? 8,
      thursdayHours: cfg?.defaultThursdayHours ?? 8,
      fridayHours: cfg?.defaultFridayHours ?? 8,
      saturdayHours: cfg?.defaultSaturdayHours ?? 0,
      sundayHours: cfg?.defaultSundayHours ?? 0,
    } as const);

  // Issue #468 (D-01, mirrors #448 D-03): a Berufsschultag is excluded exactly like a holiday —
  // the saldo never withdraws Soll for either inside a leave range, so the booking must not
  // either.
  const excluded = new Set<string>([
    ...holidays,
    ...(await vocationalSchoolDateSet(db, employeeId, tenantId, start, end)), // Issue #468 (D-01)
  ]);

  return calcLeaveAbsenceMinutesTz(schedule, start, end, tz, {
    halfDay,
    excludeHolidays: excluded,
    // Phase 433 (D-05) — the MONTHLY_HOURS workday tier, same as the saldo: a WorkSchedule
    // with no explicit workDays falls through to the tenant's defaultWorkDays before Mo-Fr.
    // Every other schedule type ignores this opt.
    defaultWorkDays: cfg?.defaultWorkDays ?? null,
  });
}

/**
 * Issue #468 (A-4/D-02) — the amount an Überstundenausgleich reversal gives back. A stored
 * booking (`overtimeCompMinutes`) is reversed by exactly that value ("stored"): a schedule edited
 * after approval must not change what gets reversed. Only a legacy row with no stored value falls
 * back to today's recomputation ("recomputed"), for which `recomputeInputs` supplies the holiday
 * set and the tenant time zone lazily. Does NOT log — the caller keeps its own warn line
 * for the recomputed case.
 */
export async function overtimeCompReversalMinutes(
  db: DbClient,
  tenantId: string,
  row: {
    employeeId: string;
    startDate: Date;
    endDate: Date;
    halfDay: boolean;
    overtimeCompMinutes: number | null;
  },
  recomputeInputs: () => Promise<{ holidays: Set<string>; tz: string }>,
): Promise<{ minutes: number; source: "stored" | "recomputed" }> {
  if (row.overtimeCompMinutes != null) {
    return { minutes: row.overtimeCompMinutes, source: "stored" };
  }
  // Only the legacy fallback needs holidays and the time zone, so they are read lazily.
  const { holidays, tz } = await recomputeInputs();
  const minutes = await scheduledLeaveMinutes(
    db,
    row.employeeId,
    tenantId,
    row.startDate,
    row.endDate,
    row.halfDay,
    holidays,
    tz,
  );
  return { minutes, source: "recomputed" };
}
