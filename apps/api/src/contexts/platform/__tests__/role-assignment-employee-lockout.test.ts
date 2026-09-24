/**
 * Phase 74b Plan 04 (Issue #74) — lockout protection on the three EMPLOYEE triggers of D-20:
 * `PATCH /employees/:id/deactivate`, `DELETE /employees/:id` (anonymize) and
 * `DELETE /employees/:id/hard-delete`, plus D-22 (deactivation keeps assignments, anonymization
 * removes them with an audit trail).
 *
 * A holder of a guarded permission is an active user of the tenant with a TENANT-scope assignment
 * whose role grants `role:manage:ZUGEWIESEN` or `role-assignment:manage:ZUGEWIESEN`. A change that
 * takes a holder count from >= 1 to 0 answers 409 `ROLE_LOCKOUT_MESSAGE` and leaves every row and
 * the audit log untouched.
 *
 * `beforeEach` removes every assignment of both tenants. Fixture people a test deactivates,
 * anonymizes or deletes are created inside that test, so no state has to be reset between tests.
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import type { RoleAssignment } from "@clokr/db";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { roleNameKey, normalizeRolePermissions } from "../access-role";
import { userMayApply } from "..";
import { ROLE_LOCKOUT_MESSAGE } from "../role-assignment";

const ROLE_MANAGE = "role:manage:ZUGEWIESEN";
const ASSIGNMENT_MANAGE = "role-assignment:manage:ZUGEWIESEN";

function uniqueSuffix(label: string): string {
  return (
    label.replace(/\s+/g, "-") +
    "-" +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 6)
  );
}

/** Role-descriptive fixture user + employee — no person names (CLAUDE.md PII rule). */
async function createUserWithEmployee(
  app: FastifyInstance,
  tenantId: string,
  label: string,
  employeeData: { firstName?: string; exitDate?: Date; avatarPath?: string } = {},
) {
  const s = uniqueSuffix(label);
  const passwordHash = await bcrypt.hash("test1234", 10);
  const user = await app.prisma.user.create({
    data: { email: `lke-${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
  });
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      // Label-free: truncating a label-prefixed suffix would cut off its unique part.
      employeeNumber: `LKE-${crypto.randomBytes(6).toString("hex")}`,
      firstName: employeeData.firstName ?? label,
      lastName: "Test",
      hireDate: new Date("2004-01-01"),
      exitDate: employeeData.exitDate,
      avatarPath: employeeData.avatarPath,
    },
  });
  return { user, employee };
}

async function createRole(
  app: FastifyInstance,
  tenantId: string | null,
  label: string,
  permissions: string[],
) {
  const name = uniqueSuffix(label);
  return app.prisma.accessRole.create({
    data: {
      tenantId,
      name,
      nameKey: roleNameKey(name),
      permissions: normalizeRolePermissions(permissions),
    },
  });
}

describe("Role lockout protection — employee triggers (Phase 74b, Issue #74)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  let roleManage: Awaited<ReturnType<typeof createRole>>;
  let roleManageB: Awaited<ReturnType<typeof createRole>>;

  async function assignTenant(
    tenantId: string,
    userId: string,
    accessRoleId: string,
  ): Promise<RoleAssignment> {
    return app.prisma.roleAssignment.create({
      data: { tenantId, userId, accessRoleId, scopeType: "TENANT", salonIds: [], employeeIds: [] },
    });
  }

  function auditCount(entity: string, entityId: string, action: string) {
    return app.prisma.auditLog.count({ where: { entity, entityId, action } });
  }

  function deactivate(employeeId: string, token = tenantA.adminToken) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${employeeId}/deactivate`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "74b-elock-a");
    tenantB = await seedTestData(app, "74b-elock-b");
    roleManage = await createRole(app, tenantA.tenant.id, "RM", [ROLE_MANAGE, ASSIGNMENT_MANAGE]);
    roleManageB = await createRole(app, tenantB.tenant.id, "RM-B", [
      ROLE_MANAGE,
      ASSIGNMENT_MANAGE,
    ]);
  });

  beforeEach(async () => {
    await app.prisma.roleAssignment.deleteMany({
      where: { tenantId: { in: [tenantA.tenant.id, tenantB.tenant.id] } },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantA failed:", err);
    }
    try {
      await cleanupTestData(app, tenantB.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantB failed:", err);
    }
    await closeTestApp();
  });

  // ── Trigger: PATCH /api/v1/employees/:id/deactivate ────────────────────────────────────────────

  it("(a) tracer: deactivating the only active tenant-wide holder answers 409 and changes nothing — user, employee, tokens, assignment, audit", async () => {
    const holder = await createUserWithEmployee(app, tenantA.tenant.id, "Halter");
    const assignment = await assignTenant(tenantA.tenant.id, holder.user.id, roleManage.id);
    const refreshToken = await app.prisma.refreshToken.create({
      data: {
        token: crypto.randomBytes(24).toString("hex"),
        userId: holder.user.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const auditsBefore = await auditCount("Employee", holder.employee.id, "UPDATE");

    const res = await deactivate(holder.employee.id);

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: ROLE_LOCKOUT_MESSAGE });
    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: holder.user.id } });
    expect(user.isActive).toBe(true);
    const employee = await app.prisma.employee.findUniqueOrThrow({
      where: { id: holder.employee.id },
    });
    expect(employee.exitDate).toEqual(holder.employee.exitDate);
    const token = await app.prisma.refreshToken.findUniqueOrThrow({
      where: { id: refreshToken.id },
    });
    expect(token.revokedAt).toBeNull();
    expect(await app.prisma.roleAssignment.findUnique({ where: { id: assignment.id } })).toEqual(
      assignment,
    );
    expect(await auditCount("Employee", holder.employee.id, "UPDATE")).toBe(auditsBefore);
  });

  it("(b) with a second tenant-wide holder the deactivation succeeds; the assignment is kept (D-22) and one UPDATE audit is written", async () => {
    const holder = await createUserWithEmployee(app, tenantA.tenant.id, "Halter");
    const other = await createUserWithEmployee(app, tenantA.tenant.id, "Zweiter Halter");
    const assignment = await assignTenant(tenantA.tenant.id, holder.user.id, roleManage.id);
    await assignTenant(tenantA.tenant.id, other.user.id, roleManage.id);
    const auditsBefore = await auditCount("Employee", holder.employee.id, "UPDATE");

    const res = await deactivate(holder.employee.id);

    expect(res.statusCode).toBe(200);
    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: holder.user.id } });
    expect(user.isActive).toBe(false);
    expect(await app.prisma.roleAssignment.findUnique({ where: { id: assignment.id } })).toEqual(
      assignment,
    );
    expect(await auditCount("Employee", holder.employee.id, "UPDATE")).toBe(auditsBefore + 1);
  });

  it("(c) D-22: a deactivated user's kept assignment has no effect; reactivation restores it", async () => {
    const holder = await createUserWithEmployee(app, tenantA.tenant.id, "Halter");
    const other = await createUserWithEmployee(app, tenantA.tenant.id, "Zweiter Halter");
    await assignTenant(tenantA.tenant.id, holder.user.id, roleManage.id);
    await assignTenant(tenantA.tenant.id, other.user.id, roleManage.id);
    expect(await userMayApply(app.prisma, tenantA.tenant.id, holder.user.id, ROLE_MANAGE, {})).toBe(
      true,
    );

    expect((await deactivate(holder.employee.id)).statusCode).toBe(200);
    expect(await userMayApply(app.prisma, tenantA.tenant.id, holder.user.id, ROLE_MANAGE, {})).toBe(
      false,
    );

    const reactivated = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${holder.employee.id}/reactivate`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: {},
    });
    expect(reactivated.statusCode).toBe(200);
    expect(await userMayApply(app.prisma, tenantA.tenant.id, holder.user.id, ROLE_MANAGE, {})).toBe(
      true,
    );
  });

  it("(e) the deactivation and its audit are one transaction: a failing audit rolls the deactivation back", async () => {
    // Tells "audit inside the guarded transaction" apart from "audit after the commit": both
    // write no audit on a 409, but only the former undoes the deactivation when the audit fails.
    const holder = await createUserWithEmployee(app, tenantA.tenant.id, "Halter");
    const other = await createUserWithEmployee(app, tenantA.tenant.id, "Zweiter Halter");
    await assignTenant(tenantA.tenant.id, holder.user.id, roleManage.id);
    await assignTenant(tenantA.tenant.id, other.user.id, roleManage.id);
    const realAudit = app.audit.bind(app);
    vi.spyOn(app, "audit").mockImplementation(async (entry) => {
      if (entry.entity === "Employee" && entry.entityId === holder.employee.id) {
        throw new Error("audit write failed (test)");
      }
      return realAudit(entry);
    });

    const res = await deactivate(holder.employee.id);

    expect(res.statusCode).toBe(500);
    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: holder.user.id } });
    expect(user.isActive, "deactivation committed although its audit failed").toBe(true);
  });

  it("(d) D-18: a tenant without any holder is never blocked", async () => {
    // Tenant B has a role that grants both guarded permissions, but nobody holds it.
    expect(roleManageB.tenantId).toBe(tenantB.tenant.id);
    const person = await createUserWithEmployee(app, tenantB.tenant.id, "Ohne Zuweisung");
    const res = await deactivate(person.employee.id, tenantB.adminToken);
    expect(res.statusCode).toBe(200);
  });
});
