/**
 * Issue #85 (Phase 85b Plan 16, gap closure) — `GET /api/v1/leave/overtime-balance?employeeId=…`
 * for a caller WITHOUT `overtime:read` coverage of the person.
 *
 * Phase 415 let the leave dialog read the live total saldo of a manager's selected employee,
 * gated only by `leave-entitlement:read:ZUGEWIESEN` plus the Stammsalon rule. A Salonmanager holds
 * that permission but, by the owner decision of 2026-08-27, must not learn the total saldo (it is
 * visible to Inhaber, Personalabteilung and the employee). Now every saldo-derived number of the
 * response is `null` and `balanceVisible` is `false` unless the caller is the person themself or
 * holds an `overtime:read` reach that covers them. The server-side OVERTIME_COMP limit check at
 * create/approve never reads this endpoint and is pinned by leave-overtime-comp-*.test.ts.
 *
 * Mutation proof (run during execution, restored with cp, never committed): dropping the mask in
 * the handler turns the Salonmanager and the overtime:read:EIGENE cases red.
 *
 * No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { normalizeRolePermissions, roleNameKey, SYSTEM_ROLE_IDS } from "../contexts/platform";

const PASSWORD = "test1234";

interface BalanceBody {
  balanceVisible: boolean;
  balanceHours: number | null;
  confirmedMinutes: number | null;
  openMonthMinutes: number | null;
  hasClosedMonth: boolean | null;
  maxNegativeBalanceMinutes: number | null;
  isNegativeLimitExceeded: boolean | null;
  [key: string]: unknown;
}

describe("Issue #85 (Phase 85b Plan 16) — GET /leave/overtime-balance saldo mask", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  const emp: Record<string, { id: string; userId: string; email: string }> = {};

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createPerson(label: string) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const email = `${s}@test.de`;
    const user = await app.prisma.user.create({
      data: { email, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "BalanceMask85b",
        hireDate: new Date("2020-01-01"),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: employee.id, balanceHours: "5" },
    });
    emp[label] = { id: employee.id, userId: user.id, email };
    return emp[label];
  }

  function assignHome(employeeId: string, salonId: string) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
  }

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  async function reader(
    label: string,
    permissions: string[],
    scope: { scopeType: "SALONS" | "TENANT"; salonIds?: string[] },
  ) {
    const person = await createPerson(label);
    await assignHome(person.id, salonB.id);
    const name = `Bm85b ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(permissions),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: person.userId,
        accessRoleId: role.id,
        scopeType: scope.scopeType,
        salonIds: scope.salonIds ?? [],
        employeeIds: [],
      },
    });
    return person;
  }

  async function balanceOf(token: string, employeeId?: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/overtime-balance${employeeId ? `?employeeId=${employeeId}` : ""}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.statusCode, body: JSON.parse(res.body) as BalanceBody };
  }

  let salonManagerToken = "";

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "bm85b");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "BM85B Salon A" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "BM85B Salon B" });

    // The person whose saldo is asked for: homed in salon A, with a closed month so the
    // confirmed figure is non-trivial.
    await createPerson("bm85b-target");
    await assignHome(emp["bm85b-target"].id, salonA.id);
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: emp["bm85b-target"].id,
        periodType: "MONTHLY",
        periodStart: new Date("2026-06-01T00:00:00Z"),
        periodEnd: new Date("2026-06-30T00:00:00Z"),
        workedMinutes: 9600,
        expectedMinutes: 9000,
        balanceMinutes: 0,
        carryOver: 600,
        closedAt: new Date("2026-07-01T06:00:00Z"),
        superseded: false,
      },
    });

    // The Salonmanager of A (system template: leave-entitlement:read, no overtime:read).
    await createPerson("bm85b-sm");
    await assignHome(emp["bm85b-sm"].id, salonB.id);
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: emp["bm85b-sm"].userId,
        accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
        scopeType: "SALONS",
        salonIds: [salonA.id],
        employeeIds: [],
      },
    });
    salonManagerToken = await login(emp["bm85b-sm"].email);
  });

  afterAll(async () => {
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data.tenant.id } });
      await app.prisma.accessRole.deleteMany({ where: { tenantId: data.tenant.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("leave-overtime-balance-mask-85b cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("the Salonmanager gets every saldo-derived number as null and balanceVisible false for an in-reach person", async () => {
    const { status, body } = await balanceOf(salonManagerToken, emp["bm85b-target"].id);
    expect(status).toBe(200);
    expect(body.balanceVisible).toBe(false);
    expect(body.balanceHours).toBeNull();
    expect(body.confirmedMinutes).toBeNull();
    expect(body.openMonthMinutes).toBeNull();
    expect(body.hasClosedMonth).toBeNull();
    expect(body.isNegativeLimitExceeded).toBeNull();
    // The configured tolerance is configuration, not a saldo-derived number.
    expect("maxNegativeBalanceMinutes" in body).toBe(true);
    // Nothing else may smuggle the balance through (e.g. a roster flag computed from it).
    expect(Object.keys(body).sort()).toEqual(
      [
        "balanceHours",
        "balanceVisible",
        "confirmedMinutes",
        "hasClosedMonth",
        "isNegativeLimitExceeded",
        "maxNegativeBalanceMinutes",
        "openMonthMinutes",
      ].sort(),
    );
  });

  it("a person outside the Salonmanager's reach is still a 404, not a masked 200", async () => {
    await createPerson("bm85b-pb");
    await assignHome(emp["bm85b-pb"].id, salonB.id);
    const res = await balanceOf(salonManagerToken, emp["bm85b-pb"].id);
    expect(res.status).toBe(404);
  });

  it("a Salonmanager reading their OWN saldo gets the numbers and balanceVisible true", async () => {
    const own = await balanceOf(salonManagerToken);
    expect(own.status).toBe(200);
    expect(own.body.balanceVisible).toBe(true);
    expect(typeof own.body.balanceHours).toBe("number");
    expect(typeof own.body.confirmedMinutes).toBe("number");
    const viaId = await balanceOf(salonManagerToken, emp["bm85b-sm"].id);
    expect(viaId.body.balanceVisible).toBe(true);
  });

  it("the employee themself gets the numbers and balanceVisible true", async () => {
    const token = await login(emp["bm85b-target"].email);
    const { status, body } = await balanceOf(token);
    expect(status).toBe(200);
    expect(body.balanceVisible).toBe(true);
    expect(body.confirmedMinutes).toBe(600);
    expect(typeof body.balanceHours).toBe("number");
  });

  it("an admin (whole-tenant overtime:read) gets the numbers and balanceVisible true", async () => {
    const { status, body } = await balanceOf(data.adminToken, emp["bm85b-target"].id);
    expect(status).toBe(200);
    expect(body.balanceVisible).toBe(true);
    expect(body.confirmedMinutes).toBe(600);
    expect(typeof body.balanceHours).toBe("number");
    expect(typeof body.isNegativeLimitExceeded).toBe("boolean");
  });

  it("the Personalabteilung (overtime:read:ZUGEWIESEN, tenant scope) gets the numbers", async () => {
    const hr = await createPerson("bm85b-hr");
    await assignHome(hr.id, salonB.id);
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: hr.userId,
        accessRoleId: SYSTEM_ROLE_IDS.HR,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    const { status, body } = await balanceOf(await login(hr.email), emp["bm85b-target"].id);
    expect(status).toBe(200);
    expect(body.balanceVisible).toBe(true);
    expect(body.confirmedMinutes).toBe(600);
  });

  it("a reader with overtime:read:ZUGEWIESEN over salon A gets the numbers for a person of A", async () => {
    const r = await reader(
      "bm85b-ot-a",
      ["leave-entitlement:read:ZUGEWIESEN", "overtime:read:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const { status, body } = await balanceOf(await login(r.email), emp["bm85b-target"].id);
    expect(status).toBe(200);
    expect(body.balanceVisible).toBe(true);
    expect(body.confirmedMinutes).toBe(600);
  });

  it("a reader whose overtime:read is only EIGENE gets the mask for another person", async () => {
    const r = await reader(
      "bm85b-ot-own",
      ["leave-entitlement:read:ZUGEWIESEN", "overtime:read:EIGENE"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const { status, body } = await balanceOf(await login(r.email), emp["bm85b-target"].id);
    expect(status).toBe(200);
    expect(body.balanceVisible).toBe(false);
    expect(body.balanceHours).toBeNull();
    expect(body.confirmedMinutes).toBeNull();
    expect(body.isNegativeLimitExceeded).toBeNull();
  });
});
