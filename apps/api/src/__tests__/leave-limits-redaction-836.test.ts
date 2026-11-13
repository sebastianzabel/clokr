/**
 * Issue #836 (AC-12, D-836-12) — a limit warning and the 409 name another person only to a reader who may
 * already read that person's leave (`leave-request:read:ZUGEWIESEN`, or themself); everyone else gets a
 * number, and no field says who is hidden.
 *
 * Fixture (fake clock 2026-06-15T10:00Z, installed BEFORE the app boots): one tenant with its default
 * salon S1 and a second salon S2. Persons A and C (raw employees, Mo-Fr, homed in S1) have approved
 * vacation Wed 5 .. Fri 7 Aug 2026; B (the seeded employee, homed in S1) asks for the same days; a rule
 * "at most 1" holds for S1. So every reported day has count 3 = B + A + C. The readers are custom roles
 * built here (an approver with approve + read, an approver whose read is one person, an approver whose
 * read reaches only S2). Distinct last names make a leak greppable. No real names.
 *
 * Mutation proof (Phase 836, 2026-11-06) — recorded, not re-run by CI; reverted with cp afterwards:
 * M1 redact.ts `isPersonVisibleOn`: `vis.wholeTenant ||` turned into `true ||` (everyone is visible) ->
 *    red: the own-data POST case, the "read reach of one person" case and the "S2-only" case.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
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

const PASSWORD = "test1234";
const REASON = "Hochzeit der Tochter, mit Team abgestimmt";

type DayItem = {
  day: string;
  count: number;
  max: number;
  persons: Array<{ employeeId: string; firstName: string; lastName: string }>;
  hiddenCount: number;
};
type Exceedances = Array<{ days: DayItem[] }>;

describe("Issue #836 — names in limit warnings only within the leave reach", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salon2: string;
  let personA: string;
  let personC: string;
  let tenantReader: string;
  let salonApprover: string;
  let personApprover: string;
  let foreignSalonApprover: string;

  async function rawEmployee(tag: string, lastName: string) {
    const user = await app.prisma.user.create({
      data: {
        email: `${tag}-${crypto.randomBytes(3).toString("hex")}@example.invalid`,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        isActive: true,
      },
    });
    const emp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
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
    await home(emp.id, data.salonId);
    return emp.id;
  }

  function home(employeeId: string, salonId: string) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date("2024-01-01T00:00:00Z"),
        validUntil: null,
        weekdays: [],
      },
    });
  }

  /** A user holding one stored assignment per `grants` entry (role permissions + scope). */
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
      data: { email, passwordHash: await bcrypt.hash(PASSWORD, 4), isActive: true },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `R${crypto.randomBytes(4).toString("hex")}`,
        firstName: "R",
        lastName: "Actor836r",
        hireDate: new Date("2024-01-01"),
      },
    });
    for (const grant of grants) {
      const name = `Redact836 ${crypto.randomBytes(3).toString("hex")}`;
      const role = await app.prisma.accessRole.create({
        data: {
          tenantId: data.tenant.id,
          name,
          nameKey: roleNameKey(name),
          permissions: normalizeRolePermissions(grant.permissions),
        },
      });
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: data.tenant.id,
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

  function leave(employeeId: string, status: "APPROVED" | "PENDING") {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2026-08-05T00:00:00Z"),
        endDate: new Date("2026-08-07T00:00:00Z"),
        days: 3,
        status,
      },
    });
  }

  function rule() {
    return app.prisma.leaveLimitRule.create({
      data: {
        tenantId: data.tenant.id,
        salonId: data.salonId,
        groupKind: "ALL",
        maxPersons: 1,
        name: "Fixture rule",
      },
    });
  }

  function review(id: string, token: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/review`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  function post(token: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${token}` },
      payload: { type: "VACATION", startDate: "2026-08-05", endDate: "2026-08-07", ...payload },
    });
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "lv836d");
    salon2 = (await createTestSalon(app.prisma, data.tenant.id, { name: "Redact836 S2" })).id;
    personA = await rawEmployee("A", "Alpha836");
    personC = await rawEmployee("C", "Gamma836");
    await home(data.employee.id, data.salonId);

    const read = "leave-request:read:ZUGEWIESEN";
    const approve = "leave-request:approve:ZUGEWIESEN";
    tenantReader = await actor("tr", [
      {
        permissions: ["leave-request:create:ZUGEWIESEN", read],
        scope: { scopeType: "TENANT" },
      },
    ]);
    salonApprover = await actor("sa", [
      { permissions: [approve, read], scope: { scopeType: "SALONS", salonIds: [data.salonId] } },
    ]);
    personApprover = await actor("pa", [
      { permissions: [approve], scope: { scopeType: "SALONS", salonIds: [data.salonId] } },
      { permissions: [read], scope: { scopeType: "PERSONS", employeeIds: [personC] } },
    ]);
    foreignSalonApprover = await actor("fa", [
      { permissions: [approve], scope: { scopeType: "SALONS", salonIds: [data.salonId] } },
      { permissions: [read], scope: { scopeType: "SALONS", salonIds: [salon2] } },
    ]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.prisma.leaveLimitRule.deleteMany({ where: { tenantId: data.tenant.id } });
    await app.prisma.leaveRequest.deleteMany({
      where: { employee: { tenantId: data.tenant.id } },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function fixtureWithRule() {
    await leave(personA, "APPROVED");
    await leave(personC, "APPROVED");
    await rule();
  }

  it("an own-data-only requester gets counts: no persons, the rest as hiddenCount, no id or name in the body", async () => {
    await fixtureWithRule();
    const res = await post(data.empToken, {});
    expect(res.statusCode, res.body).toBe(201);
    const warnings = (JSON.parse(res.body) as { leaveLimitWarnings: Exceedances })
      .leaveLimitWarnings;
    for (const day of warnings[0]!.days) {
      expect(day.count).toBe(3);
      expect(day.persons).toEqual([]);
      expect(day.hiddenCount).toBe(2);
    }
    for (const secret of [personA, personC, "Alpha836", "Gamma836"]) {
      expect(res.body).not.toContain(secret);
    }
  });

  it("a manager with a whole-tenant read reach creating on behalf of B sees both names", async () => {
    await fixtureWithRule();
    const res = await post(tenantReader, { employeeId: data.employee.id });
    expect(res.statusCode, res.body).toBe(201);
    const warnings = (JSON.parse(res.body) as { leaveLimitWarnings: Exceedances })
      .leaveLimitWarnings;
    const day = warnings[0]!.days[0]!;
    expect(day.persons.map((p) => [p.employeeId, p.lastName])).toEqual([
      [personA, "Alpha836"],
      [personC, "Gamma836"],
    ]);
    expect(day.hiddenCount).toBe(0);
  });

  it("an approver whose read reach is salon S1 gets a 409 naming the other S1 persons", async () => {
    await fixtureWithRule();
    const pending = await leave(data.employee.id, "PENDING");
    const res = await review(pending.id, salonApprover, { status: "APPROVED" });
    expect(res.statusCode, res.body).toBe(409);
    const day = (JSON.parse(res.body) as { exceedances: Exceedances }).exceedances[0]!.days[0]!;
    expect(day.persons.map((p) => p.employeeId)).toEqual([personA, personC]);
    expect(day.hiddenCount).toBe(0);
  });

  it("an approver whose read reach is one unrelated employee sees that person only, the other in hiddenCount", async () => {
    await fixtureWithRule();
    const pending = await leave(data.employee.id, "PENDING");
    const res = await review(pending.id, personApprover, { status: "APPROVED" });
    expect(res.statusCode, res.body).toBe(409);
    const day = (JSON.parse(res.body) as { exceedances: Exceedances }).exceedances[0]!.days[0]!;
    expect(day.persons.map((p) => p.employeeId)).toEqual([personC]);
    expect(day.hiddenCount).toBe(1);
    expect(res.body).not.toContain(personA);
    expect(res.body).not.toContain("Alpha836");
  });

  it("an approver whose read reach is only salon S2 sees counts only", async () => {
    await fixtureWithRule();
    const pending = await leave(data.employee.id, "PENDING");
    const res = await review(pending.id, foreignSalonApprover, { status: "APPROVED" });
    expect(res.statusCode, res.body).toBe(409);
    const day = (JSON.parse(res.body) as { exceedances: Exceedances }).exceedances[0]!.days[0]!;
    expect(day.persons).toEqual([]);
    expect(day.hiddenCount).toBe(2);
    for (const secret of [personA, personC, "Alpha836", "Gamma836"]) {
      expect(res.body).not.toContain(secret);
    }
  });

  it("the APPROVE audit keeps counts and ids of rules and salons: no person id, no name", async () => {
    await fixtureWithRule();
    const pending = await leave(data.employee.id, "PENDING");
    const res = await review(pending.id, salonApprover, {
      status: "APPROVED",
      limitException: { reason: REASON },
    });
    expect(res.statusCode, res.body).toBe(200);
    const rows = await auditRowsFor(app, "LeaveRequest", pending.id, "APPROVE");
    expect(rows).toHaveLength(1);
    const serialised = JSON.stringify(rows[0]!.newValue);
    expect(serialised).toContain("leaveLimitException");
    for (const secret of [personA, personC, "Alpha836", "Gamma836"]) {
      expect(serialised).not.toContain(secret);
    }
  });
});
