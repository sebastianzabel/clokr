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
const TIME_ENTRY_READ = "time-entry:read:ZUGEWIESEN";
const AVATAR_KEY = "avatars/74b-04-test/dummy.webp";

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
  let roleTimeRead: Awaited<ReturnType<typeof createRole>>;

  async function assignTenant(
    tenantId: string,
    userId: string,
    accessRoleId: string,
  ): Promise<RoleAssignment> {
    return app.prisma.roleAssignment.create({
      data: { tenantId, userId, accessRoleId, scopeType: "TENANT", salonIds: [], employeeIds: [] },
    });
  }

  async function assignPersons(
    tenantId: string,
    userId: string,
    accessRoleId: string,
    employeeIds: string[],
  ): Promise<RoleAssignment> {
    return app.prisma.roleAssignment.create({
      data: { tenantId, userId, accessRoleId, scopeType: "PERSONS", salonIds: [], employeeIds },
    });
  }

  function anonymize(employeeId: string) {
    return app.inject({
      method: "DELETE",
      url: `/api/v1/employees/${employeeId}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
  }

  function hardDelete(employeeId: string) {
    return app.inject({
      method: "DELETE",
      url: `/api/v1/employees/${employeeId}/hard-delete`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: {},
    });
  }

  /** Employee + user rows as stored, for a deep "nothing changed" comparison. */
  async function personState(fixture: { user: { id: string }; employee: { id: string } }) {
    return {
      employee: await app.prisma.employee.findUnique({ where: { id: fixture.employee.id } }),
      user: await app.prisma.user.findUnique({ where: { id: fixture.user.id } }),
    };
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
    roleTimeRead = await createRole(app, tenantA.tenant.id, "TR", [TIME_ENTRY_READ]);
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

  // ── Trigger: DELETE /api/v1/employees/:id (anonymize) ──────────────────────────────────────────

  it("(f) anonymizing the only active tenant-wide holder answers 409 before any MinIO delete; employee, user, assignment and audit log are unchanged", async () => {
    const holder = await createUserWithEmployee(app, tenantA.tenant.id, "Halter", {
      avatarPath: AVATAR_KEY,
    });
    const assignment = await assignTenant(tenantA.tenant.id, holder.user.id, roleManage.id);
    const stateBefore = await personState(holder);
    const deleteSpy = vi.spyOn(app.storage, "delete").mockResolvedValue(undefined);

    const res = await anonymize(holder.employee.id);

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: ROLE_LOCKOUT_MESSAGE });
    expect(await personState(holder)).toEqual(stateBefore);
    expect(await app.prisma.roleAssignment.findUnique({ where: { id: assignment.id } })).toEqual(
      assignment,
    );
    expect(await auditCount("Employee", holder.employee.id, "ANONYMIZE")).toBe(0);
    expect(await auditCount("RoleAssignment", assignment.id, "DELETE")).toBe(0);
    expect(deleteSpy, "a rolled-back anonymization deleted a MinIO object").not.toHaveBeenCalled();
  });

  it("(g) with a second holder the anonymization succeeds; every assignment of the user is removed with one DELETE audit each (D-22)", async () => {
    const holder = await createUserWithEmployee(app, tenantA.tenant.id, "Halter", {
      avatarPath: AVATAR_KEY,
    });
    const other = await createUserWithEmployee(app, tenantA.tenant.id, "Zweiter Halter");
    const trainee = await createUserWithEmployee(app, tenantA.tenant.id, "Azubi");
    const tenantWide = await assignTenant(tenantA.tenant.id, holder.user.id, roleManage.id);
    const personScoped = await assignPersons(tenantA.tenant.id, holder.user.id, roleTimeRead.id, [
      trainee.employee.id,
    ]);
    await assignTenant(tenantA.tenant.id, other.user.id, roleManage.id);
    const deleteSpy = vi.spyOn(app.storage, "delete").mockResolvedValue(undefined);

    const res = await anonymize(holder.employee.id);

    expect(res.statusCode).toBe(204);
    expect(await app.prisma.roleAssignment.count({ where: { userId: holder.user.id } })).toBe(0);
    for (const [removed, roleName] of [
      [tenantWide, roleManage.name],
      [personScoped, roleTimeRead.name],
    ] as const) {
      const audits = await app.prisma.auditLog.findMany({
        where: { entity: "RoleAssignment", entityId: removed.id, action: "DELETE" },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].oldValue).toEqual({
        userId: removed.userId,
        accessRoleId: removed.accessRoleId,
        roleName,
        scopeType: removed.scopeType,
        salonIds: removed.salonIds,
        employeeIds: removed.employeeIds,
      });
      expect(audits[0].newValue).toEqual({ reason: "Anonymisierung" });
    }
    expect(await auditCount("Employee", holder.employee.id, "ANONYMIZE")).toBe(1);
    // Positive control for (f): the spy does see the avatar delete on the success path.
    expect(deleteSpy).toHaveBeenCalledWith(AVATAR_KEY);
  });

  it("(h) D-22: a trainer's person-scope list that contains the anonymized employee stays unchanged and resolves to deny for that target", async () => {
    const trainer = await createUserWithEmployee(app, tenantA.tenant.id, "Ausbilder");
    const trainee = await createUserWithEmployee(app, tenantA.tenant.id, "Azubi");
    const trainerAssignment = await assignPersons(
      tenantA.tenant.id,
      trainer.user.id,
      roleTimeRead.id,
      [trainee.employee.id],
    );
    const target = { employeeId: trainee.employee.id };
    expect(
      await userMayApply(app.prisma, tenantA.tenant.id, trainer.user.id, TIME_ENTRY_READ, target),
    ).toBe(true);

    expect((await anonymize(trainee.employee.id)).statusCode).toBe(204);

    expect(
      await app.prisma.roleAssignment.findUnique({ where: { id: trainerAssignment.id } }),
    ).toEqual(trainerAssignment);
    expect(
      await userMayApply(app.prisma, tenantA.tenant.id, trainer.user.id, TIME_ENTRY_READ, target),
    ).toBe(false);
  });

  it("(i) after anonymizing the only user of a customer role, the role can be deleted (no leftover assignment blocks it)", async () => {
    const roleX = await createRole(app, tenantA.tenant.id, "RX", [TIME_ENTRY_READ]);
    const person = await createUserWithEmployee(app, tenantA.tenant.id, "Einzige Zuweisung");
    await assignTenant(tenantA.tenant.id, person.user.id, roleX.id);

    expect((await anonymize(person.employee.id)).statusCode).toBe(204);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/roles/${roleX.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  // ── Trigger: DELETE /api/v1/employees/:id/hard-delete ──────────────────────────────────────────

  it("(j) hard-deleting the only holder is refused earlier by the anonymization precondition; nothing changes", async () => {
    const holder = await createUserWithEmployee(app, tenantA.tenant.id, "Halter");
    const assignment = await assignTenant(tenantA.tenant.id, holder.user.id, roleManage.id);
    const stateBefore = await personState(holder);

    const res = await hardDelete(holder.employee.id);

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: "Mitarbeiter muss zuerst anonymisiert werden" });
    expect(await personState(holder)).toEqual(stateBefore);
    expect(await app.prisma.roleAssignment.findUnique({ where: { id: assignment.id } })).toEqual(
      assignment,
    );
  });

  /**
   * ADVERSARIAL fixture, built directly via Prisma and reachable through no route: an employee
   * that already carries the anonymized first name and an exit date past every retention window,
   * but whose user is still active and still holds a tenant-wide assignment. Real anonymization
   * deactivates the user and removes the assignments, so on the real path the precondition in (j)
   * refuses first. This state exists only to prove the guard itself is wired into the hard-delete
   * transaction (D-20: the AC holds by construction).
   */
  async function inconsistentAnonymizedHolder() {
    const person = await createUserWithEmployee(app, tenantA.tenant.id, "Inkonsistent", {
      firstName: "Gelöscht",
      exitDate: new Date("2010-01-01"),
    });
    const assignment = await assignTenant(tenantA.tenant.id, person.user.id, roleManage.id);
    return { person, assignment };
  }

  it("(k) guard wiring proof: hard-deleting an (inconsistent) only holder answers 409 lockout; employee, user and assignment stay, no HARD_DELETE audit", async () => {
    const { person, assignment } = await inconsistentAnonymizedHolder();
    const stateBefore = await personState(person);

    const res = await hardDelete(person.employee.id);

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: ROLE_LOCKOUT_MESSAGE });
    expect(await personState(person)).toEqual(stateBefore);
    expect(await app.prisma.roleAssignment.findUnique({ where: { id: assignment.id } })).toEqual(
      assignment,
    );
    expect(await auditCount("Employee", person.employee.id, "HARD_DELETE")).toBe(0);
  });

  it("(l) the same fixture with a second holder is hard-deleted; its assignment is removed with a DELETE audit, not a silent cascade (74b review WR-04)", async () => {
    const { person, assignment } = await inconsistentAnonymizedHolder();
    const other = await createUserWithEmployee(app, tenantA.tenant.id, "Zweiter Halter");
    await assignTenant(tenantA.tenant.id, other.user.id, roleManage.id);

    const res = await hardDelete(person.employee.id);

    expect(res.statusCode).toBe(204);
    expect(await personState(person)).toEqual({ employee: null, user: null });
    expect(await app.prisma.roleAssignment.findUnique({ where: { id: assignment.id } })).toBeNull();
    expect(await auditCount("RoleAssignment", assignment.id, "DELETE")).toBe(1);
    expect(await auditCount("Employee", person.employee.id, "HARD_DELETE")).toBe(1);
  });
});
