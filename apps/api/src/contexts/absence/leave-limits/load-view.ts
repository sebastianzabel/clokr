/**
 * Issue #836 (D-836-14, AC-10, AC-12) — the daily load per salon and group, read from the SAME
 * kernel the warnings use. No second counting code: the stored leave goes through
 * `countedDaysOfLeave`, `groupMembershipOn` and `parallelLeaveLoad`, the rule per group and day is
 * `strictestRulesOn`. Only the request behind each counted person-day is indexed on the side, to
 * name the neutral "approved before the rule" marker (D-836-11, D-836-18).
 *
 * The view lists the person ids behind a day; WHO of them a reader may be named is decided by the
 * route through `redact.ts`, never here. `personNames` is internal like in the checker result.
 */
import type { EmployeeClassification } from "@clokr/db";
import type { FastifyInstance } from "fastify";
import { EFFECTIVE_LEAVE_STATUSES } from "../effective-leave-statuses";
import { countedDaysOfLeave, eachDay } from "./counted-days";
import { groupMembershipOn } from "./group-membership";
import { loadAccessRoleNames, loadLeaveLimitFacts, type StoredLeaveRow } from "./load-facts";
import { parallelLeaveLoad, type CountedPersonDay } from "./parallel-leave-load";
import { groupKeyOf, ruleRowOf, strictestRulesOn, type LeaveLimitRuleRow } from "./rules";

type Db = FastifyInstance["prisma"];

export type LoadViewEntry = { personId: string; requestId: string; approvedBeforeRule: boolean };

export type LoadViewDay = {
  day: string;
  count: number;
  /** The strictest applicable maximum of that day; null when no rule of the group applies on it. */
  max: number | null;
  ruleId: string | null;
  ruleName: string | null;
  exceeded: boolean;
  entries: LoadViewEntry[];
};

export type LoadViewGroup = {
  groupKey: string;
  groupKind: "ALL" | "CLASSIFICATION" | "ACCESS_ROLE";
  classification: EmployeeClassification | null;
  accessRoleId: string | null;
  accessRoleName: string | null;
  days: LoadViewDay[];
};

export type LoadView = {
  salons: Array<{ salonId: string; groups: LoadViewGroup[] }>;
  /** Internal: first and last name per person id; the route redacts it by reach before serialising. */
  personNames: Map<string, { firstName: string; lastName: string }>;
};

const EFFECTIVE = new Set<string>(EFFECTIVE_LEAVE_STATUSES);

/** True iff the stored rule window intersects the requested window (both inclusive). */
function windowIntersects(rule: LeaveLimitRuleRow, fromDay: string, toDay: string): boolean {
  if (rule.validFrom !== null && rule.validFrom > toDay) return false;
  if (rule.validUntil !== null && rule.validUntil < fromDay) return false;
  return true;
}

/**
 * A request counts as "approved before the rule" for the strictest rule of its day when it was
 * approved (an effective status, `reviewedAt` set) before that rule took its current form: rules are
 * edited in place (D-836-02), so `updatedAt` stands for the last create or edit (D-836-11). `reviewedAt` is the
 * approval stamp; a rejected cancellation overwrites it (D-836-18, documented limit).
 */
function approvedBefore(row: StoredLeaveRow, rule: LeaveLimitRuleRow): boolean {
  return EFFECTIVE.has(row.status) && row.reviewedAt !== null && row.reviewedAt < rule.updatedAt;
}

export async function leaveLimitLoadView(
  db: Db,
  tenantId: string,
  input: { salonIds: readonly string[]; fromDay: string; toDay: string },
): Promise<LoadView> {
  const empty = (): LoadView => ({ salons: [], personNames: new Map() });
  const { fromDay, toDay } = input;
  if (input.salonIds.length === 0 || fromDay > toDay) return empty();

  // 1. No rule that can matter inside the window, nothing to show (and no fact read).
  const ruleRecords = await db.leaveLimitRule.findMany({ where: { tenantId, deletedAt: null } });
  const rules = ruleRecords.map(ruleRowOf).filter((r) => windowIntersects(r, fromDay, toDay));
  const salonRules = new Map(
    input.salonIds.map(
      (salonId) =>
        [salonId, rules.filter((r) => r.salonId === null || r.salonId === salonId)] as const,
    ),
  );
  if ([...salonRules.values()].every((list) => list.length === 0)) return empty();

  // 2. Facts of everyone with stored counted leave in the window (no candidate).
  const facts = await loadLeaveLimitFacts(db, tenantId, {
    fromDay,
    toDay,
    personIds: [],
    excludeRequestIds: [],
    needsAccessRoles: rules.some((r) => r.groupKind === "ACCESS_ROLE"),
  });

  // 3. Person-day rows through the kernel; the requests behind a person-day are indexed on the side.
  const window = { fromDay, toDay };
  const personDays: CountedPersonDay[] = [];
  const requestsBehind = new Map<string, StoredLeaveRow[]>();
  for (const row of facts.storedRows) {
    const person = facts.persons.get(row.personId);
    if (!person) continue;
    for (const { day, salonId } of countedDaysOfLeave(person, row, window)) {
      personDays.push({
        personId: row.personId,
        requestId: row.requestId,
        day,
        salonId,
        groups: groupMembershipOn(person, day),
      });
      const key = `${salonId}|${day}|${row.personId}`;
      const list = requestsBehind.get(key);
      if (list) list.push(row);
      else requestsBehind.set(key, [row]);
    }
  }
  const load = parallelLeaveLoad(personDays);

  // 4. Per requested salon and per group with an applicable rule: the days with a count.
  const roleNames = await loadAccessRoleNames(db, tenantId, [
    ...new Set(rules.flatMap((r) => (r.accessRoleId ? [r.accessRoleId] : []))),
  ]);
  const windowDays = eachDay(fromDay, toDay);
  const personNames = new Map<string, { firstName: string; lastName: string }>();
  const salons: LoadView["salons"] = [];
  for (const salonId of input.salonIds) {
    const applicable = salonRules.get(salonId) ?? [];
    const byGroup = new Map<string, LeaveLimitRuleRow>();
    for (const rule of applicable) {
      const key = groupKeyOf(rule);
      if (!byGroup.has(key)) byGroup.set(key, rule);
    }
    const groups: LoadViewGroup[] = [];
    for (const [groupKey, sample] of [...byGroup.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      const byDay = load.get(salonId)?.get(groupKey);
      const days: LoadViewDay[] = [];
      for (const day of windowDays) {
        const persons = byDay?.get(day);
        if (!persons || persons.size === 0) continue;
        const rule = strictestRulesOn(applicable, salonId, day).get(groupKey) ?? null;
        const exceeded = rule !== null && persons.size > rule.maxPersons;
        const entries: LoadViewEntry[] = [...persons]
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
          .map((personId) => {
            const behind = requestsBehind.get(`${salonId}|${day}|${personId}`) ?? [];
            const before = exceeded ? behind.filter((row) => approvedBefore(row, rule!)) : [];
            const chosen = before[0] ?? behind[0];
            const name = facts.persons.get(personId);
            if (name)
              personNames.set(personId, { firstName: name.firstName, lastName: name.lastName });
            return {
              personId,
              requestId: chosen?.requestId ?? "",
              approvedBeforeRule: before.length > 0,
            };
          });
        days.push({
          day,
          count: persons.size,
          max: rule ? rule.maxPersons : null,
          ruleId: rule ? rule.id : null,
          ruleName: rule ? rule.name : null,
          exceeded,
          entries,
        });
      }
      groups.push({
        groupKey,
        groupKind: sample.groupKind,
        classification: sample.classification,
        accessRoleId: sample.accessRoleId,
        accessRoleName: sample.accessRoleId ? (roleNames.get(sample.accessRoleId) ?? null) : null,
        days,
      });
    }
    if (groups.length > 0) salons.push({ salonId, groups });
  }
  return { salons, personNames };
}
