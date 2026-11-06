/**
 * Issue #836 (AC-4 a-f) — one database test per counting rule of the leave limits, through the one
 * checker `evaluateLeaveLimits`. A candidate is a hypothetical request (`requestId: null`); the
 * "other people" are stored requests. No person names, fixed dates, no clock.
 *
 * Calendar anchors (getUTCDay): 2027-12-06 Mon .. 12-10 Fri, 12-11 Sat, 12-12 Sun;
 * 2027-05-03 Mon .. 05-07 Fri with Christi Himmelfahrt (statutory, every Land) on Thu 05-06.
 *
 * Mutation proof (Phase 836, 2026-11-06) — recorded here, not re-run by CI; each change was reverted
 * with cp afterwards:
 * M1 load-facts.ts: holidays passed as an empty set -> red: "(d) only workdays count: a statutory
 *    holiday at the work location does not count".
 * M2 counted-days.ts: the Berufsschule `continue` removed -> red: "(d) ... a VACATION Berufsschultag".
 * M3 load-facts.ts: `rosterDays` always empty -> red: "(d) ... SHIFT_BASED counts a roster Saturday".
 * M4 load-facts.ts: the Stammsalon of the person's LAST day used for every day -> red: "(a) the
 *    Stammsalon of each single day decides ..." and "(a) parity ...".
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { EmployeeClassification } from "@clokr/db";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import { filterLeaveRowsToHomeSalon } from "../contexts/absence/salon-leave-attribution";
import { evaluateLeaveLimits, type LeaveLimitCandidate } from "../contexts/absence/leave-limits";
import { loadLeaveLimitFacts } from "../contexts/absence/leave-limits/load-facts";
import { countedDaysOfLeave } from "../contexts/absence/leave-limits/counted-days";
import { roleNameKey } from "../contexts/platform/access-role";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";

type PersonOpts = {
  classification?: EmployeeClassification;
  hireDate?: string;
  exitDate?: string | null;
  schedule?: {
    type?: "FIXED_SCHEDULE" | "SHIFT_BASED";
    workDays?: number[];
    usualWorkDays?: number[];
    contractWorkDaysPerWeek?: number;
  };
  homes?: Array<{ salonId: string; from: string; until?: string | null }>;
};

describe("Issue #836 — what counts toward a leave limit (AC-4)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let s1: string;
  let s2: string;
  const types: Record<string, string> = {};
  const created = { users: [] as string[], roles: [] as string[] };

  async function mkPerson(label: string, opts: PersonOpts = {}) {
    const uid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: { email: `c836-${label}-${uid}@example.invalid`, passwordHash: "x", isActive: true },
    });
    created.users.push(user.id);
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `C836${uid}`.slice(0, 20),
        firstName: "P",
        lastName: label,
        classification: opts.classification ?? "VOLLZEIT",
        hireDate: new Date(`${opts.hireDate ?? "2024-01-01"}T00:00:00Z`),
        exitDate: opts.exitDate ? new Date(`${opts.exitDate}T00:00:00Z`) : null,
      },
    });
    const workDays = opts.schedule?.workDays ?? [1, 2, 3, 4, 5];
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: opts.schedule?.type ?? "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: workDays.includes(1) ? 8 : 0,
        tuesdayHours: workDays.includes(2) ? 8 : 0,
        wednesdayHours: workDays.includes(3) ? 8 : 0,
        thursdayHours: workDays.includes(4) ? 8 : 0,
        fridayHours: workDays.includes(5) ? 8 : 0,
        saturdayHours: workDays.includes(6) ? 8 : 0,
        sundayHours: workDays.includes(0) ? 8 : 0,
        workDays,
        usualWorkDays: opts.schedule?.usualWorkDays ?? [],
        contractWorkDaysPerWeek: opts.schedule?.contractWorkDaysPerWeek ?? null,
        validFrom: new Date("2024-01-01T00:00:00Z"),
      },
    });
    for (const home of opts.homes ?? [{ salonId: s1, from: "2024-01-01" }]) {
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId: data.tenant.id,
          employeeId: employee.id,
          salonId: home.salonId,
          kind: "HOME",
          validFrom: new Date(`${home.from}T00:00:00Z`),
          validUntil: home.until ? new Date(`${home.until}T00:00:00Z`) : null,
          weekdays: [],
        },
      });
    }
    return { employeeId: employee.id, userId: user.id };
  }

  function stored(
    employeeId: string,
    type: string,
    startDate: string,
    endDate: string,
    status: "APPROVED" | "PENDING" | "REJECTED" | "CANCELLED" = "APPROVED",
  ) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: types[type],
        startDate: new Date(`${startDate}T00:00:00Z`),
        endDate: new Date(`${endDate}T00:00:00Z`),
        days: 1,
        status,
      },
    });
  }

  function addRule(over: {
    salonId?: string | null;
    groupKind?: "ALL" | "CLASSIFICATION" | "ACCESS_ROLE";
    classification?: EmployeeClassification;
    accessRoleId?: string;
    maxPersons: number;
  }) {
    const groupKind = over.groupKind ?? "ALL";
    return app.prisma.leaveLimitRule.create({
      data: {
        tenantId: data.tenant.id,
        salonId: over.salonId === undefined ? s1 : over.salonId,
        groupKind,
        classification: groupKind === "CLASSIFICATION" ? (over.classification ?? null) : null,
        accessRoleId: groupKind === "ACCESS_ROLE" ? (over.accessRoleId ?? null) : null,
        maxPersons: over.maxPersons,
        name: "Fixture rule",
      },
    });
  }

  const cand = (
    employeeId: string,
    typeCode: string,
    startDay: string,
    endDay: string,
  ): LeaveLimitCandidate => ({ requestId: null, employeeId, typeCode, startDay, endDay });

  async function evaluate(...candidates: LeaveLimitCandidate[]) {
    return (
      await evaluateLeaveLimits(app.prisma, data.tenant.id, { candidates, excludeRequestIds: [] })
    ).exceedances;
  }
  const daysOf = (found: Awaited<ReturnType<typeof evaluate>>, salonId = s1) =>
    found
      .filter((e) => e.salonId === salonId)
      .flatMap((e) => e.days.map((d) => d.day))
      .sort();

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "lv836c");
    s1 = data.salonId;
    await app.prisma.salon.update({ where: { id: s1 }, data: { federalState: "NIEDERSACHSEN" } });
    s2 = (await createTestSalon(app.prisma, data.tenant.id, { federalState: "NIEDERSACHSEN" })).id;
    types.VACATION = data.vacationType.id;
    for (const code of ["SICK", "SICK_CHILD", "OVERTIME_COMP"] as const) {
      const row = await app.prisma.leaveType.create({
        data: { tenantId: data.tenant.id, ...leaveTypeFields(code), color: "#EF4444" },
      });
      types[code] = row.id;
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.prisma.leaveLimitRule.deleteMany({ where: { tenantId: data.tenant.id } });
    const ids = (
      await app.prisma.employee.findMany({
        where: { tenantId: data.tenant.id },
        select: { id: true },
      })
    ).map((e) => e.id);
    await app.prisma.leaveRequest.deleteMany({ where: { employeeId: { in: ids } } });
    await app.prisma.absence.deleteMany({ where: { employeeId: { in: ids } } });
    await app.prisma.shift.deleteMany({ where: { employeeId: { in: ids } } });
    await app.prisma.roleAssignment.deleteMany({ where: { userId: { in: created.users } } });
  });

  afterAll(async () => {
    try {
      await app.prisma.accessRole.deleteMany({ where: { id: { in: created.roles } } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.warn("leave-limits-counting-836 cleanup failed", err);
    }
  });

  it("(a) the Stammsalon of each single day decides, a deployment salon never counts", async () => {
    // Homed in S1 until Tue 12-07, in S2 from Wed 12-08; deployed in S1 from 12-08 on.
    const a = await mkPerson("a", {
      homes: [
        { salonId: s1, from: "2024-01-01", until: "2027-12-07" },
        { salonId: s2, from: "2027-12-08" },
      ],
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: a.employeeId,
        salonId: s1,
        kind: "DEPLOYMENT",
        validFrom: new Date("2027-12-08T00:00:00Z"),
        validUntil: null,
        weekdays: [],
      },
    });
    await addRule({ salonId: s1, maxPersons: 0 });
    const found = await evaluate(cand(a.employeeId, "VACATION", "2027-12-06", "2027-12-10"));
    expect(daysOf(found, s1)).toEqual(["2027-12-06", "2027-12-07"]);
    expect(daysOf(found, s2)).toEqual([]);

    await addRule({ salonId: s2, maxPersons: 0 });
    const both = await evaluate(cand(a.employeeId, "VACATION", "2027-12-06", "2027-12-10"));
    expect(daysOf(both, s1)).toEqual(["2027-12-06", "2027-12-07"]);
    expect(daysOf(both, s2)).toEqual(["2027-12-08", "2027-12-09", "2027-12-10"]);
  });

  it("(a) parity: every stored request with a counted day in S1 is a row of the S1 team filter", async () => {
    const a = await mkPerson("pa", {
      homes: [
        { salonId: s1, from: "2024-01-01", until: "2027-12-07" },
        { salonId: s2, from: "2027-12-08" },
      ],
    });
    const g = await mkPerson("pg");
    const h = await mkPerson("ph", { homes: [{ salonId: s2, from: "2024-01-01" }] });
    const reqA = await stored(a.employeeId, "VACATION", "2027-12-06", "2027-12-10");
    const reqG = await stored(g.employeeId, "VACATION", "2027-12-08", "2027-12-09");
    const reqH = await stored(h.employeeId, "VACATION", "2027-12-08", "2027-12-09");
    const facts = await loadLeaveLimitFacts(app.prisma, data.tenant.id, {
      fromDay: "2027-12-06",
      toDay: "2027-12-10",
      personIds: [],
      excludeRequestIds: [],
    });
    const window = { fromDay: "2027-12-06", toDay: "2027-12-10" };
    const countedInS1 = facts.storedRows
      .filter((row) =>
        countedDaysOfLeave(facts.persons.get(row.personId)!, row, window).some(
          (c) => c.salonId === s1,
        ),
      )
      .map((row) => row.requestId)
      .sort();
    expect(countedInS1).toEqual([reqA.id, reqG.id].sort());
    const rows = await app.prisma.leaveRequest.findMany({
      where: { id: { in: [reqA.id, reqG.id, reqH.id] } },
    });
    const filtered = await filterLeaveRowsToHomeSalon(app.prisma, data.tenant.id, rows, s1, window);
    const filteredIds = new Set(filtered.map((r) => r.id));
    for (const id of countedInS1) expect(filteredIds.has(id)).toBe(true);
    expect(filteredIds.has(reqH.id)).toBe(false);
  });

  it("(b) sick leave and imposed absences never count", async () => {
    const e = await mkPerson("be");
    const f = await mkPerson("bf");
    const sick = await mkPerson("bs");
    const sickChild = await mkPerson("bc");
    const mat = await mkPerson("bm");
    await stored(sick.employeeId, "SICK", "2027-12-08", "2027-12-08");
    await stored(sickChild.employeeId, "SICK_CHILD", "2027-12-08", "2027-12-08");
    await app.prisma.absence.create({
      data: {
        employeeId: mat.employeeId,
        type: "MATERNITY",
        startDate: new Date("2027-12-08T00:00:00Z"),
        endDate: new Date("2027-12-08T00:00:00Z"),
        days: 1,
        createdBy: "test",
      },
    });
    await addRule({ maxPersons: 1 });
    // Others add 0: the candidate alone is 1 of 1.
    expect(await evaluate(cand(e.employeeId, "VACATION", "2027-12-08", "2027-12-08"))).toEqual([]);
    // Control: a counted request of another person pushes the same day over the limit.
    await stored(f.employeeId, "VACATION", "2027-12-08", "2027-12-08");
    const found = await evaluate(cand(e.employeeId, "VACATION", "2027-12-08", "2027-12-08"));
    expect(found.map((x) => x.days[0].count)).toEqual([2]);
  });

  it("(c) PENDING counts, REJECTED and CANCELLED do not", async () => {
    const e = await mkPerson("ce");
    const p = await mkPerson("cp");
    const r = await mkPerson("cr");
    const c = await mkPerson("cc");
    await addRule({ maxPersons: 1 });
    await stored(r.employeeId, "VACATION", "2027-12-08", "2027-12-08", "REJECTED");
    await stored(c.employeeId, "VACATION", "2027-12-08", "2027-12-08", "CANCELLED");
    expect(await evaluate(cand(e.employeeId, "VACATION", "2027-12-08", "2027-12-08"))).toEqual([]);
    await stored(p.employeeId, "VACATION", "2027-12-08", "2027-12-08", "PENDING");
    const found = await evaluate(cand(e.employeeId, "VACATION", "2027-12-08", "2027-12-08"));
    expect(found).toHaveLength(1);
    expect(found[0].days[0].count).toBe(2);
  });

  it("(d) only workdays count: the contract weekday set of the person", async () => {
    const x = await mkPerson("dx", { schedule: { workDays: [2, 3, 4, 5, 6] } }); // Tue-Sat
    await addRule({ maxPersons: 0 });
    const found = await evaluate(cand(x.employeeId, "VACATION", "2027-12-06", "2027-12-12"));
    expect(daysOf(found)).toEqual([
      "2027-12-07",
      "2027-12-08",
      "2027-12-09",
      "2027-12-10",
      "2027-12-11",
    ]);
  });

  it("(d) only workdays count: a statutory holiday at the work location does not count", async () => {
    const x = await mkPerson("dh");
    await addRule({ maxPersons: 0 });
    const found = await evaluate(cand(x.employeeId, "VACATION", "2027-05-03", "2027-05-07"));
    expect(daysOf(found)).toEqual(["2027-05-03", "2027-05-04", "2027-05-05", "2027-05-07"]);
  });

  it("(d) only workdays count: SHIFT_BASED counts a roster Saturday and the usual days without a shift", async () => {
    const x = await mkPerson("ds", {
      schedule: {
        type: "SHIFT_BASED",
        workDays: [1, 2, 3, 4, 5],
        usualWorkDays: [2, 3, 4],
        contractWorkDaysPerWeek: 3,
      },
    });
    await app.prisma.shift.create({
      data: {
        employeeId: x.employeeId,
        salonId: s1,
        date: new Date("2027-12-11T00:00:00Z"),
        startTime: "09:00",
        endTime: "17:00",
      },
    });
    await addRule({ maxPersons: 0 });
    const found = await evaluate(cand(x.employeeId, "VACATION", "2027-12-06", "2027-12-12"));
    expect(daysOf(found)).toEqual(["2027-12-07", "2027-12-08", "2027-12-09", "2027-12-11"]);
  });

  it("(d) only workdays count: a VACATION Berufsschultag does not count, other types do", async () => {
    const x = await mkPerson("db", { classification: "AZUBI" });
    await app.prisma.absence.create({
      data: {
        employeeId: x.employeeId,
        type: "VOCATIONAL_SCHOOL",
        startDate: new Date("2027-12-07T00:00:00Z"),
        endDate: new Date("2027-12-07T00:00:00Z"),
        days: 1,
        createdBy: "test",
      },
    });
    await addRule({ maxPersons: 0 });
    const vacation = await evaluate(cand(x.employeeId, "VACATION", "2027-12-06", "2027-12-10"));
    expect(daysOf(vacation)).toEqual(["2027-12-06", "2027-12-08", "2027-12-09", "2027-12-10"]);
    const comp = await evaluate(cand(x.employeeId, "OVERTIME_COMP", "2027-12-06", "2027-12-10"));
    expect(daysOf(comp)).toContain("2027-12-07");
  });

  it("(e) a person in two groups counts in both, each rule is checked on its own", async () => {
    const p1 = await mkPerson("e1", { classification: "AZUBI" });
    const p2 = await mkPerson("e2", { classification: "AZUBI" });
    const q = await mkPerson("eq");
    await stored(p2.employeeId, "VACATION", "2027-12-08", "2027-12-08");
    await stored(q.employeeId, "VACATION", "2027-12-08", "2027-12-08");
    const all = await addRule({ maxPersons: 5 });
    await addRule({ groupKind: "CLASSIFICATION", classification: "AZUBI", maxPersons: 1 });
    const only = await evaluate(cand(p1.employeeId, "VACATION", "2027-12-08", "2027-12-08"));
    expect(only.map((x) => x.groupKey)).toEqual(["CLASSIFICATION:AZUBI"]);
    expect(only[0].days[0]).toMatchObject({ count: 2, max: 1 });

    await app.prisma.leaveLimitRule.update({ where: { id: all.id }, data: { maxPersons: 2 } });
    const both = await evaluate(cand(p1.employeeId, "VACATION", "2027-12-08", "2027-12-08"));
    const byGroup = Object.fromEntries(both.map((x) => [x.groupKey, x.days[0].count]));
    expect(byGroup).toEqual({ ALL: 3, "CLASSIFICATION:AZUBI": 2 });
  });

  it("(f) membership: a stored role assignment counts at once, removing it stops counting", async () => {
    const name = `Role836 ${Date.now().toString(36)}`;
    const role = await app.prisma.accessRole.create({
      data: { tenantId: data.tenant.id, name, nameKey: roleNameKey(name), permissions: [] },
    });
    created.roles.push(role.id);
    const x = await mkPerson("fr");
    await addRule({ groupKind: "ACCESS_ROLE", accessRoleId: role.id, maxPersons: 0 });
    const none = await evaluate(cand(x.employeeId, "VACATION", "2027-12-08", "2027-12-08"));
    expect(none).toEqual([]);
    const assignment = await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: x.userId,
        accessRoleId: role.id,
        scopeType: "SALONS",
        salonIds: [s2],
        employeeIds: [],
      },
    });
    const held = await evaluate(cand(x.employeeId, "VACATION", "2027-12-08", "2027-12-08"));
    expect(held).toHaveLength(1);
    expect(held[0].groupKey).toBe(`ACCESS_ROLE:${role.id}`);
    expect(held[0].rule.accessRoleName).toBe(name);
    await app.prisma.roleAssignment.delete({ where: { id: assignment.id } });
    expect(await evaluate(cand(x.employeeId, "VACATION", "2027-12-08", "2027-12-08"))).toEqual([]);
  });

  it("(f) membership: a changed classification applies at once", async () => {
    const x = await mkPerson("fc", { classification: "AZUBI" });
    await addRule({ groupKind: "CLASSIFICATION", classification: "AZUBI", maxPersons: 0 });
    const before = await evaluate(cand(x.employeeId, "VACATION", "2027-12-08", "2027-12-08"));
    expect(before).toHaveLength(1);
    await app.prisma.employee.update({
      where: { id: x.employeeId },
      data: { classification: "VOLLZEIT" },
    });
    expect(await evaluate(cand(x.employeeId, "VACATION", "2027-12-08", "2027-12-08"))).toEqual([]);
  });

  it("(f) membership: a day after the exit day never counts", async () => {
    const x = await mkPerson("fe", { exitDate: "2027-12-08" });
    await addRule({ maxPersons: 0 });
    const found = await evaluate(cand(x.employeeId, "VACATION", "2027-12-06", "2027-12-10"));
    expect(daysOf(found)).toEqual(["2027-12-06", "2027-12-07", "2027-12-08"]);
  });

  it("the loader reads the contract segments in a constant number of queries", async () => {
    const people = [await mkPerson("q1"), await mkPerson("q2"), await mkPerson("q3")];
    const more = [await mkPerson("q4"), await mkPerson("q5"), await mkPerson("q6")];
    const spy = vi.spyOn(app.prisma.workSchedule, "findMany");
    const run = (ids: string[]) =>
      loadLeaveLimitFacts(app.prisma, data.tenant.id, {
        fromDay: "2027-12-06",
        toDay: "2027-12-10",
        personIds: ids,
        excludeRequestIds: [],
      });
    await run(people.map((p) => p.employeeId));
    const few = spy.mock.calls.length;
    spy.mockClear();
    await run([...people, ...more].map((p) => p.employeeId));
    expect(spy.mock.calls.length).toBe(few);
    expect(few).toBe(1);
  });
});
