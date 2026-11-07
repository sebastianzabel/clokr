/**
 * Issue #835 (AC-6; D-835-10/23/31/34) — the planner's day load comes from the #836 kernel: the
 * count equals `GET /leave/limits/load`, a wish adds exactly one person on its counted days, a
 * taken-over or removed wish adds nothing, sick leave never counts, a day exists without any rule,
 * and rule data reaches only a reader with the manage or approve reach over the salon.
 *
 * Fixture (fake clock 2026-11-03, installed BEFORE the app boots; plan year 2027): tenant one with
 * salons S (the default) and S2, tenant two with its own salon. Open plans: P_S and P_S2. Callers
 * are built from custom roles: the seeded employee EMP (system role EMPLOYEE, homed in S, sees no
 * limits), AP (read + approve, whole tenant). Persons without a role: P1, P2, P3 and B (homed in S,
 * B has a Berufsschule day on 2027-09-06) and Y (S2 until 2027-06-30, S from 2027-07-01). A rule
 * "ALL, at most 2" exists for S only, so the plan of S2 has no rule at all. No person names.
 *
 * Mutation proof (Phase 835-06, 2026-11-06) — recorded here, not re-run by CI; each change was
 * reverted with cp afterwards (diff against the backup empty):
 * M1 planner-read.ts: the candidate wishes passed as `[]` -> red: the wish-count case and the
 *    two-plan attribution case (2 failed | 6 passed).
 * M2 load-view.ts: the `isLeaveLimitCountedCode` filter of the candidates removed -> STAYS GREEN
 *    (8 passed): `plannerDayLoad` types every wish as VACATION, so a non-counted candidate cannot
 *    reach the view through any caller; the filter is defence in depth for the option, and the
 *    sick case above proves the allow-list for STORED rows (pinned by the 836 suites as well).
 * M3 day-load.ts: `showLimits` ignored (limits always served) -> red: the plain-employee case and
 *    the exceeded-day-as-a-number case (2 failed | 6 passed).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  seedEntitlementYears,
  tokenWithoutSignIn,
} from "./setup";
import { roleNameKey, normalizeRolePermissions } from "../contexts/platform/access-role";
import { leaveTypeFields } from "../contexts/absence/leave-type";

const READ = "leave-request:read:ZUGEWIESEN";
const APPROVE = "leave-request:approve:ZUGEWIESEN";
const YEAR = 2027;

type DayLoadDto = Array<{
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
}>;

describe("Issue #835 - leave plan day load (the #836 kernel with wishes as candidates)", () => {
  let app: FastifyInstance;
  let one: Awaited<ReturnType<typeof seedTestData>>;
  let two: Awaited<ReturnType<typeof seedTestData>>;
  let salonS2: { id: string };
  let planS: string;
  let planS2: string;
  let sickTypeId: string;
  let ruleId: string;
  const tokens: Record<string, string> = {};
  const ids: Record<string, { userId: string; employeeId: string }> = {};

  function authed(token: string) {
    return { authorization: `Bearer ${token}` };
  }
  function day(value: string): Date {
    return new Date(`${value}T00:00:00Z`);
  }

  async function homeIn(
    employeeId: string,
    salonId: string,
    validFrom: string,
    validUntil: string | null = null,
  ) {
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: one.tenant.id,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: day(validFrom),
        validUntil: validUntil ? day(validUntil) : null,
        weekdays: [],
      },
    });
  }

  async function person(label: string, permissions: string[]) {
    const email = `${label}-${crypto.randomBytes(3).toString("hex")}@example.invalid`;
    const user = await app.prisma.user.create({
      data: { email, passwordHash: await bcrypt.hash("test1234", 4), isActive: true },
    });
    const row = await app.prisma.employee.create({
      data: {
        tenantId: one.tenant.id,
        userId: user.id,
        employeeNumber: `P${crypto.randomBytes(4).toString("hex")}`,
        firstName: label,
        lastName: "Load835",
        hireDate: new Date("2024-01-01"),
      },
    });
    if (permissions.length > 0) {
      const name = `Load835 ${crypto.randomBytes(3).toString("hex")}`;
      const role = await app.prisma.accessRole.create({
        data: {
          tenantId: one.tenant.id,
          name,
          nameKey: roleNameKey(name),
          permissions: normalizeRolePermissions(permissions),
        },
      });
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: one.tenant.id,
          userId: user.id,
          accessRoleId: role.id,
          scopeType: "TENANT",
          salonIds: [],
          employeeIds: [],
        },
      });
    }
    await app.prisma.workSchedule.create({
      data: {
        employeeId: row.id,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });
    await seedEntitlementYears(app, {
      employeeId: row.id,
      leaveTypeId: one.vacationType.id,
      years: [YEAR],
    });
    const token = permissions.length > 0 ? await tokenWithoutSignIn(app, email) : "";
    return { userId: user.id, employeeId: row.id, token };
  }

  function leave(
    label: string,
    status: "PENDING" | "APPROVED" | "REJECTED",
    startDate: string,
    endDate: string,
    leaveTypeId: string = one.vacationType.id,
  ) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId: ids[label].employeeId,
        leaveTypeId,
        startDate: day(startDate),
        endDate: day(endDate),
        days: 3,
        status,
      },
    });
  }

  function wish(
    planId: string,
    label: string,
    startDate: string,
    endDate: string,
    extra: Record<string, unknown> = {},
  ) {
    return app.prisma.leavePlanWish.create({
      data: {
        tenantId: one.tenant.id,
        planId,
        employeeId: ids[label].employeeId,
        startDate: day(startDate),
        endDate: day(endDate),
        createdByUserId: ids.ap.userId,
        ...extra,
      },
    });
  }

  async function dayLoad(label: string, planId: string = planS): Promise<DayLoadDto> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/plans/${planId}`,
      headers: authed(tokens[label]),
    });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { dayLoad: DayLoadDto }).dayLoad;
  }

  function counts(load: DayLoadDto, from: string, to: string): Record<string, number> {
    return Object.fromEntries(
      load.filter((d) => d.day >= from && d.day <= to).map((d) => [d.day, d.count]),
    );
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // A PAST date on purpose: audit rows written under a fake clock stay in the worker database, and a future stamp is
    // counted by usual-work-days-backfill-route-481 (it counts every leave audit with createdAt >= now).
    vi.setSystemTime(new Date("2026-11-03T10:00:00.000Z"));
    app = await getTestApp();
    one = await seedTestData(app, "ll835a");
    two = await seedTestData(app, "ll835b");
    salonS2 = await createTestSalon(app.prisma, one.tenant.id, { name: "Load835 S2" });
    const S = one.salonId;
    sickTypeId = (
      await app.prisma.leaveType.create({
        data: { tenantId: one.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
      })
    ).id;

    await homeIn(one.employee.id, S, "2024-01-01");
    ids.emp = { userId: one.empUser.id, employeeId: one.employee.id };
    tokens.emp = one.empToken;

    for (const [label, permissions] of [
      ["ap", [READ, APPROVE]],
      ["p1", []],
      ["p2", []],
      ["p3", []],
      ["b", []],
    ] as Array<[string, string[]]>) {
      const p = await person(label, permissions);
      await homeIn(p.employeeId, S, "2024-01-01");
      ids[label] = { userId: p.userId, employeeId: p.employeeId };
      tokens[label] = p.token;
    }
    const y = await person("y", []);
    await homeIn(y.employeeId, salonS2.id, "2024-01-01", "2027-06-30");
    await homeIn(y.employeeId, S, "2027-07-01");
    ids.y = { userId: y.userId, employeeId: y.employeeId };

    planS = (
      await app.prisma.leavePlan.create({
        data: { tenantId: one.tenant.id, salonId: S, year: YEAR, openedByUserId: ids.ap.userId },
      })
    ).id;
    planS2 = (
      await app.prisma.leavePlan.create({
        data: {
          tenantId: one.tenant.id,
          salonId: salonS2.id,
          year: YEAR,
          openedByUserId: ids.ap.userId,
        },
      })
    ).id;

    await app.prisma.publicHoliday.create({
      data: {
        tenantId: one.tenant.id,
        salonId: S,
        date: day("2027-03-03"),
        name: "Load835 Stadtfest",
        federalState: "BAYERN",
        year: YEAR,
      },
    });
    await app.prisma.absence.create({
      data: {
        employeeId: ids.b.employeeId,
        type: "VOCATIONAL_SCHOOL",
        startDate: day("2027-09-06"),
        endDate: day("2027-09-06"),
        days: 1,
        createdBy: ids.ap.userId,
      },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: one.tenant.id } });
      await cleanupTestData(app, one.tenant.id);
      await cleanupTestData(app, two.tenant.id);
    } catch (err) {
      console.error("leave-plan-load-835 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("lists a day with its count although no rule exists at all (includeAllGroup)", async () => {
    // Before the rule of S is created, S has no rule: the count still exists.
    await leave("p1", "APPROVED", "2027-01-11", "2027-01-12");
    const load = await dayLoad("ap");
    expect(counts(load, "2027-01-11", "2027-01-12")).toEqual({
      "2027-01-11": 1,
      "2027-01-12": 1,
    });
    // ... with no rule data, because nothing applies.
    expect(load.find((d) => d.day === "2027-01-11")?.limits).toEqual([]);
    // A plain employee sees the same figure, and no limits key content.
    const plain = await dayLoad("emp");
    expect(counts(plain, "2027-01-11", "2027-01-12")).toEqual({
      "2027-01-11": 1,
      "2027-01-12": 1,
    });
    await app.prisma.leaveRequest.deleteMany({ where: { employeeId: ids.p1.employeeId } });
  });

  it("equals GET /leave/limits/load for the same days with no wish, and flags an exceeded day", async () => {
    ruleId = (
      await app.prisma.leaveLimitRule.create({
        data: {
          tenantId: one.tenant.id,
          salonId: one.salonId,
          groupKind: "ALL",
          maxPersons: 2,
          name: "Load835 Regel",
        },
      })
    ).id;
    await leave("p1", "APPROVED", "2027-02-01", "2027-02-05");
    await leave("p2", "PENDING", "2027-02-03", "2027-02-05");
    await leave("p3", "APPROVED", "2027-02-03", "2027-02-03");

    const planner = await dayLoad("ap");
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/limits/load?salonId=${one.salonId}&from=2027-02-01&to=2027-02-14`,
      headers: authed(tokens.ap),
    });
    expect(res.statusCode, res.body).toBe(200);
    const loadBody = res.json() as {
      salons: Array<{
        groups: Array<{
          groupKey: string;
          days: Array<{ day: string; count: number; exceeded: boolean }>;
        }>;
      }>;
    };
    const allGroup = loadBody.salons[0].groups.find((g) => g.groupKey === "ALL")!;
    const expected = Object.fromEntries(allGroup.days.map((d) => [d.day, d.count]));
    expect(expected).toEqual({
      "2027-02-01": 1,
      "2027-02-02": 1,
      "2027-02-03": 3,
      "2027-02-04": 2,
      "2027-02-05": 2,
    });
    expect(counts(planner, "2027-02-01", "2027-02-14")).toEqual(expected);

    // The approver sees the rule facts; the exceeded day is flagged.
    const third = planner.find((d) => d.day === "2027-02-03")!;
    expect(third.limits).toEqual([
      { ruleId, ruleName: "Load835 Regel", groupKey: "ALL", max: 2, count: 3, exceeded: true },
    ]);
    expect(planner.find((d) => d.day === "2027-02-04")?.limits?.[0]).toMatchObject({
      exceeded: false,
    });
  });

  it("serves a plain employee the same counts and no rule data", async () => {
    const plain = await dayLoad("emp");
    const approver = await dayLoad("ap");
    expect(plain.map((d) => [d.day, d.count])).toEqual(approver.map((d) => [d.day, d.count]));
    expect(plain.every((d) => d.limits === null)).toBe(true);
    expect(JSON.stringify(plain)).not.toContain("Load835 Regel");
  });

  it("adds exactly one person on each counted workday of a wish, not on a weekend, holiday or Berufsschule day", async () => {
    const before = counts(await dayLoad("ap"), "2027-03-01", "2027-03-07");
    expect(before).toEqual({});
    // Mon 1 March .. Sun 7 March; Wed 3 March is a manual holiday of S.
    const w1 = await wish(planS, "b", "2027-03-01", "2027-03-07");
    // Mon 6 September (a Berufsschule day of B) .. Tue 7 September.
    const w2 = await wish(planS, "b", "2027-09-06", "2027-09-07");
    try {
      const load = await dayLoad("ap");
      expect(counts(load, "2027-03-01", "2027-03-07")).toEqual({
        "2027-03-01": 1,
        "2027-03-02": 1,
        "2027-03-04": 1,
        "2027-03-05": 1,
      });
      expect(counts(load, "2027-09-01", "2027-09-30")).toEqual({ "2027-09-07": 1 });
      // The wish never changes the day of the limit route: it is not a request.
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/leave/limits/load?salonId=${one.salonId}&from=2027-03-01&to=2027-03-07`,
        headers: authed(tokens.ap),
      });
      const limitLoad = res.json() as { salons: Array<{ groups: Array<{ days: unknown[] }> }> };
      expect(limitLoad.salons.flatMap((salon) => salon.groups.flatMap((g) => g.days))).toEqual([]);
    } finally {
      await app.prisma.leavePlanWish.deleteMany({ where: { id: { in: [w1.id, w2.id] } } });
    }
  });

  it("counts neither a taken-over wish (its request counts instead) nor a removed wish", async () => {
    // The linked request was REJECTED: it counts nothing, and the linked wish must not count either.
    const rejected = await leave("p1", "REJECTED", "2027-03-08", "2027-03-10");
    const linked = await wish(planS, "p1", "2027-03-08", "2027-03-10", {
      leaveRequestId: rejected.id,
      takenOverAt: new Date(),
    });
    const removed = await wish(planS, "p2", "2027-03-15", "2027-03-16", {
      deletedAt: new Date(),
      deletedByUserId: ids.ap.userId,
    });
    // A taken-over wish next to a counted request: the person counts once.
    const pending = await leave("p3", "PENDING", "2027-03-22", "2027-03-23");
    const linkedPending = await wish(planS, "p3", "2027-03-22", "2027-03-23", {
      leaveRequestId: pending.id,
      takenOverAt: new Date(),
    });
    try {
      const load = await dayLoad("ap");
      expect(counts(load, "2027-03-08", "2027-03-16")).toEqual({});
      expect(counts(load, "2027-03-22", "2027-03-23")).toEqual({
        "2027-03-22": 1,
        "2027-03-23": 1,
      });
    } finally {
      await app.prisma.leavePlanWish.deleteMany({
        where: { id: { in: [linked.id, removed.id, linkedPending.id] } },
      });
    }
  });

  it("never counts sick leave", async () => {
    await leave("p2", "APPROVED", "2027-04-12", "2027-04-13", sickTypeId);
    const load = await dayLoad("ap");
    expect(counts(load, "2027-04-12", "2027-04-13")).toEqual({});
  });

  it("attributes each day of a wish to the Stammsalon of that day, across two plans", async () => {
    // Y is homed in S2 until 30 June and in S from 1 July. Mon 28 June .. Fri 2 July.
    const w = await wish(planS2, "y", "2027-06-28", "2027-07-02");
    try {
      const inS = counts(await dayLoad("ap", planS), "2027-06-28", "2027-07-02");
      const inS2 = counts(await dayLoad("ap", planS2), "2027-06-28", "2027-07-02");
      expect(inS).toEqual({ "2027-07-01": 1, "2027-07-02": 1 });
      expect(inS2).toEqual({ "2027-06-28": 1, "2027-06-29": 1, "2027-06-30": 1 });
    } finally {
      await app.prisma.leavePlanWish.deleteMany({ where: { id: w.id } });
    }
  });

  it("serves an exceeded day only as a number to a reader without the limit reach", async () => {
    const plain = await dayLoad("emp");
    const third = plain.find((d) => d.day === "2027-02-03")!;
    expect(third).toEqual({ day: "2027-02-03", count: 3, limits: null });
  });
});
