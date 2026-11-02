/**
 * Issue #641 (Release B of #539) - the phase tracer. The role of a person lives ONLY in stored
 * `RoleAssignment` rows: no request path writes or reads a role column of `User`, and no audit row
 * written by a role change carries a derived compat value. The employee responses keep serving the
 * role DERIVED from the stored assignments under `user.role`.
 *
 * The file reads behaviour only (HTTP, RoleAssignment, AuditLog) - it never selects or filters a
 * role column, so it stays valid after the column is dropped. Plan 641-05 extends it with the
 * migration and catalog cases.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, soleAuditRow } from "./setup";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";

// POST /employees validates the tenant password policy; the seeded admin bypasses it.
const POLICY_PASSWORD = "Test@1234567!";

describe("Issue #641 - the role lives only in stored assignments", () => {
  let app: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof seedTestData>>;

  function auth() {
    return { authorization: `Bearer ${tenant.adminToken}` };
  }

  async function createPerson(role: "ADMIN" | "MANAGER" | "EMPLOYEE") {
    const uid = crypto.randomBytes(4).toString("hex");
    const email = `drop641-${uid}@example.invalid`;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: auth(),
      payload: {
        usualWorkDays: [1, 2, 3, 4, 5],
        email,
        firstName: "Test",
        lastName: "Person",
        employeeNumber: `D6-${uid}`,
        hireDate: "2026-01-01T00:00:00.000Z",
        role,
        password: POLICY_PASSWORD,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: string; userId: string; user: { role: unknown } };
    expect(body.userId).toBeTruthy();
    return { employeeId: body.id, userId: body.userId, createdRole: body.user.role };
  }

  function storedRows(userId: string) {
    return app.prisma.roleAssignment.findMany({
      where: { tenantId: tenant.tenant.id, userId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  async function servedRole(employeeId: string): Promise<unknown> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${employeeId}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { user: { role: unknown } }).user.role;
  }

  beforeAll(async () => {
    app = await getTestApp();
    tenant = await seedTestData(app, "641-drop");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenant.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("role change and revoke", () => {
    let person: Awaited<ReturnType<typeof createPerson>>;
    let managerRowId: string;

    it("a role change through the employee form stores the role only as an assignment", async () => {
      person = await createPerson("EMPLOYEE");
      const before = await storedRows(person.userId);
      expect(before).toHaveLength(1);
      const startedAt = new Date();

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/employees/${person.employeeId}`,
        headers: auth(),
        payload: { role: "MANAGER" },
      });
      expect(res.statusCode).toBe(200);

      expect(await servedRole(person.employeeId)).toBe("MANAGER");
      const rows = await storedRows(person.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0].accessRoleId).toBe(SYSTEM_ROLE_IDS.MANAGER);
      expect(rows[0].scopeType).toBe("TENANT");
      managerRowId = rows[0].id;

      const audits = await app.prisma.auditLog.findMany({
        where: {
          createdAt: { gte: startedAt },
          entityId: { in: [person.userId, before[0].id, managerRowId] },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      expect(audits.length).toBeGreaterThan(0);
      for (const audit of audits) {
        expect(audit.entity).not.toBe("User");
        const value = (audit.newValue ?? {}) as Record<string, unknown>;
        expect(Object.keys(value)).not.toContain("compatRole");
      }
    });

    it("revoking the last assignment leaves no derived role and no compat value", async () => {
      const startedAt = new Date();
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/role-assignments/${managerRowId}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(204);

      expect(await servedRole(person.employeeId)).toBeNull();
      expect(await storedRows(person.userId)).toHaveLength(0);

      const deleteRow = await soleAuditRow(app.prisma, {
        where: {
          entity: "RoleAssignment",
          entityId: managerRowId,
          action: "DELETE",
        },
      });
      const oldValue = (deleteRow.oldValue ?? {}) as Record<string, unknown>;
      const newValue = (deleteRow.newValue ?? {}) as Record<string, unknown>;
      expect(Object.keys(oldValue)).not.toContain("compatRole");
      expect(Object.keys(newValue)).not.toContain("compatRole");

      const userRows = await app.prisma.auditLog.count({
        where: { entity: "User", entityId: person.userId, createdAt: { gte: startedAt } },
      });
      expect(userRows).toBe(0);
    });
  });

  describe("admin sign-in (ISSUE-641-AC6)", () => {
    it("the seeded admin signs in with a non-empty permission list and no role key", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: tenant.adminUser.email, password: "test1234" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { user: Record<string, unknown> };
      expect((body.user.permissions as string[]).length).toBeGreaterThan(0);
      expect(Object.keys(body.user)).not.toContain("role");
    });
  });
});
