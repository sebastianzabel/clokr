/**
 * Issue #835 (D-835-10/23/31/34, AC-6) — the planner's "Urlaub" figure per day, read from the SAME
 * kernel the leave limits use. Nothing is counted here: `leaveLimitLoadView` folds the stored
 * leave (PENDING and effective requests, the counted-type allow-list, the Stammsalon per day, the
 * person's own workdays) and the wishes as candidates through `parallelLeaveLoad`; this file only
 * reads the `ALL` group's count of each day and, for a reader with the limit reach, the rule
 * facts (name, maximum, exceeded) of every group that has a rule on that day.
 *
 * A wish is a candidate with `requestId: null` and the type `VACATION`; a wish already taken over
 * is not passed in (its request counts instead), so nothing counts twice. A day exists in the
 * answer when somebody counts on it, with or without a rule. Without `showLimits` the rule data
 * never leaves this function: `limits` is `null` and the count alone is served.
 *
 * Deliberately NOT re-exported from `contexts/absence/index.ts` (import-cycle cap 22).
 */
import type { FastifyInstance } from "fastify";
import { leaveLimitLoadView } from "../leave-limits/load-view";

/** One day of the planner with at least one person on counted leave (or wished leave). */
export type PlannerDay = {
  day: string;
  count: number;
  limits: Array<{
    ruleId: string;
    ruleName: string | null;
    groupKey: string;
    max: number;
    count: number;
    exceeded: boolean;
  }> | null;
};

export async function plannerDayLoad(
  db: FastifyInstance["prisma"],
  input: {
    tenantId: string;
    salonId: string;
    year: number;
    /** The active, not-taken-over wishes of the plan population (any open plan of the year). */
    wishes: ReadonlyArray<{ employeeId: string; startDay: string; endDay: string }>;
    /** True for a reader with the manage or approve reach over the salon (D-835-31). */
    showLimits: boolean;
  },
): Promise<PlannerDay[]> {
  const view = await leaveLimitLoadView(db, input.tenantId, {
    salonIds: [input.salonId],
    fromDay: `${input.year}-01-01`,
    toDay: `${input.year}-12-31`,
    candidates: input.wishes.map((wish) => ({
      requestId: null,
      employeeId: wish.employeeId,
      typeCode: "VACATION",
      startDay: wish.startDay,
      endDay: wish.endDay,
    })),
    includeAllGroup: true,
  });

  const groups = view.salons.find((salon) => salon.salonId === input.salonId)?.groups ?? [];
  const all = groups.find((group) => group.groupKey === "ALL");
  if (!all) return [];

  return all.days
    .filter((day) => day.count > 0)
    .map((day) => ({
      day: day.day,
      count: day.count,
      limits: input.showLimits
        ? groups.flatMap((group) => {
            const groupDay = group.days.find((d) => d.day === day.day);
            if (!groupDay || groupDay.ruleId === null || groupDay.max === null) return [];
            return [
              {
                ruleId: groupDay.ruleId,
                ruleName: groupDay.ruleName,
                groupKey: group.groupKey,
                max: groupDay.max,
                count: groupDay.count,
                exceeded: groupDay.exceeded,
              },
            ];
          })
        : null,
    }));
}
