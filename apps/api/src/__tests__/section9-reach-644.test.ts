/**
 * Issue #644 — `GET /leave/section9` (and `GET /leave/section9/:id`) honour the reach of
 * `section9:read:ZUGEWIESEN`. A salon-scoped manager used to receive the § 9 cases of the whole
 * tenant, including the sick-leave periods behind them (health data, Art. 9 DSGVO).
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { DEFAULT_SALON_OPENING_HOURS } from "../contexts/platform/facade/salons";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";
import { leaveTypeFields } from "../contexts/absence/leave-type";

const PASSWORD = "test1234";

describe("Issue #644 — § 9 case reach", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let sickTypeId: string;
  let creditA: { id: string };
  let creditB: { id: string };
  let ownCredit: { id: string };

  function suffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createEmployee(label: string) {
    const s = suffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "S9Reach",
        hireDate: new Date("2020-01-01"),
      },
    });
    return { user, employee };
  }

  async function seedCredit(employeeId: string, salonId: string, day: string) {
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date("2020-01-01"),
        weekdays: [],
      },
    });
    const mk = (typeId: string) =>
      app.prisma.leaveRequest.create({
        data: {
          employeeId,
          leaveTypeId: typeId,
          startDate: new Date(day),
          endDate: new Date(day),
          days: 1,
          status: "APPROVED",
        },
      });
    const sick = await mk(sickTypeId);
    const vac = await mk(data.vacationType.id);
    return app.prisma.section9Credit.create({
      data: {
        employeeId,
        sickRequestId: sick.id,
        vacationRequestId: vac.id,
        overlapStart: new Date(day),
        overlapEnd: new Date(day),
      },
    });
  }

  async function loginAs(
    created: Awaited<ReturnType<typeof createEmployee>>,
    permissions: string[],
    scope: { scopeType: "SALONS" | "TENANT"; salonIds?: string[] },
  ) {
    const name = `S9Reach ${crypto.randomBytes(3).toString("hex")}`;
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
        userId: created.user.id,
        accessRoleId: role.id,
        scopeType: scope.scopeType,
        salonIds: scope.salonIds ?? [],
        employeeIds: [],
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: created.user.email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  const get = (url: string, token: string) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  const idsOf = (body: string) => (JSON.parse(body) as Array<{ id: string }>).map((r) => r.id);

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "s9r");
    const mkSalon = (name: string) =>
      app.prisma.salon.create({
        data: {
          tenantId: data.tenant.id,
          name,
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: true,
          federalState: "NIEDERSACHSEN",
        },
      });
    salonA = await mkSalon("S9R Salon A");
    salonB = await mkSalon("S9R Salon B");
    const sickType = await app.prisma.leaveType.create({
      data: { tenantId: data.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
    });
    sickTypeId = sickType.id;
    const empA = await createEmployee("emp-a");
    const empB = await createEmployee("emp-b");
    creditA = await seedCredit(empA.employee.id, salonA.id, "2026-03-10");
    creditB = await seedCredit(empB.employee.id, salonB.id, "2026-03-11");
    ownerSelf = await createEmployee("self");
    ownCredit = await seedCredit(ownerSelf.employee.id, salonA.id, "2026-03-12");
  });

  let ownerSelf: Awaited<ReturnType<typeof createEmployee>>;

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("a SALONS-scoped manager of salon A sees only salon A's cases, list and single", async () => {
    const mgr = await createEmployee("mgr-a");
    const token = await loginAs(mgr, ["section9:read:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    const list = await get("/api/v1/leave/section9", token);
    expect(list.statusCode).toBe(200);
    const ids = idsOf(list.body);
    expect(ids).toContain(creditA.id);
    expect(ids).not.toContain(creditB.id);

    expect((await get(`/api/v1/leave/section9/${creditA.id}`, token)).statusCode).toBe(200);
    const foreign = await get(`/api/v1/leave/section9/${creditB.id}`, token);
    const unknown = await get(`/api/v1/leave/section9/${crypto.randomUUID()}`, token);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).toBe(unknown.body);
  });

  it("a whole-tenant caller sees both cases", async () => {
    const mgr = await createEmployee("mgr-all");
    const token = await loginAs(mgr, ["section9:read:ZUGEWIESEN"], { scopeType: "TENANT" });
    const list = await get("/api/v1/leave/section9", token);
    expect(list.statusCode).toBe(200);
    expect(idsOf(list.body)).toEqual(expect.arrayContaining([creditA.id, creditB.id]));
    expect((await get(`/api/v1/leave/section9/${creditB.id}`, token)).statusCode).toBe(200);
  });

  it("the EIGENE view returns the caller's own cases only", async () => {
    const token = await loginAs(ownerSelf, ["section9:read:EIGENE"], { scopeType: "TENANT" });
    const list = await get("/api/v1/leave/section9", token);
    expect(list.statusCode).toBe(200);
    expect(idsOf(list.body)).toEqual([ownCredit.id]);
  });
});
