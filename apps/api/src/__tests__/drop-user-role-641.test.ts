/**
 * Issue #641 (Release B of #539) - the phase tracer. The role of a person lives ONLY in stored
 * `RoleAssignment` rows: no request path writes or reads a role column of `User`, and no audit row
 * written by a role change carries a derived compat value. The employee responses keep serving the
 * role DERIVED from the stored assignments under `user.role`.
 *
 * The file reads behaviour only (HTTP, RoleAssignment, AuditLog) - it never selects or filters a
 * role column, so it stays valid after the column is dropped. The migration cases read the
 * migration file and the live catalog of the worker database: they prove the column and the enum
 * are gone, and the admin sign-in case runs on that dropped schema.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  seedOperator,
  cleanupTestData,
  soleAuditRow,
} from "./setup";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";
import {
  operatorEmployeeCreationAudit,
  provisionTenantWithAdmin,
} from "../contexts/platform/tenant-provisioning";

// POST /employees validates the tenant password policy; the seeded admin bypasses it.
const POLICY_PASSWORD = "Test@1234567!";

describe("Issue #641 - the role lives only in stored assignments", () => {
  let app: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof seedTestData>>;
  const provisionedTenantIds: string[] = [];

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
      for (const id of provisionedTenantIds) await cleanupTestData(app, id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("the drop migration and the live catalog", () => {
    // The directory is found by its suffix; only the lower bound of its timestamp is pinned.
    const MIGRATIONS_DIR = path.resolve(__dirname, "../../../../packages/db/prisma/migrations");
    const DROP_SUFFIX = "_drop_user_role";
    const FIRST_ALLOWED_TIMESTAMP = "20261103000000";

    function dropMigrationDir(): string {
      const entries = fs.readdirSync(MIGRATIONS_DIR);
      const matches = entries.filter((name) => name.endsWith(DROP_SUFFIX));
      if (matches.length !== 1) {
        throw new Error(
          `expected exactly one migration directory ending in ${DROP_SUFFIX}, found ${matches.length} ` +
            `(${matches.join(", ") || "none"}) among ${entries.length} entries of ${MIGRATIONS_DIR}`,
        );
      }
      return matches[0];
    }

    it("walks a non-empty migration history", () => {
      const entries = fs.readdirSync(MIGRATIONS_DIR);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.filter((entry) => /^\d{14}_/.test(entry)).length).toBeGreaterThan(0);
    });

    it("is a single migration dated after the migrations pending on other branches", () => {
      const name = dropMigrationDir();
      const timestamp = name.slice(0, name.length - DROP_SUFFIX.length);
      expect(timestamp).toMatch(/^\d{14}$/);
      expect(timestamp >= FIRST_ALLOWED_TIMESTAMP).toBe(true);
    });

    it("consists of exactly the column drop followed by the enum drop", () => {
      const sql = fs.readFileSync(
        path.join(MIGRATIONS_DIR, dropMigrationDir(), "migration.sql"),
        "utf8",
      );
      const statements = sql
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("--"));
      expect(statements).toEqual(['ALTER TABLE "User" DROP COLUMN "role";', 'DROP TYPE "Role";']);
    });

    it("leaves neither a role column on User nor a Role type in the worker database", async () => {
      const columns = await app.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'role'`;
      expect(Number(columns[0].n)).toBe(0);
      const types = await app.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_type t JOIN pg_namespace ns ON ns.oid = t.typnamespace
        WHERE ns.nspname = 'public' AND t.typname = 'Role'`;
      expect(Number(types[0].n)).toBe(0);
    });
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

  describe("creation, import, anonymization and provisioning", () => {
    it("POST /employees stores the requested role only as an assignment", async () => {
      const person = await createPerson("MANAGER");
      expect(person.createdRole).toBe("MANAGER");
      const rows = await storedRows(person.userId);
      expect(rows.map((row) => [row.accessRoleId, row.scopeType])).toEqual([
        [SYSTEM_ROLE_IDS.MANAGER, "TENANT"],
      ]);
      const createRow = await soleAuditRow(app.prisma, {
        where: { entity: "RoleAssignment", entityId: rows[0].id, action: "CREATE" },
      });
      expect(Object.keys((createRow.newValue ?? {}) as Record<string, unknown>)).not.toContain(
        "compatRole",
      );
    });

    it("a CSV import row with Rolle MANAGER stores one TENANT assignment and serves the derived role", async () => {
      const uid = crypto.randomBytes(4).toString("hex");
      const csv = `email;vorname;nachname;nr;eintrittsdatum;Rolle
imp641-${uid}@example.invalid;Test;Person;I6-${uid};01.01.2026;MANAGER`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/imports/employees",
        headers: auth(),
        payload: { csv },
      });
      expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
      expect((JSON.parse(res.body) as { imported: number }).imported).toBe(1);
      const employee = await app.prisma.employee.findFirstOrThrow({
        where: { tenantId: tenant.tenant.id, employeeNumber: `I6-${uid}` },
      });
      const rows = await storedRows(employee.userId);
      expect(rows.map((row) => [row.accessRoleId, row.scopeType])).toEqual([
        [SYSTEM_ROLE_IDS.MANAGER, "TENANT"],
      ]);
      expect(await servedRole(employee.id)).toBe("MANAGER");
    });

    it("anonymizing a person who holds an assignment leaves no RoleAssignment row", async () => {
      const person = await createPerson("MANAGER");
      expect(await storedRows(person.userId)).toHaveLength(1);
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${person.employeeId}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(204);
      expect(await storedRows(person.userId)).toHaveLength(0);
    });

    it("tenant provisioning creates the first admin with exactly one TENANT assignment on Admin", async () => {
      const operatorId = (await seedOperator(app)).id;
      const slug = `p641-${crypto.randomBytes(4).toString("hex")}`;
      const result = await app.prisma.$transaction((tx) =>
        provisionTenantWithAdmin(
          tx,
          {
            tenant: { name: `Tenant ${slug}`, slug, federalState: "HESSEN" },
            admin: { email: `${slug}@example.invalid`, firstName: "Erste", lastName: "Leitung" },
          },
          (tenantId) => operatorEmployeeCreationAudit(app, { operatorId, tenantId }),
        ),
      );
      expect(result.status).toBe("OK");
      if (result.status !== "OK") return;
      provisionedTenantIds.push(result.tenant.id);
      const rows = await app.prisma.roleAssignment.findMany({
        where: { tenantId: result.tenant.id, userId: result.user.id },
      });
      expect(rows.map((row) => [row.accessRoleId, row.scopeType])).toEqual([
        [SYSTEM_ROLE_IDS.ADMIN, "TENANT"],
      ]);
    });
  });

  describe("admin sign-in (ISSUE-641-AC6)", () => {
    it("the seeded admin signs in after the drop with a non-empty permission list and no role key", async () => {
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
