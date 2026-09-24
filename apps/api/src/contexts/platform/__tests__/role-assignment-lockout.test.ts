/**
 * Phase 74b Plan 03 (Issue #74) — lockout protection (D-17..D-20) and "an assigned role cannot be
 * deleted" (D-21).
 *
 * A holder of a guarded permission (`role:manage:ZUGEWIESEN`, `role-assignment:manage:ZUGEWIESEN`)
 * is an active user of the tenant with a TENANT-scope assignment whose role grants it. A change
 * that takes a holder count from >= 1 to 0 answers 409 `ROLE_LOCKOUT_MESSAGE` and leaves the row,
 * the role and the audit log untouched.
 *
 * `beforeEach` removes every assignment of both tenants and re-activates every fixture user, so
 * each test states exactly the holders it needs. No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import type { RoleAssignment } from "@clokr/db";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { roleNameKey, normalizeRolePermissions } from "../access-role";
import { DEFAULT_SALON_OPENING_HOURS } from "../facade/salons";
import { withRoleLockoutGuard } from "../facade/role-assignments";
import { PERMISSIONS, permissionKey } from "../permission-catalog";
import {
  GUARDED_PERMISSIONS,
  ROLE_LOCKOUT_MESSAGE,
  RoleLockoutError,
  countHoldersPerGuardedPermission,
  findLockedOutPermission,
  type GuardedPermission,
} from "../role-assignment";

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
async function createUserWithEmployee(app: FastifyInstance, tenantId: string, label: string) {
  const s = uniqueSuffix(label);
  const passwordHash = await bcrypt.hash("test1234", 10);
  const user = await app.prisma.user.create({
    data: { email: `lk-${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
  });
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `LK-${s}`.slice(0, 20),
      firstName: label,
      lastName: "Test",
      hireDate: new Date("2024-01-01"),
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

type Scope =
  | { type: "TENANT" }
  | { type: "SALONS"; salonIds: string[] }
  | { type: "PERSONS"; employeeIds: string[] };

function holders(counts: Partial<Record<GuardedPermission, number>>) {
  return {
    [ROLE_MANAGE]: counts[ROLE_MANAGE] ?? 0,
    [ASSIGNMENT_MANAGE]: counts[ASSIGNMENT_MANAGE] ?? 0,
  } as Record<GuardedPermission, number>;
}

describe("Role lockout protection (Phase 74b, Issue #74)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  let holder1: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let holder2: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let salonHolder: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let withoutRight: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let tenantBHolder: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let salonA: { id: string };
  let roleManage: Awaited<ReturnType<typeof createRole>>;
  let roleRead: Awaited<ReturnType<typeof createRole>>;
  let roleManageB: Awaited<ReturnType<typeof createRole>>;
  let systemRoleManage: Awaited<ReturnType<typeof createRole>>;

  async function assign(
    tenantId: string,
    userId: string,
    accessRoleId: string,
    scope: Scope = { type: "TENANT" },
  ): Promise<RoleAssignment> {
    return app.prisma.roleAssignment.create({
      data: {
        tenantId,
        userId,
        accessRoleId,
        scopeType: scope.type,
        salonIds: scope.type === "SALONS" ? scope.salonIds : [],
        employeeIds: scope.type === "PERSONS" ? scope.employeeIds : [],
      },
    });
  }

  function auditCount(entity: string, entityId: string, action: string) {
    return app.prisma.auditLog.count({ where: { entity, entityId, action } });
  }

  function revoke(assignmentId: string) {
    return app.inject({
      method: "DELETE",
      url: `/api/v1/role-assignments/${assignmentId}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
  }

  /** Asserts the 409 lockout answer and that the row and its audit trail are untouched. */
  async function expectRevokeRefused(assignment: RoleAssignment) {
    const auditsBefore = await auditCount("RoleAssignment", assignment.id, "DELETE");
    const res = await revoke(assignment.id);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: ROLE_LOCKOUT_MESSAGE });
    const stored = await app.prisma.roleAssignment.findUnique({ where: { id: assignment.id } });
    expect(stored).toEqual(assignment);
    expect(await auditCount("RoleAssignment", assignment.id, "DELETE")).toBe(auditsBefore);
  }

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "74b-lock-a");
    tenantB = await seedTestData(app, "74b-lock-b");

    holder1 = await createUserWithEmployee(app, tenantA.tenant.id, "Halter 1");
    holder2 = await createUserWithEmployee(app, tenantA.tenant.id, "Halter 2");
    salonHolder = await createUserWithEmployee(app, tenantA.tenant.id, "Salon-Halter");
    withoutRight = await createUserWithEmployee(app, tenantA.tenant.id, "Ohne Recht");
    tenantBHolder = await createUserWithEmployee(app, tenantB.tenant.id, "Halter B");

    salonA = await app.prisma.salon.create({
      data: {
        tenantId: tenantA.tenant.id,
        name: "Salon SA",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });

    roleManage = await createRole(app, tenantA.tenant.id, "RM", [ROLE_MANAGE, ASSIGNMENT_MANAGE]);
    roleRead = await createRole(app, tenantA.tenant.id, "RR", ["role:read:ZUGEWIESEN"]);
    roleManageB = await createRole(app, tenantB.tenant.id, "RM-B", [
      ROLE_MANAGE,
      ASSIGNMENT_MANAGE,
    ]);
    systemRoleManage = await createRole(app, null, "System-RM", [ROLE_MANAGE, ASSIGNMENT_MANAGE]);
  });

  beforeEach(async () => {
    await app.prisma.roleAssignment.deleteMany({
      where: { tenantId: { in: [tenantA.tenant.id, tenantB.tenant.id] } },
    });
    await app.prisma.user.updateMany({
      where: {
        id: {
          in: [holder1, holder2, salonHolder, withoutRight, tenantBHolder].map((f) => f.user.id),
        },
      },
      data: { isActive: true },
    });
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
    // After cleanupTestData: the users' assignments are gone (cascade), so the Restrict FK no
    // longer blocks deleting the system role.
    try {
      await app.prisma.accessRole.delete({ where: { id: systemRoleManage.id } });
    } catch (err) {
      console.error("Cleanup system role failed:", err);
    }
    await closeTestApp();
  });

  // ── Pure primitives (DB-free) ──────────────────────────────────────────────────────────────────

  it("(u1) countHoldersPerGuardedPermission counts distinct users, ignores a foreign tenant's role, and counts a role only for the guarded permissions it grants", () => {
    const own = { tenantId: "t-a", permissions: [ROLE_MANAGE, ASSIGNMENT_MANAGE] };
    const onlyRoleManage = { tenantId: "t-a", permissions: [ROLE_MANAGE] };
    const system = { tenantId: null, permissions: [ASSIGNMENT_MANAGE] };
    const foreign = { tenantId: "t-b", permissions: [ROLE_MANAGE, ASSIGNMENT_MANAGE] };

    expect(countHoldersPerGuardedPermission("t-a", [])).toEqual(holders({}));
    expect(
      countHoldersPerGuardedPermission("t-a", [
        { userId: "u1", accessRole: own },
        { userId: "u1", accessRole: onlyRoleManage },
        { userId: "u2", accessRole: onlyRoleManage },
        { userId: "u3", accessRole: foreign },
        { userId: "u4", accessRole: system },
      ]),
    ).toEqual(holders({ [ROLE_MANAGE]: 2, [ASSIGNMENT_MANAGE]: 2 }));
    expect(
      countHoldersPerGuardedPermission("t-a", [{ userId: "u3", accessRole: foreign }]),
    ).toEqual(holders({}));
    expect(
      countHoldersPerGuardedPermission("t-a", [{ userId: "u2", accessRole: onlyRoleManage }]),
    ).toEqual(holders({ [ROLE_MANAGE]: 1 }));
  });

  it("(u1) findLockedOutPermission: 0 -> 0 and 2 -> 1 are not a lockout, 1 -> 0 is", () => {
    expect(findLockedOutPermission(holders({}), holders({}))).toBeNull();
    expect(
      findLockedOutPermission(
        holders({ [ROLE_MANAGE]: 2, [ASSIGNMENT_MANAGE]: 2 }),
        holders({ [ROLE_MANAGE]: 1, [ASSIGNMENT_MANAGE]: 1 }),
      ),
    ).toBeNull();
    expect(
      findLockedOutPermission(
        holders({ [ROLE_MANAGE]: 1, [ASSIGNMENT_MANAGE]: 2 }),
        holders({ [ROLE_MANAGE]: 0, [ASSIGNMENT_MANAGE]: 2 }),
      ),
    ).toBe(ROLE_MANAGE);
    expect(
      findLockedOutPermission(
        holders({ [ROLE_MANAGE]: 3, [ASSIGNMENT_MANAGE]: 1 }),
        holders({ [ROLE_MANAGE]: 3, [ASSIGNMENT_MANAGE]: 0 }),
      ),
    ).toBe(ASSIGNMENT_MANAGE);
  });

  it("(u2) every guarded permission is a catalog key", () => {
    const catalogKeys = new Set<string>(PERMISSIONS.map(permissionKey));
    expect(GUARDED_PERMISSIONS.length).toBe(2);
    for (const permission of GUARDED_PERMISSIONS) {
      expect(catalogKeys.has(permission), permission).toBe(true);
    }
  });

  // ── Trigger: DELETE /api/v1/role-assignments/:id ───────────────────────────────────────────────

  it("(a) tracer: revoking the only active tenant-wide holder's assignment answers 409, the row stays and no DELETE audit is written", async () => {
    const onlyHolder = await assign(tenantA.tenant.id, holder1.user.id, roleManage.id);
    await expectRevokeRefused(onlyHolder);
  });

  it("(b) with a second tenant-wide holder the revocation succeeds with 204 and one DELETE audit", async () => {
    const first = await assign(tenantA.tenant.id, holder1.user.id, roleManage.id);
    await assign(tenantA.tenant.id, holder2.user.id, roleManage.id);
    const auditsBefore = await auditCount("RoleAssignment", first.id, "DELETE");

    const res = await revoke(first.id);
    expect(res.statusCode).toBe(204);
    expect(await app.prisma.roleAssignment.findUnique({ where: { id: first.id } })).toBeNull();
    expect(await auditCount("RoleAssignment", first.id, "DELETE")).toBe(auditsBefore + 1);
  });

  it("(c) D-18: a tenant with no holder at all is never blocked", async () => {
    const readOnly = await assign(tenantA.tenant.id, holder1.user.id, roleRead.id);
    const res = await revoke(readOnly.id);
    expect(res.statusCode).toBe(204);
  });

  it("(d) an inactive user is not a holder", async () => {
    const onlyHolder = await assign(tenantA.tenant.id, holder1.user.id, roleManage.id);
    await assign(tenantA.tenant.id, holder2.user.id, roleManage.id);
    await app.prisma.user.update({ where: { id: holder2.user.id }, data: { isActive: false } });
    await expectRevokeRefused(onlyHolder);
  });

  it("(e) a salon-scoped assignment of the role does not make a holder", async () => {
    const onlyHolder = await assign(tenantA.tenant.id, holder1.user.id, roleManage.id);
    await assign(tenantA.tenant.id, salonHolder.user.id, roleManage.id, {
      type: "SALONS",
      salonIds: [salonA.id],
    });
    await expectRevokeRefused(onlyHolder);
  });

  it("(f) a tenant-wide holder in another tenant does not count for this tenant", async () => {
    const onlyHolder = await assign(tenantA.tenant.id, holder1.user.id, roleManage.id);
    await assign(tenantB.tenant.id, tenantBHolder.user.id, roleManageB.id);
    await expectRevokeRefused(onlyHolder);
  });

  it("(f2) a tenant-wide holder of a SYSTEM role in another tenant does not count for this tenant", async () => {
    // A system role belongs to every tenant, so the role filter cannot exclude this row — only the
    // tenant filters of the holder query can.
    const onlyHolder = await assign(tenantA.tenant.id, holder1.user.id, roleManage.id);
    await assign(tenantB.tenant.id, tenantBHolder.user.id, systemRoleManage.id);
    await expectRevokeRefused(onlyHolder);
  });

  it("(g) concurrency: two revocations of the last two holders serialise on the tenant row lock — exactly one succeeds, the other gets RoleLockoutError", async () => {
    const first = await assign(tenantA.tenant.id, holder1.user.id, roleManage.id);
    const second = await assign(tenantA.tenant.id, holder2.user.id, roleManage.id);

    // Synchronised on observed database state, never on a fixed sleep (salons.test.ts precedent).
    // tx1 revokes the first assignment under the guard, then HOLDS its transaction open — and with
    // it the tenant row lock — until the test releases it.
    let releaseTx1: (() => void) | undefined;
    const tx1HoldGate = new Promise<void>((resolve) => {
      releaseTx1 = resolve;
    });
    let signalTx1Locked: ((pid: number) => void) | undefined;
    const tx1Locked = new Promise<number>((resolve) => {
      signalTx1Locked = resolve;
    });
    const tx1Promise = app.prisma.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        await withRoleLockoutGuard(tx, tenantA.tenant.id, () =>
          tx.roleAssignment.delete({ where: { id: first.id } }),
        );
        signalTx1Locked?.(pid);
        await tx1HoldGate;
      },
      { timeout: 20000 },
    );
    const tx1Pid = await tx1Locked;

    // tx2 reports its backend pid BEFORE it reaches the lock, so the test can watch it wait.
    let signalTx2Pid: ((pid: number) => void) | undefined;
    const tx2PidKnown = new Promise<number>((resolve) => {
      signalTx2Pid = resolve;
    });
    let tx2Settled = false;
    const tx2Outcome = app.prisma
      .$transaction(
        async (tx) => {
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          signalTx2Pid?.(pid);
          await withRoleLockoutGuard(tx, tenantA.tenant.id, () =>
            tx.roleAssignment.delete({ where: { id: second.id } }),
          );
        },
        { timeout: 20000 },
      )
      .then(
        () => ({ ok: true as const, error: undefined }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      .finally(() => {
        tx2Settled = true;
      });
    const tx2Pid = await tx2PidKnown;

    // Poll until PostgreSQL reports tx2 as blocked by tx1 (bounded). Without the tenant row lock
    // tx2 is never blocked — it finishes on its own and the poll ends without seeing tx1's pid.
    const deadline = Date.now() + 10000;
    let tx2BlockedByTx1 = false;
    while (!tx2Settled && Date.now() < deadline) {
      const [{ blockers }] = await app.prisma.$queryRaw<{ blockers: number[] }[]>`
        SELECT pg_blocking_pids(${tx2Pid}::int) AS blockers`;
      if (blockers.includes(tx1Pid)) {
        tx2BlockedByTx1 = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    releaseTx1?.();
    await tx1Promise;
    const outcome2 = await tx2Outcome;

    expect(tx2BlockedByTx1, "tx2 was never observed waiting on tx1's tenant row lock").toBe(true);
    expect(outcome2.ok).toBe(false);
    expect(outcome2.error).toBeInstanceOf(RoleLockoutError);

    const remaining = await app.prisma.roleAssignment.findMany({
      where: { id: { in: [first.id, second.id] } },
    });
    expect(remaining.map((row) => row.id)).toEqual([second.id]);
  });
});
