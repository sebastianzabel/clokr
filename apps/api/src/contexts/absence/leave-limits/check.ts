/**
 * Issue #836 (D-836-03, layer 3) — the checker: adds hypothetical candidate rows to the stored
 * ones and reports where a candidate pushes a salon group over a rule.
 *
 * It is the ONLY counting path of the leave limits. The request create, the approval, `/correct`
 * and the later #835 takeover (a wish is a candidate with `requestId: null`) all go through
 * `evaluateLeaveLimits`; nothing else counts parallel leave (`leave-limits-one-place-836.test.ts`).
 *
 * The module is deliberately NOT re-exported from `contexts/absence/index.ts` (D-836-21): it
 * imports `leave-days.ts` and the scheduling facade, and a re-export would grow the measured
 * import cycle (`measure-context-boundary-imports.ts --cycles --check 22`). Callers inside
 * Abwesenheiten import the barrel `./leave-limits` by relative path.
 *
 * Exceedance rule (D-836-07): `count > maxPersons` on a day on which the candidate itself counts,
 * the load including the candidate. A day the candidate does not count on never yields a finding.
 */
import type { EmployeeClassification } from "@clokr/db";
import type { FastifyInstance } from "fastify";
import { isLeaveLimitCountedCode } from "./constants";
import { countedDaysOfLeave } from "./counted-days";
import { groupMembershipOn } from "./group-membership";
import { loadLeaveLimitFacts } from "./load-facts";
import { parallelLeaveLoad, type CountedPersonDay } from "./parallel-leave-load";
import { strictestRulesOn, type LeaveLimitRuleRow } from "./rules";

type Db = FastifyInstance["prisma"];

export type LeaveLimitCandidate = {
  /** The request being checked; null for a hypothetical row (a #835 wish). */
  requestId: string | null;
  employeeId: string;
  typeCode: string;
  startDay: string;
  endDay: string;
};

export type LeaveLimitRuleSnapshot = {
  id: string;
  name: string | null;
  groupKind: "ALL" | "CLASSIFICATION" | "ACCESS_ROLE";
  classification: EmployeeClassification | null;
  accessRoleId: string | null;
  accessRoleName: string | null;
  maxPersons: number;
  validFrom: string | null;
  validUntil: string | null;
  salonId: string | null;
  createdAt: Date;
};

export type LeaveLimitExceedance = {
  rule: LeaveLimitRuleSnapshot;
  salonId: string;
  groupKey: string;
  candidateEmployeeId: string;
  /** `personIds` are internal and never serialised as such (response.ts drops them). */
  days: Array<{ day: string; count: number; max: number; personIds: string[] }>;
};

const NONE = { exceedances: [] as LeaveLimitExceedance[] };

function dayOf(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

export async function evaluateLeaveLimits(
  db: Db,
  tenantId: string,
  input: { candidates: readonly LeaveLimitCandidate[]; excludeRequestIds: readonly string[] },
): Promise<{ exceedances: LeaveLimitExceedance[] }> {
  // 1. Only counted leave types can exceed anything; a SICK request costs not a single query.
  const candidates = input.candidates.filter((c) => isLeaveLimitCountedCode(c.typeCode));
  if (candidates.length === 0) return { ...NONE };

  // 2. No rule, nothing to check.
  const ruleRecords = await db.leaveLimitRule.findMany({ where: { tenantId, deletedAt: null } });
  if (ruleRecords.length === 0) return { ...NONE };
  const rules: LeaveLimitRuleRow[] = ruleRecords.map((r) => ({
    id: r.id,
    salonId: r.salonId,
    groupKind: r.groupKind,
    classification: r.classification,
    accessRoleId: r.accessRoleId,
    maxPersons: r.maxPersons,
    validFrom: dayOf(r.validFrom),
    validUntil: dayOf(r.validUntil),
    name: r.name,
    createdAt: r.createdAt,
  }));

  // 3. Window = candidate days ∩ the union of the rule windows (an unwindowed rule spans it all).
  let fromDay = candidates.map((c) => c.startDay).reduce((a, b) => (a < b ? a : b));
  let toDay = candidates.map((c) => c.endDay).reduce((a, b) => (a > b ? a : b));
  const unionFrom = rules.some((r) => r.validFrom === null)
    ? null
    : rules.map((r) => r.validFrom as string).reduce((a, b) => (a < b ? a : b));
  const unionTo = rules.some((r) => r.validUntil === null)
    ? null
    : rules.map((r) => r.validUntil as string).reduce((a, b) => (a > b ? a : b));
  if (unionFrom !== null && unionFrom > fromDay) fromDay = unionFrom;
  if (unionTo !== null && unionTo < toDay) toDay = unionTo;
  if (fromDay > toDay) return { ...NONE };
  const window = { fromDay, toDay };

  // 4. Facts for the candidate persons and everyone with stored counted leave in the window.
  const facts = await loadLeaveLimitFacts(db, tenantId, {
    fromDay,
    toDay,
    personIds: candidates.map((c) => c.employeeId),
    excludeRequestIds: input.excludeRequestIds,
  });

  // 5. Person-day rows for the stored leave and the candidates; one kernel fold.
  const personDays: CountedPersonDay[] = [];
  const push = (
    requestId: string | null,
    personId: string,
    typeCode: string,
    s: string,
    e: string,
  ) => {
    const person = facts.persons.get(personId);
    if (!person) return;
    for (const { day, salonId } of countedDaysOfLeave(
      person,
      { typeCode, startDay: s, endDay: e },
      window,
    )) {
      personDays.push({
        personId,
        requestId,
        day,
        salonId,
        groups: groupMembershipOn(person, day),
      });
    }
  };
  for (const row of facts.storedRows) {
    push(row.requestId, row.personId, row.typeCode, row.startDay, row.endDay);
  }
  for (const c of candidates) push(c.requestId, c.employeeId, c.typeCode, c.startDay, c.endDay);
  const load = parallelLeaveLoad(personDays);

  // 6. Per candidate counted day: the strictest rule per group the candidate belongs to.
  const buckets = new Map<string, LeaveLimitExceedance>();
  for (const c of candidates) {
    const person = facts.persons.get(c.employeeId);
    if (!person) continue;
    const counted = countedDaysOfLeave(
      person,
      { typeCode: c.typeCode, startDay: c.startDay, endDay: c.endDay },
      window,
    );
    for (const { day, salonId } of counted) {
      const strictest = strictestRulesOn(rules, salonId, day);
      for (const groupKey of groupMembershipOn(person, day)) {
        const rule = strictest.get(groupKey);
        if (!rule) continue;
        const persons = load.get(salonId)?.get(groupKey)?.get(day);
        const count = persons?.size ?? 0;
        if (count <= rule.maxPersons) continue;
        const bucketKey = `${rule.id}|${salonId}|${groupKey}|${c.employeeId}`;
        let bucket = buckets.get(bucketKey);
        if (!bucket) {
          bucket = {
            rule: {
              id: rule.id,
              name: rule.name,
              groupKind: rule.groupKind,
              classification: rule.classification,
              accessRoleId: rule.accessRoleId,
              accessRoleName: null, // filled by 836-02
              maxPersons: rule.maxPersons,
              validFrom: rule.validFrom,
              validUntil: rule.validUntil,
              salonId: rule.salonId,
              createdAt: rule.createdAt,
            },
            salonId,
            groupKey,
            candidateEmployeeId: c.employeeId,
            days: [],
          };
          buckets.set(bucketKey, bucket);
        }
        if (!bucket.days.some((d) => d.day === day)) {
          bucket.days.push({ day, count, max: rule.maxPersons, personIds: [...(persons ?? [])] });
        }
      }
    }
  }
  return { exceedances: [...buckets.values()] };
}
