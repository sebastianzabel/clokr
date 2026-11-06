/**
 * Issue #836 (D-836-03, layer 2) — the loader: reads stored leave and the facts around it and hands
 * the pure kernel what it needs. Everything here is tenant-scoped inline (`lint:tenant-scoping`).
 *
 * Every read is batched: the query count is constant in the number of persons and days (the
 * contract segments of all persons in two queries, holidays, worked entries, shifts and Berufsschule
 * days one query each). A read that cannot matter is skipped: no shifts without a SHIFT_BASED
 * person, no Berufsschule days without VACATION leave, no role ids without an ACCESS_ROLE rule.
 * The workday set per person is built by the pure `workdaysOf`.
 */
import type { FastifyInstance } from "fastify";
import {
  accessRoleIdsByUserId,
  holidaysAtWorkLocation,
  homeSalonsForDays,
  isAnonymizedEmployee,
  isEmployedInPeriod,
} from "../../platform";
import { getShiftsInRange } from "../../scheduling";
import { getWorkedEntriesInRange } from "../../time-tracking";
import { dayRangeUtc, getTenantTimezone } from "../../working-time-account";
import { getVocationalSchoolDays } from "../facade/absences";
import { loadVacationContractSegmentsForMany } from "../leave-days";
import { LEAVE_LIMIT_COUNTED_CODES, LEAVE_LIMIT_COUNTED_STATUSES } from "./constants";
import { eachDay, type PersonDayFacts } from "./counted-days";
import type { GroupMemberFacts } from "./group-membership";
import { workdaysOf } from "./workdays";

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
    /** Type codes of the candidates; a VACATION candidate needs the Berufsschule days too. */
    candidateTypeCodes?: readonly string[];
    /** True iff some rule groups by access role; only then are the role ids read. */
    needsAccessRoles?: boolean;
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
  if (ids.length === 0) return { storedRows, persons: new Map() };

  const employees = await db.employee.findMany({
    where: { id: { in: ids }, tenantId },
    select: {
      id: true,
      userId: true,
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

  // Contract segments: two queries for every person (no per-person read).
  const segmentsByPerson = await loadVacationContractSegmentsForMany(db, tenantId, ids);

  // Holidays at the work location: the worked entries of the window decide the location of a day,
  // else the Stammsalon, else the default salon (the Unterbau resolver, one batched call).
  const scope = { kind: "employees" as const, employeeIds: ids, tenantId };
  const workedEntries = await getWorkedEntriesInRange(
    db,
    scope,
    dayToDate(fromDay),
    dayToDate(toDay),
  );
  const holidaysByPerson = await holidaysAtWorkLocation(
    db,
    tenantId,
    ids,
    fromDay,
    toDay,
    workedEntries,
  );

  // Roster days: only SHIFT_BASED persons need the roster.
  const shiftPersonIds = ids.filter((id) =>
    (segmentsByPerson.get(id) ?? []).some((segment) => segment.type === "SHIFT_BASED"),
  );
  const rosterDaysByPerson = new Map<string, Set<string>>();
  if (shiftPersonIds.length > 0) {
    const shifts = await getShiftsInRange(
      db,
      { kind: "employees", employeeIds: shiftPersonIds, tenantId },
      dayToDate(fromDay),
      dayToDate(toDay),
    );
    for (const shift of shifts) {
      const set = rosterDaysByPerson.get(shift.employeeId) ?? new Set<string>();
      set.add(shift.date.toISOString().slice(0, 10));
      rosterDaysByPerson.set(shift.employeeId, set);
    }
  }

  // Berufsschule displaces VACATION only, so the days are read only when VACATION leave is involved.
  const vocationalByPerson = new Map<string, Set<string>>();
  const vacationInvolved =
    storedRows.some((row) => row.typeCode === "VACATION") ||
    (input.candidateTypeCodes ?? []).includes("VACATION");
  if (vacationInvolved) {
    const absences = await getVocationalSchoolDays(db, scope, dayToDate(fromDay), dayToDate(toDay));
    for (const absence of absences) {
      const set = vocationalByPerson.get(absence.employeeId) ?? new Set<string>();
      set.add(absence.startDate.toISOString().slice(0, 10));
      vocationalByPerson.set(absence.employeeId, set);
    }
  }

  // Group membership by access role (stored assignments of any scope, D-836-05).
  const roleIdsByUser = input.needsAccessRoles
    ? await accessRoleIdsByUserId(
        db,
        tenantId,
        employees.map((emp) => emp.userId),
      )
    : new Map<string, Set<string>>();

  const persons = new Map<string, LeaveLimitPerson>();
  for (const emp of employees) {
    const employedDays = new Set<string>();
    for (const day of days) {
      const bounds = dayBounds.get(day)!;
      if (isEmployedInPeriod(emp, bounds.start, bounds.end)) employedDays.add(day);
    }
    const holidays = new Set((holidaysByPerson.get(emp.id) ?? new Map()).keys());
    persons.set(emp.id, {
      personId: emp.id,
      homeSalonByDay: homeByPerson.get(emp.id) ?? new Map(),
      employedDays,
      anonymized: isAnonymizedEmployee(emp),
      workdays: workdaysOf({
        days,
        segments: segmentsByPerson.get(emp.id) ?? [],
        holidays,
        rosterDays: rosterDaysByPerson.get(emp.id) ?? new Set(),
      }),
      vocationalSchoolDays: vocationalByPerson.get(emp.id) ?? new Set(),
      classification: emp.classification,
      accessRoleIds: roleIdsByUser.get(emp.userId) ?? new Set(),
      firstName: emp.firstName,
      lastName: emp.lastName,
    });
  }
  return { storedRows, persons };
}
