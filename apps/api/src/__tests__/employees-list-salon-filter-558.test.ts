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
 * Mutation proof (Phase 558, 2026-10-16) — recorded here, not re-run by CI; each change was
 * reverted (cp restore, `git diff --quiet` clean) after confirming the observed failures:
 * M1 the `resolveSalonInReach` early return removed (`if (!salon.ok) return …`) → red: "a foreign
 *    tenant's salon, an unknown id and an inactive salon answer the same 404 body (T-100-09)",
 *    "a Salonmanager of A asking for B gets the body of an unknown id, a foreign salon and an
 *    inactive salon", "the admin asking for the inactive salon gets the same body".
 * M2 the own row force-added under a filter (`[...inSalonIds, ownEmployeeId]`) → red: "the admin's
 *    own employee (no salon) is absent under ?salonId=A and present without a filter", "the
 *    admin's list under ?salonId=A holds exactly the persons of A …", "a Salonmanager of A lists
 *    the same persons as the admin does for A", "an anonymized person of a salon is listed only
 *    with includeAnonymized=true".
 * M3 the intersection with the caller's `employee:read` reach dropped (`limit = null`) AND the
 *    validator bypassed (`{ ok: true, salonId }`) → red: the same three 404 cases as M1 (the
 *    manager of A asking for B received the persons of B instead of the 404).
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
  let salonC: { id: string };
  let single: Awaited<ReturnType<typeof seedTestData>>;
  let managerToken = "";
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
    salonC = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Mitte" });
    single = await seedTestData(app, "sal558s");

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

    // Stored balances make the saldo mask non-vacuous: a Salonmanager has no overtime:read.
    await app.prisma.overtimeAccount.create({
      data: { employeeId: people.manager.id, balanceHours: "2" },
    });

    people.pA = await createEmployee("pA", data.tenant.id);
    await app.prisma.overtimeAccount.create({
      data: { employeeId: people.pA.id, balanceHours: "5" },
    });
    await assign(data.tenant.id, people.pA.id, salonA.id, "HOME", "2024-01-01T00:00:00Z");
    people.pB = await createEmployee("pB", data.tenant.id);
    await assign(data.tenant.id, people.pB.id, salonB.id, "HOME", "2024-01-01T00:00:00Z");
    people.springer = await createEmployee("springer", data.tenant.id);
    await app.prisma.overtimeAccount.create({
      data: { employeeId: people.springer.id, balanceHours: "7" },
    });
    await assign(data.tenant.id, people.springer.id, salonB.id, "HOME", "2024-01-01T00:00:00Z");
    await assign(
      data.tenant.id,
      people.springer.id,
      salonA.id,
      "DEPLOYMENT",
      "2026-06-01T00:00:00Z",
      "2026-06-30T00:00:00Z",
    );

    managerToken = await login(people.manager.email);

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
      await cleanupTestData(app, single.tenant.id);
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
    expect(await ids(managerToken, `?salonId=${salonA.id}`)).toEqual(
      await ids(data.adminToken, `?salonId=${salonA.id}`),
    );
  });

  describe("every inadmissible salon answers the one 404 (T-100-09)", () => {
    it("a Salonmanager of A asking for B gets the body of an unknown id, a foreign salon and an inactive salon", async () => {
      const reference = await get(managerToken, `?salonId=${randomUUID()}`);
      expect(reference.statusCode).toBe(404);
      expect(reference.body).toBe(NOT_FOUND_BODY);
      for (const salonId of [salonB.id, salonF.id, salonI.id]) {
        const res = await get(managerToken, `?salonId=${salonId}`);
        expect(res.statusCode).toBe(reference.statusCode);
        expect(res.body).toBe(reference.body);
      }
      // The zero is the scope, not an empty fixture: the same manager does see salon A.
      expect((await ids(managerToken, `?salonId=${salonA.id}`)).length).toBeGreaterThan(0);
    });

    it("the admin asking for the inactive salon gets the same body", async () => {
      const res = await get(data.adminToken, `?salonId=${salonI.id}`);
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(NOT_FOUND_BODY);
    });

    it("a malformed salon id answers 400, never a list", async () => {
      const res = await get(data.adminToken, "?salonId=not-a-uuid");
      expect(res.statusCode).toBe(400);
    });
  });

  describe("the caller's own row follows the filter", () => {
    it("the admin's own employee (no salon) is absent under ?salonId=A and present without a filter", async () => {
      expect(await ids(data.adminToken, `?salonId=${salonA.id}`)).not.toContain(
        data.adminEmployee.id,
      );
      expect(await ids(data.adminToken)).toContain(data.adminEmployee.id);
    });

    it("the Salonmanager's own row is listed because they are homed in A", async () => {
      expect(await ids(managerToken, `?salonId=${salonA.id}`)).toContain(people.manager.id);
    });
  });

  describe("anonymized rows", () => {
    it("an anonymized person of a salon is listed only with includeAnonymized=true", async () => {
      people.pX = await createEmployee("pX", data.tenant.id);
      await assign(data.tenant.id, people.pX.id, salonC.id, "HOME", "2024-01-01T00:00:00Z");
      expect(await ids(data.adminToken, `?salonId=${salonC.id}`)).toEqual([people.pX.id]);

      const del = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${people.pX.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(del.statusCode, del.body).toBeLessThan(300);

      expect(await ids(data.adminToken, `?salonId=${salonC.id}`)).toEqual([]);
      expect(await ids(data.adminToken, `?includeAnonymized=true&salonId=${salonC.id}`)).toEqual([
        people.pX.id,
      ]);
    });
  });

  describe("the response shape and the saldo mask are unchanged under a filter", () => {
    it("every filtered row carries exactly the keys of the same person's unfiltered row", async () => {
      const unfiltered = JSON.parse((await get(data.adminToken)).body) as ListRow[];
      const filtered = JSON.parse(
        (await get(data.adminToken, `?salonId=${salonA.id}`)).body,
      ) as ListRow[];
      expect(filtered.length).toBeGreaterThan(0);
      for (const row of filtered) {
        const same = unfiltered.find((r) => r.id === row.id);
        expect(same, `row ${row.id} present unfiltered`).toBeDefined();
        expect(Object.keys(row).sort((a, b) => a.localeCompare(b))).toEqual(
          Object.keys(same!).sort((a, b) => a.localeCompare(b)),
        );
      }
    });

    it("the Salonmanager (no overtime:read) sees balanceHours null for every listed person, the admin the stored value", async () => {
      const managerRows = JSON.parse(
        (await get(managerToken, `?salonId=${salonA.id}`)).body,
      ) as (ListRow & { overtimeAccount: { balanceHours: unknown } | null })[];
      expect(managerRows.length).toBeGreaterThan(0);
      for (const row of managerRows) expect(row.overtimeAccount?.balanceHours ?? null).toBeNull();

      const adminRows = JSON.parse(
        (await get(data.adminToken, `?salonId=${salonA.id}`)).body,
      ) as (ListRow & { overtimeAccount: { balanceHours: unknown } | null })[];
      const pARow = adminRows.find((r) => r.id === people.pA.id);
      expect(Number(pARow?.overtimeAccount?.balanceHours)).toBe(5);
    });
  });

  describe("single-salon tenant", () => {
    it("without a salonId both seed employees are listed although neither has a salon assignment", async () => {
      // The web never sends a salonId for such a tenant (D-03); the unfiltered list is complete.
      expect(await ids(single.adminToken)).toEqual(
        expect.arrayContaining([single.adminEmployee.id, single.employee.id]),
      );
    });
  });
});
