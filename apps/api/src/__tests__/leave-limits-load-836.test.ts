/**
 * Issue #836 (D-836-14, AC-10, AC-12) — `GET /api/v1/leave/limits/load`: the daily load per salon and
 * group, from the SAME kernel the warnings use, with the neutral "approved before the rule" marker.
 *
 * Fixture: tenant one with its default salon S1 and a second salon S2; tenant two with its own salon.
 * Raw employees A and B (Mo-Fr, homed in S1) and C (homed in S2) carry the leave; the readers are
 * custom roles built here (never what the seeded admin holds). Distinct last names make a leak
 * greppable. No real names.
 *
 * Mutation proof (Phase 836, 2026-11-06) — recorded, not re-run by CI; reverted with cp afterwards:
 * M1 load-view.ts `approvedBefore`: `row.reviewedAt < rule.updatedAt` turned into `true` -> red: the
 *    blackout case (the later-approved and the PENDING entry are marked too).
 * M2 api/leave-limits.ts: the `spanDays > LEAVE_LIMIT_LOAD_MAX_DAYS` guard removed -> red: the
 *    93-day case.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  tokenWithoutSignIn,
  auditRowsFor,
} from "./setup";
import { roleNameKey, normalizeRolePermissions } from "../contexts/platform/access-role";
import { evaluateLeaveLimits } from "../contexts/absence/leave-limits";

const READ = "leave-request:read:ZUGEWIESEN";
const APPROVE = "leave-request:approve:ZUGEWIESEN";
const MANAGE = "leave-limit:manage:ZUGEWIESEN";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000001";

type DayItem = {
  day: string;
  count: number;
  max: number | null;
  ruleId: string | null;
  ruleName: string | null;
  exceeded: boolean;
  persons: Array<{
    employeeId: string;
    firstName: string;
    lastName: string;
    approvedBeforeRule: boolean;
  }>;
  hiddenCount: number;
  approvedBeforeRuleCount: number;
};
type Body = {
  from: string;
  to: string;
  salons: Array<{
    salonId: string;
    salonName: string;
    groups: Array<{ groupKey: string; groupKind: string; days: DayItem[] }>;
  }>;
};

describe("Issue #836 — GET /leave/limits/load", () => {
  let app: FastifyInstance;
  let one: Awaited<ReturnType<typeof seedTestData>>;
  let two: Awaited<ReturnType<typeof seedTestData>>;
  let s2: string;
  let personA: string;
  let personB: string;
  let personC: string;
  let tenantManager: string;
  let salonReader: string;
  let personReader: string;
  let s2Approver: string;
  let readOnly: string;

  async function rawEmployee(tag: string, lastName: string, salonId: string) {
    const user = await app.prisma.user.create({
      data: {
        email: `${tag}-${crypto.randomBytes(3).toString("hex")}@example.invalid`,
        passwordHash: await bcrypt.hash("test1234", 4),
        isActive: true,
      },
    });
    const emp = await app.prisma.employee.create({
      data: {
        tenantId: one.tenant.id,
        userId: user.id,
        employeeNumber: `${tag}${crypto.randomBytes(3).toString("hex")}`.slice(0, 20),
        firstName: tag,
        lastName,
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
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
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: one.tenant.id,
        employeeId: emp.id,
        salonId,
        kind: "HOME",
        validFrom: new Date("2024-01-01T00:00:00Z"),
        validUntil: null,
        weekdays: [],
      },
    });
    return emp.id;
  }

  async function actor(
    label: string,
    grants: Array<{
      permissions: string[];
      scope: {
        scopeType: "TENANT" | "SALONS" | "PERSONS";
        salonIds?: string[];
        employeeIds?: string[];
      };
    }>,
  ): Promise<string> {
    const email = `${label}-${crypto.randomBytes(3).toString("hex")}@example.invalid`;
    const user = await app.prisma.user.create({
      data: { email, passwordHash: await bcrypt.hash("test1234", 4), isActive: true },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: one.tenant.id,
        userId: user.id,
        employeeNumber: `L${crypto.randomBytes(4).toString("hex")}`,
        firstName: "L",
        lastName: "Actor836l",
        hireDate: new Date("2024-01-01"),
      },
    });
    for (const grant of grants) {
      const name = `Load836 ${crypto.randomBytes(3).toString("hex")}`;
      const role = await app.prisma.accessRole.create({
        data: {
          tenantId: one.tenant.id,
          name,
          nameKey: roleNameKey(name),
          permissions: normalizeRolePermissions(grant.permissions),
        },
      });
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: one.tenant.id,
          userId: user.id,
          accessRoleId: role.id,
          scopeType: grant.scope.scopeType,
          salonIds: grant.scope.salonIds ?? [],
          employeeIds: grant.scope.employeeIds ?? [],
        },
      });
    }
    return tokenWithoutSignIn(app, email);
  }

  function leave(
    employeeId: string,
    status: "APPROVED" | "PENDING",
    startDate: string,
    endDate: string,
    reviewedAt: Date | null = null,
  ) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: one.vacationType.id,
        startDate: new Date(`${startDate}T00:00:00Z`),
        endDate: new Date(`${endDate}T00:00:00Z`),
        days: 1,
        status,
        reviewedAt,
      },
    });
  }

  function rule(
    over: Partial<{
      salonId: string | null;
      maxPersons: number;
      groupKind: "ALL" | "CLASSIFICATION";
      validFrom: Date | null;
      validUntil: Date | null;
      createdAt: Date;
      updatedAt: Date;
      name: string;
    }> = {},
  ) {
    const groupKind = over.groupKind ?? "ALL";
    return app.prisma.leaveLimitRule.create({
      data: {
        tenantId: one.tenant.id,
        salonId: one.salonId,
        maxPersons: 1,
        name: "Fixture rule",
        ...over,
        groupKind,
        classification: groupKind === "CLASSIFICATION" ? "VOLLZEIT" : null,
      },
    });
  }

  function load(token: string, query: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/leave/limits/load?${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  const WEEK = `from=2026-08-03&to=2026-08-09`;

  beforeAll(async () => {
    app = await getTestApp();
    one = await seedTestData(app, "llv836a");
    two = await seedTestData(app, "llv836b");
    s2 = (await createTestSalon(app.prisma, one.tenant.id, { name: "Load836 S2" })).id;
    personA = await rawEmployee("A", "Alpha836", one.salonId);
    personB = await rawEmployee("B", "Beta836", one.salonId);
    personC = await rawEmployee("C", "Gamma836", s2);

    tenantManager = await actor("tm", [
      { permissions: [MANAGE, READ], scope: { scopeType: "TENANT" } },
    ]);
    salonReader = await actor("sr", [
      { permissions: [APPROVE, READ], scope: { scopeType: "SALONS", salonIds: [one.salonId] } },
    ]);
    personReader = await actor("pr", [
      { permissions: [APPROVE], scope: { scopeType: "SALONS", salonIds: [one.salonId] } },
      { permissions: [READ], scope: { scopeType: "PERSONS", employeeIds: [personA] } },
    ]);
    s2Approver = await actor("s2", [
      { permissions: [APPROVE, READ], scope: { scopeType: "SALONS", salonIds: [s2] } },
    ]);
    readOnly = await actor("ro", [{ permissions: [READ], scope: { scopeType: "TENANT" } }]);
  });

  afterEach(async () => {
    await app.prisma.leaveLimitRule.deleteMany({ where: { tenantId: one.tenant.id } });
    await app.prisma.leaveRequest.deleteMany({
      where: { employee: { tenantId: one.tenant.id } },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, one.tenant.id);
      await cleanupTestData(app, two.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("lists the days with a count, marks the exceeded one and omits empty days", async () => {
    await leave(personA, "APPROVED", "2026-08-04", "2026-08-05");
    await leave(personB, "PENDING", "2026-08-05", "2026-08-05");
    const r = await rule();
    const res = await load(tenantManager, `salonId=${one.salonId}&${WEEK}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as Body;
    expect(body.from).toBe("2026-08-03");
    expect(body.salons).toHaveLength(1);
    const salon = body.salons[0]!;
    expect(salon.salonId).toBe(one.salonId);
    expect(salon.salonName).toBeTruthy();
    expect(salon.groups.map((g) => g.groupKey)).toEqual(["ALL"]);
    const days = salon.groups[0]!.days;
    expect(days.map((d) => d.day)).toEqual(["2026-08-04", "2026-08-05"]);
    expect(days[0]).toMatchObject({ count: 1, max: 1, exceeded: false, ruleId: r.id });
    expect(days[1]).toMatchObject({ count: 2, max: 1, exceeded: true, ruleId: r.id });
    expect(days[1]!.persons.map((p) => p.employeeId).sort()).toEqual([personA, personB].sort());
  });

  it("reports for the same data the count the warning path reports", async () => {
    await leave(personA, "APPROVED", "2026-08-04", "2026-08-05");
    await rule();
    const res = await load(tenantManager, `salonId=${one.salonId}&${WEEK}`);
    const days = (JSON.parse(res.body) as Body).salons[0]!.groups[0]!.days;
    const check = await evaluateLeaveLimits(app.prisma, one.tenant.id, {
      candidates: [
        {
          requestId: null,
          employeeId: personB,
          typeCode: "VACATION",
          startDay: "2026-08-05",
          endDay: "2026-08-05",
        },
      ],
      excludeRequestIds: [],
    });
    const warned = check.exceedances[0]!.days.find((d) => d.day === "2026-08-05")!;
    // load: A alone on the 5th is 1; the warning counts B on top of A
    expect(days.find((d) => d.day === "2026-08-05")!.count + 1).toBe(warned.count);
  });

  it("marks leave approved before the rule was created, neutrally, and changes nothing", async () => {
    const a = await leave(personA, "APPROVED", "2026-12-02", "2026-12-03", new Date("2026-06-01"));
    await leave(personB, "APPROVED", "2026-12-02", "2026-12-02", new Date("2026-08-01"));
    await leave(personB, "PENDING", "2026-12-03", "2026-12-03");
    await rule({
      maxPersons: 0,
      validFrom: new Date("2026-12-01T00:00:00Z"),
      validUntil: new Date("2026-12-31T00:00:00Z"),
      createdAt: new Date("2026-07-01T00:00:00Z"),
      updatedAt: new Date("2026-07-01T00:00:00Z"),
      name: "Weihnachtssperre",
    });
    const before = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: a.id } });

    const res = await load(tenantManager, `salonId=${one.salonId}&from=2026-12-01&to=2026-12-07`);
    expect(res.statusCode, res.body).toBe(200);
    const days = (JSON.parse(res.body) as Body).salons[0]!.groups[0]!.days;
    expect(days.map((d) => [d.day, d.count, d.exceeded])).toEqual([
      ["2026-12-02", 2, true],
      ["2026-12-03", 2, true],
    ]);
    expect(days[0]!.max).toBe(0);
    expect(days[0]!.ruleName).toBe("Weihnachtssperre");
    // 2 Dec: A approved before the rule, B approved after -> one marker; 3 Dec: A before, B PENDING
    expect(days[0]!.approvedBeforeRuleCount).toBe(1);
    expect(days[1]!.approvedBeforeRuleCount).toBe(1);
    const byId = (d: DayItem, id: string) => d.persons.find((p) => p.employeeId === id)!;
    expect(byId(days[0]!, personA).approvedBeforeRule).toBe(true);
    expect(byId(days[0]!, personB).approvedBeforeRule).toBe(false);
    expect(byId(days[1]!, personB).approvedBeforeRule).toBe(false);

    const after = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: a.id } });
    expect(after).toEqual(before);
    expect(await auditRowsFor(app, "LeaveRequest", a.id)).toHaveLength(0);
  });

  it("treats an in-place tightening as a new rule for the approved-before marker (WR-01)", async () => {
    // The rule is old (createdAt in January) but is tightened in place now: leave approved in October
    // predates the CURRENT rule and must carry the neutral marker, even though createdAt is older.
    await leave(personA, "APPROVED", "2026-12-02", "2026-12-02", new Date("2026-10-01"));
    const created = await rule({
      maxPersons: 5,
      validFrom: new Date("2026-12-01T00:00:00Z"),
      validUntil: new Date("2026-12-31T00:00:00Z"),
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      name: "Sperre",
    });
    const url = `salonId=${one.salonId}&from=2026-12-01&to=2026-12-07`;
    // untouched since January: the October approval is AFTER the rule, no marker
    const untouched = await load(tenantManager, url);
    const day0 = (JSON.parse(untouched.body) as Body).salons[0]!.groups[0]!.days;
    expect(day0.map((d) => [d.exceeded, d.approvedBeforeRuleCount])).toEqual([[false, 0]]);

    await app.prisma.leaveLimitRule.update({ where: { id: created.id }, data: { maxPersons: 0 } });
    const res = await load(tenantManager, url);
    expect(res.statusCode, res.body).toBe(200);
    const days = (JSON.parse(res.body) as Body).salons[0]!.groups[0]!.days;
    expect(days).toHaveLength(1);
    expect(days[0]!.exceeded).toBe(true);
    expect(days[0]!.approvedBeforeRuleCount).toBe(1);
    expect(days[0]!.persons.find((p) => p.employeeId === personA)!.approvedBeforeRule).toBe(true);
  });

  it("shows only groups with an applicable rule; the strictest rule of a group decides", async () => {
    await leave(personA, "APPROVED", "2026-08-05", "2026-08-05");
    await rule({ groupKind: "CLASSIFICATION", maxPersons: 3, name: "weit" });
    const strict = await rule({ groupKind: "CLASSIFICATION", maxPersons: 0, name: "eng" });
    const res = await load(tenantManager, `salonId=${one.salonId}&${WEEK}`);
    const salon = (JSON.parse(res.body) as Body).salons[0]!;
    expect(salon.groups.map((g) => g.groupKey)).toEqual(["CLASSIFICATION:VOLLZEIT"]);
    expect(salon.groups[0]!.days[0]).toMatchObject({
      max: 0,
      ruleId: strict.id,
      ruleName: "eng",
      exceeded: true,
    });
  });

  it("names only persons within the reader's leave reach, the rest is hiddenCount", async () => {
    await leave(personA, "APPROVED", "2026-08-05", "2026-08-05");
    await leave(personB, "PENDING", "2026-08-05", "2026-08-05");
    await rule();
    const res = await load(personReader, `salonId=${one.salonId}&${WEEK}`);
    expect(res.statusCode, res.body).toBe(200);
    const day = (JSON.parse(res.body) as Body).salons[0]!.groups[0]!.days[0]!;
    expect(day.count).toBe(2);
    expect(day.persons.map((p) => p.employeeId)).toEqual([personA]);
    expect(day.hiddenCount).toBe(1);
    expect(res.body).not.toContain(personB);
    expect(res.body).not.toContain("Beta836");

    const salonWide = await load(salonReader, `salonId=${one.salonId}&${WEEK}`);
    const wide = (JSON.parse(salonWide.body) as Body).salons[0]!.groups[0]!.days[0]!;
    expect(wide.persons).toHaveLength(2);
    expect(wide.hiddenCount).toBe(0);
  });

  it("without salonId a whole-tenant reader gets one block per active salon with an applicable rule", async () => {
    await leave(personA, "APPROVED", "2026-08-05", "2026-08-05");
    await rule();
    const one1 = JSON.parse((await load(tenantManager, WEEK)).body) as Body;
    expect(one1.salons.map((s) => s.salonId)).toEqual([one.salonId]);
    await rule({ salonId: null, name: "alle" });
    const both = JSON.parse((await load(tenantManager, WEEK)).body) as Body;
    expect(both.salons.map((s) => s.salonId).sort()).toEqual([one.salonId, s2].sort());
    // C is homed in S2: the all-salons rule is counted per salon, so C never loads S1
    await leave(personC, "APPROVED", "2026-08-05", "2026-08-05");
    const withC = JSON.parse((await load(tenantManager, WEEK)).body) as Body;
    const s2Days = withC.salons.find((s) => s.salonId === s2)!.groups[0]!.days;
    expect(s2Days.map((d) => [d.day, d.count, d.exceeded])).toEqual([["2026-08-05", 1, false]]);
    expect(s2Days[0]!.persons.map((p) => p.employeeId)).toEqual([personC]);
    expect(
      withC.salons.find((s) => s.salonId === one.salonId)!.groups[0]!.days.map((d) => d.count),
    ).toEqual([1]);
  });

  it("a salon-scoped reader without salonId sees only the salons in their reach", async () => {
    await rule({ salonId: null });
    const res = await load(s2Approver, WEEK);
    expect(res.statusCode, res.body).toBe(200);
    expect((JSON.parse(res.body) as Body).salons.map((s) => s.salonId)).toEqual([s2]);
  });

  it("a tenant without rules answers an empty list", async () => {
    const res = await load(tenantManager, WEEK);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ from: "2026-08-03", to: "2026-08-09", salons: [] });
  });

  it("validates the window: from after to and 93 days are 400, 92 days are served", async () => {
    const reversed = await load(tenantManager, "from=2026-08-09&to=2026-08-03");
    expect(reversed.statusCode).toBe(400);
    const tooLong = await load(tenantManager, "from=2026-01-01&to=2026-04-04");
    expect(tooLong.statusCode).toBe(400);
    expect(JSON.parse(tooLong.body).error).toBe("Der Zeitraum darf höchstens 92 Tage umfassen.");
    const ok = await load(tenantManager, "from=2026-01-01&to=2026-04-02");
    expect(ok.statusCode, ok.body).toBe(200);
    const malformed = await load(tenantManager, "from=2026-1-1&to=2026-01-05");
    expect(malformed.statusCode).toBe(400);
  });

  it("a foreign, unknown or out-of-reach salon is the one identical 404; neither key is 403", async () => {
    await rule();
    const bodies = new Set<string>();
    for (const [token, salonId] of [
      [tenantManager, two.salonId],
      [tenantManager, UNKNOWN_ID],
      [salonReader, s2],
      [s2Approver, one.salonId],
    ] as const) {
      const res = await load(token, `salonId=${salonId}&${WEEK}`);
      expect(res.statusCode, res.body).toBe(404);
      bodies.add(res.body);
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: "Salon nicht gefunden" })]);
    const denied = await load(readOnly, WEEK);
    expect(denied.statusCode).toBe(403);
  });
});
