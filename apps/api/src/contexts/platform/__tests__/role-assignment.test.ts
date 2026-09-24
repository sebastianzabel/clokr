/**
 * Phase 74b (Issue #74) — function-level resolution of effective rights.
 *
 * "May user U apply permission P to a target described by employee and/or salon?" — proven at
 * function level only (enforcement wiring is #91). Task 1 covers the TENANT-scope tracer slice
 * (t1-t7); Task 2 adds SALONS/PERSONS scope, EIGENE and MANDANT-relation coverage plus a DB-free
 * unit matrix, and switches the import below to the Unterbau's public surface (`..`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { roleNameKey, normalizeRolePermissions } from "../access-role";
import { userMayApply } from "../facade/role-assignments";
import type { PermissionKey } from "../permission-catalog";
import type { FastifyInstance } from "fastify";

/** Role-descriptive fixture user + employee — no person names (CLAUDE.md PII rule). */
async function createUserWithEmployee(app: FastifyInstance, tenantId: string, label: string) {
  const s = label + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const passwordHash = await bcrypt.hash("test1234", 10);
  const user = await app.prisma.user.create({
    data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
  });
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `RA-${s}`.slice(0, 20),
      firstName: label,
      lastName: "Test",
      hireDate: new Date("2024-01-01"),
    },
  });
  return { user, employee };
}

describe("Role assignment resolution (Phase 74b, Issue #74)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  let r1Id: string;
  let holder: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let tenantAOther: Awaited<ReturnType<typeof createUserWithEmployee>>;

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "74b-res-a");
    tenantB = await seedTestData(app, "74b-res-b");

    const r1Name = `R1 ${Date.now().toString(36)}`;
    const r1 = await app.prisma.accessRole.create({
      data: {
        tenantId: tenantA.tenant.id,
        name: r1Name,
        nameKey: roleNameKey(r1Name),
        permissions: normalizeRolePermissions(["time-entry:read:ZUGEWIESEN"]),
      },
    });
    r1Id = r1.id;

    holder = await createUserWithEmployee(app, tenantA.tenant.id, "Salonleitung");
    tenantAOther = await createUserWithEmployee(app, tenantA.tenant.id, "Kollege");

    await app.prisma.roleAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        userId: holder.user.id,
        accessRoleId: r1Id,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
  });

  afterAll(async () => {
    // Pitfall 5 (74b-RESEARCH.md): cleanupTestData's User.deleteMany (onDelete: Cascade to
    // RoleAssignment.userId) already removes every RoleAssignment row for the tenant before
    // Tenant.delete() runs — no explicit roleAssignment.deleteMany should be needed. If this
    // ever fails with a foreign-key error naming RoleAssignment_tenantId_fkey, that assumption
    // was wrong; see the plan's Task 1 fallback instruction.
    try {
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (tenant A):", err);
    }
    try {
      await cleanupTestData(app, tenantB.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (tenant B):", err);
    }
    await closeTestApp();
  });

  it("(t1) a TENANT-scope holder of R1 -> true for tenant A's employee, and true for an empty target", async () => {
    expect(
      await userMayApply(
        app.prisma,
        tenantA.tenant.id,
        holder.user.id,
        "time-entry:read:ZUGEWIESEN",
        { employeeId: holder.employee.id },
      ),
    ).toBe(true);
    expect(
      await userMayApply(
        app.prisma,
        tenantA.tenant.id,
        holder.user.id,
        "time-entry:read:ZUGEWIESEN",
        {},
      ),
    ).toBe(true);
  });

  it("(t2) a tenant-A user without an assignment -> false", async () => {
    expect(
      await userMayApply(
        app.prisma,
        tenantA.tenant.id,
        tenantAOther.user.id,
        "time-entry:read:ZUGEWIESEN",
        { employeeId: holder.employee.id },
      ),
    ).toBe(false);
  });

  it("(t3) the holder with a target from tenant B -> false", async () => {
    expect(
      await userMayApply(
        app.prisma,
        tenantA.tenant.id,
        holder.user.id,
        "time-entry:read:ZUGEWIESEN",
        { employeeId: tenantB.employee.id },
      ),
    ).toBe(false);
  });

  it("(t4) the holder after isActive: false -> false; restored -> true again", async () => {
    await app.prisma.user.update({ where: { id: holder.user.id }, data: { isActive: false } });
    try {
      expect(
        await userMayApply(
          app.prisma,
          tenantA.tenant.id,
          holder.user.id,
          "time-entry:read:ZUGEWIESEN",
          { employeeId: holder.employee.id },
        ),
      ).toBe(false);
    } finally {
      await app.prisma.user.update({ where: { id: holder.user.id }, data: { isActive: true } });
    }
    expect(
      await userMayApply(
        app.prisma,
        tenantA.tenant.id,
        holder.user.id,
        "time-entry:read:ZUGEWIESEN",
        { employeeId: holder.employee.id },
      ),
    ).toBe(true);
  });

  it("(t5) leave-request:read:ZUGEWIESEN (not in R1) -> false", async () => {
    expect(
      await userMayApply(
        app.prisma,
        tenantA.tenant.id,
        holder.user.id,
        "leave-request:read:ZUGEWIESEN",
        { employeeId: holder.employee.id },
      ),
    ).toBe(false);
  });

  it("(t6) an unknown permission key -> false", async () => {
    expect(
      await userMayApply(
        app.prisma,
        tenantA.tenant.id,
        holder.user.id,
        "not-a-real-permission:read:ZUGEWIESEN" as PermissionKey,
        { employeeId: holder.employee.id },
      ),
    ).toBe(false);
  });

  it("(t7) the holder's assignment queried with tenantId = tenant B -> false", async () => {
    expect(
      await userMayApply(
        app.prisma,
        tenantB.tenant.id,
        holder.user.id,
        "time-entry:read:ZUGEWIESEN",
        { employeeId: holder.employee.id },
      ),
    ).toBe(false);
  });
});
