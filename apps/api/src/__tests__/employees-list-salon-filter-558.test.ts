/**
 * Issue #558 (D-01, D-08, D-11) — the salon filter of the people list.
 *
 * `GET /api/v1/employees?salonId=<X>` is a narrowing of the #547 list: the master-data rule of
 * Phase 91b D-12 (Stammsalon today OR an active deployment today) evaluated for a salon-only reach,
 * intersected with the caller's own `employee:read` reach, and validated by the one Unterbau
 * validator (`resolveSalonInReach`) before any employee row is read. Without `salonId` the response
 * is the unchanged pre-#558 list.
 *
 * Fixture: tenant T with salons A, B and an inactive salon I; a foreign tenant with salon F. People
 * (labels only, no names): `manager` (HOME A, Salonmanager over [A]), `pA` (HOME A), `pB` (HOME B),
 * `springer` (HOME B plus a DEPLOYMENT in A valid over today). The two seed employees of
 * `seedTestData` carry no salon assignment at all.
 *
 * Harness: fake clock 2026-06-15T10:00Z installed BEFORE the app boots (the deployment window is
 * date-sensitive).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";

const PASSWORD = "test1234";
const NOT_FOUND_BODY = '{"error":"Salon nicht gefunden"}';

interface ListRow {
  id: string;
  [key: string]: unknown;
}

describe("Issue #558 — GET /employees?salonId narrows the people list", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let salonI: { id: string };
  let salonF: { id: string };
  const people: Record<string, { id: string; userId: string; email: string }> = {};

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createEmployee(label: string, tenantId: string) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const email = `${s}@example.invalid`;
    const user = await app.prisma.user.create({
      data: { email, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "Flt558",
        hireDate: new Date("2024-01-01"),
      },
    });
    return { id: employee.id, userId: user.id, email };
  }

  function assign(
    tenantId: string,
    employeeId: string,
    salonId: string,
    kind: "HOME" | "DEPLOYMENT",
    validFrom: string,
    validUntil: string | null = null,
  ) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId,
        salonId,
        kind,
        validFrom: new Date(validFrom),
        validUntil: validUntil ? new Date(validUntil) : null,
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
    expect(res.statusCode, res.body).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  function get(token: string, query = "") {
    return app.inject({
      method: "GET",
      url: `/api/v1/employees${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function ids(token: string, query = ""): Promise<string[]> {
    const res = await get(token, query);
    expect(res.statusCode, res.body).toBe(200);
    return (JSON.parse(res.body) as ListRow[]).map((r) => r.id).sort((a, b) => a.localeCompare(b));
  }

  const sorted = (list: string[]) => [...list].sort((a, b) => a.localeCompare(b));

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "sal558e");
    foreign = await seedTestData(app, "sal558f");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Nord" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Ost" });
    salonI = await createTestSalon(app.prisma, data.tenant.id, {
      name: "Salon Inaktiv",
      isActive: false,
    });
    salonF = await createTestSalon(app.prisma, foreign.tenant.id, { name: "Salon Fremd" });

    people.manager = await createEmployee("manager", data.tenant.id);
    await assign(data.tenant.id, people.manager.id, salonA.id, "HOME", "2024-01-01T00:00:00Z");
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: people.manager.userId,
        accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
        scopeType: "SALONS",
        salonIds: [salonA.id],
        employeeIds: [],
      },
    });

    people.pA = await createEmployee("pA", data.tenant.id);
    await assign(data.tenant.id, people.pA.id, salonA.id, "HOME", "2024-01-01T00:00:00Z");
    people.pB = await createEmployee("pB", data.tenant.id);
    await assign(data.tenant.id, people.pB.id, salonB.id, "HOME", "2024-01-01T00:00:00Z");
    people.springer = await createEmployee("springer", data.tenant.id);
    await assign(data.tenant.id, people.springer.id, salonB.id, "HOME", "2024-01-01T00:00:00Z");
    await assign(
      data.tenant.id,
      people.springer.id,
      salonA.id,
      "DEPLOYMENT",
      "2026-06-01T00:00:00Z",
      "2026-06-30T00:00:00Z",
    );

    // A foreign person homed in F: makes the foreign-vs-unknown identity non-vacuous.
    const pF = await createEmployee("pF", foreign.tenant.id);
    await assign(foreign.tenant.id, pF.id, salonF.id, "HOME", "2024-01-01T00:00:00Z");
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data.tenant.id } });
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, foreign.tenant.id);
    } catch (err) {
      console.error("employees-list-salon-filter-558 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("the admin's list under ?salonId=A holds exactly the persons of A (Stammsalon or deployment today)", async () => {
    expect(await ids(data.adminToken, `?salonId=${salonA.id}`)).toEqual(
      sorted([people.manager.id, people.pA.id, people.springer.id]),
    );
  });

  it("without salonId the list is the unchanged one: every person including those without a salon", async () => {
    const all = await ids(data.adminToken);
    expect(all).toEqual(
      expect.arrayContaining([
        people.manager.id,
        people.pA.id,
        people.pB.id,
        people.springer.id,
        data.adminEmployee.id,
        data.employee.id,
      ]),
    );
  });

  it("a foreign tenant's salon, an unknown id and an inactive salon answer the same 404 body (T-100-09)", async () => {
    const foreignRes = await get(data.adminToken, `?salonId=${salonF.id}`);
    const unknownRes = await get(data.adminToken, `?salonId=${randomUUID()}`);
    const inactiveRes = await get(data.adminToken, `?salonId=${salonI.id}`);
    expect(foreignRes.statusCode).toBe(404);
    expect(foreignRes.statusCode).toBe(unknownRes.statusCode);
    expect(foreignRes.statusCode).toBe(inactiveRes.statusCode);
    expect(foreignRes.body).toBe(NOT_FOUND_BODY);
    expect(foreignRes.body).toBe(unknownRes.body);
    expect(foreignRes.body).toBe(inactiveRes.body);
  });

  it("a Salonmanager of A lists the same persons as the admin does for A", async () => {
    const managerToken = await login(people.manager.email);
    expect(await ids(managerToken, `?salonId=${salonA.id}`)).toEqual(
      await ids(data.adminToken, `?salonId=${salonA.id}`),
    );
  });
});
