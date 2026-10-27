/**
 * Issue #780 - THE one rule for a month without an agreed contract.
 *
 * A month for which no `WorkSchedule` is valid at its end (`validFrom <= monthEnd`) has no agreed
 * working time, hence no owed time (§ 611a BGB): it carries NO Soll and adds NO saldo. This is the
 * rule the report rows have applied since Issue #451 (D-01, an "unlabelled" month); the live chain
 * and the Monatsabschluss writers used to charge the tenant-default Soll for such a month instead
 * (`getEffectiveSchedule()` falls back to `TenantConfig`), so a person whose `hireDate` lies before
 * the first `validFrom` showed -298 h as closing saldo next to -154 h in the month rows.
 *
 * Every caller that feeds `closeEmployeeMonth()` (live chain, manual close, cron close, recalc,
 * week progress) resolves the month's contract through {@link resolveMonthContract}; the core turns
 * the {@link NO_CONTRACT_SCHEDULE} marker into a zero-Soll month that moves no balance.
 *
 * Closed months are never rewritten: the stored `SaldoSnapshot` rows keep their figures, only months
 * that are still open or are closed from now on follow the rule. `scripts/audit-780-hire-before-contract.ts`
 * lists the persons it concerns (read-only).
 */
import type { FastifyInstance } from "fastify";
import { getEffectiveSchedule } from "../time-tracking";

/** Zero-hour marker contract: Soll 0 on every day; `closeEmployeeMonth()` also keeps the balance at 0. */
export const NO_CONTRACT_SCHEDULE = {
  type: "FIXED_SCHEDULE" as const,
  weeklyHours: 0,
  monthlyHours: null,
  mondayHours: 0,
  tuesdayHours: 0,
  wednesdayHours: 0,
  thursdayHours: 0,
  fridayHours: 0,
  saturdayHours: 0,
  sundayHours: 0,
  workDays: [] as number[],
  overtimeThreshold: 60,
  allowOvertimePayout: false,
  overtimeMode: "CARRY_FORWARD" as const,
  noContract: true as const,
};

export function isNoContractSchedule(schedule: unknown): boolean {
  return (
    typeof schedule === "object" &&
    schedule !== null &&
    (schedule as { noContract?: unknown }).noContract === true
  );
}

/**
 * The contract of a month, or {@link NO_CONTRACT_SCHEDULE} when none is valid at `monthEnd`.
 * `scheduleAt` is the instant the contract row itself is read at - the report and live paths use
 * the month's end, the close paths their historical mid-month convention; only the question
 * "is there a contract at all in this month" is always judged at `monthEnd`.
 */
export async function resolveMonthContract(
  app: FastifyInstance,
  employeeId: string,
  monthEnd: Date,
  scheduleAt: Date = monthEnd,
) {
  const anyContract = await app.prisma.workSchedule.findFirst({
    where: { employeeId, validFrom: { lte: monthEnd } },
    select: { id: true },
  });
  if (!anyContract) return NO_CONTRACT_SCHEDULE;
  return getEffectiveSchedule(app, employeeId, scheduleAt);
}
