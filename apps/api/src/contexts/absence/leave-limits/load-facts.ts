/**
 * Issue #836 (D-836-03, layer 2) — the loader: reads stored leave and the facts around it and hands
 * the pure kernel what it needs. Everything here is tenant-scoped inline (`lint:tenant-scoping`).
 *
 * Tracer scope (836-01): the workday test uses the contract weekday set valid on the day only, read
 * per person. 836-02 batches the contract read and adds holidays, the SHIFT_BASED roster and the
 * Berufsschule days; the shapes returned here do not change.
 */
import type { FastifyInstance } from "fastify";
import { homeSalonsForDays, isAnonymizedEmployee, isEmployedInPeriod } from "../../platform";
import { dayRangeUtc, getTenantTimezone } from "../../working-time-account";
import { loadVacationContractSegments } from "../leave-days";
import { contractSegmentAt } from "../vacation-calc";
import { LEAVE_LIMIT_COUNTED_CODES, LEAVE_LIMIT_COUNTED_STATUSES } from "./constants";
import { eachDay, type PersonDayFacts } from "./counted-days";
import type { GroupMemberFacts } from "./group-membership";

type Db = FastifyInstance["prisma"];

export type StoredLeaveRow = {
  requestId: string;
  personId: string;
  typeCode: string;
  status: string;
  /** `YYYY-MM-DD` (the `@db.Date` column, never an instant — Issue #493). */
  startDay: string;
  endDay: string;
  reviewedAt: Date | null;
};

export type LeaveLimitPerson = PersonDayFacts &
  GroupMemberFacts & { firstName: string; lastName: string };

export type LeaveLimitFacts = {
  storedRows: StoredLeaveRow[];
  persons: Map<string, LeaveLimitPerson>;
};

function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

export async function loadLeaveLimitFacts(
  db: Db,
  tenantId: string,
  input: {
    fromDay: string;
    toDay: string;
    personIds: readonly string[];
    excludeRequestIds: readonly string[];
  },
): Promise<LeaveLimitFacts> {
  const { fromDay, toDay } = input;

  const rows = await db.leaveRequest.findMany({
    where: {
      deletedAt: null,
      employee: { tenantId },
      status: { in: [...LEAVE_LIMIT_COUNTED_STATUSES] },
      leaveType: { code: { in: [...LEAVE_LIMIT_COUNTED_CODES] } },
      startDate: { lte: dayToDate(toDay) },
      endDate: { gte: dayToDate(fromDay) },
      ...(input.excludeRequestIds.length > 0
        ? { id: { notIn: [...input.excludeRequestIds] } }
        : {}),
    },
    select: {
      id: true,
      employeeId: true,
      status: true,
      startDate: true,
      endDate: true,
      reviewedAt: true,
      leaveType: { select: { code: true } },
    },
  });
  const storedRows: StoredLeaveRow[] = rows.map((r) => ({
    requestId: r.id,
    personId: r.employeeId,
    typeCode: r.leaveType.code,
    status: r.status,
    startDay: r.startDate.toISOString().slice(0, 10),
    endDay: r.endDate.toISOString().slice(0, 10),
    reviewedAt: r.reviewedAt,
  }));

  const personIdSet = new Set<string>(input.personIds);
  for (const row of storedRows) personIdSet.add(row.personId);
  const ids = [...personIdSet];
  const persons = new Map<string, LeaveLimitPerson>();
  if (ids.length === 0) return { storedRows, persons };

  const employees = await db.employee.findMany({
    where: { id: { in: ids }, tenantId },
    select: {
      id: true,
      classification: true,
      hireDate: true,
      exitDate: true,
      firstName: true,
      lastName: true,
    },
  });
  const homeByPerson = await homeSalonsForDays(db, tenantId, ids, fromDay, toDay);
  const tz = await getTenantTimezone(db, tenantId);
  const days = eachDay(fromDay, toDay);
  const dayBounds = new Map(days.map((day) => [day, dayRangeUtc(day, tz)] as const));

  for (const emp of employees) {
    const segments = await loadVacationContractSegments(db, emp.id, tenantId);
    const employedDays = new Set<string>();
    const workdays = new Set<string>();
    for (const day of days) {
      const bounds = dayBounds.get(day)!;
      if (isEmployedInPeriod(emp, bounds.start, bounds.end)) employedDays.add(day);
      // Weekday 0 = Sunday, the `workDays` convention — never a Monday-based helper.
      const dow = dayToDate(day).getUTCDay();
      if (contractSegmentAt(segments, dayToDate(day)).resolvedWorkDays.includes(dow)) {
        workdays.add(day);
      }
    }
    persons.set(emp.id, {
      personId: emp.id,
      homeSalonByDay: homeByPerson.get(emp.id) ?? new Map(),
      employedDays,
      anonymized: isAnonymizedEmployee(emp),
      workdays,
      vocationalSchoolDays: new Set(),
      classification: emp.classification,
      accessRoleIds: new Set(),
      firstName: emp.firstName,
      lastName: emp.lastName,
    });
  }
  return { storedRows, persons };
}
