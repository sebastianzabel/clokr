/**
 * Phase 74b code review (74b-REVIEW.md) — regression tests for the review findings.
 *
 * Every race below is made deterministic instead of being left to timing: the test wraps
 * `app.prisma.$transaction` once and performs the "concurrent" write right before the route's own
 * transaction starts, i.e. after the route has parsed its request but before it takes the tenant
 * lock. That is exactly the window the findings describe.
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import type { RoleAssignment } from "@clokr/db";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { roleNameKey, normalizeRolePermissions } from "../access-role";
import { DEFAULT_SALON_OPENING_HOURS } from "../facade/salons";

const TIME_ENTRY_READ = "time-entry:read:ZUGEWIESEN";

function uniqueSuffix(label: string): string {
  return label + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Role-descriptive fixture user + employee — no person names (CLAUDE.md PII rule). */
async function createUserWithEmployee(app: FastifyInstance, tenantId: string, label: string) {
  const s = uniqueSuffix(label);
  const passwordHash = await bcrypt.hash("test1234", 10);
  const user = await app.prisma.user.create({
    data: { email: `rvf-${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
  });
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `RVF-${crypto.randomBytes(6).toString("hex")}`,
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

type TransactionFn = (...args: unknown[]) => Promise<unknown>;

describe("Phase 74b review fixes", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let roleX: Awaited<ReturnType<typeof createRole>>;
  let roleY: Awaited<ReturnType<typeof createRole>>;
  let salonA1: { id: string };

  /**
   * Runs `concurrentWrite` once, right before the NEXT `app.prisma.$transaction` call of the code
   * under test starts — the "another request committed in between" window.
   */
  function beforeNextTransaction(concurrentWrite: () => Promise<unknown>) {
    const realTransaction = app.prisma.$transaction.bind(app.prisma) as unknown as TransactionFn;
    vi.spyOn(app.prisma, "$transaction").mockImplementationOnce((async (...args: unknown[]) => {
      await concurrentWrite();
      return realTransaction(...args);
    }) as never);
  }

  function assignTenant(userId: string, accessRoleId: string): Promise<RoleAssignment> {
    return app.prisma.roleAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        userId,
        accessRoleId,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
  }

  function narrowToSalon(assignmentId: string) {
    return app.prisma.roleAssignment.update({
      where: { id: assignmentId },
      data: { scopeType: "SALONS", salonIds: [salonA1.id], employeeIds: [] },
    });
  }

  function patchAssignment(id: string, payload: object) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/role-assignments/${id}`,
      headers: {
        authorization: `Bearer ${tenantA.adminToken}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify(payload),
    });
  }

  function assignmentAudits(entityId: string, action: string) {
    return app.prisma.auditLog.findMany({
      where: { entity: "RoleAssignment", entityId, action },
      orderBy: { createdAt: "asc" },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "74b-review-a");
    roleX = await createRole(app, tenantA.tenant.id, "RX", [TIME_ENTRY_READ]);
    roleY = await createRole(app, tenantA.tenant.id, "RY", [TIME_ENTRY_READ]);
    salonA1 = await app.prisma.salon.create({
      data: {
        tenantId: tenantA.tenant.id,
        name: "Salon Review A1",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
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
    await closeTestApp();
  });

  // ── WR-01: PATCH/DELETE read the assignment inside the guarded transaction ─────────────────────

  it("WR-01: a PATCH that changes only the role keeps a scope narrowed concurrently, and its audit oldValue is the narrowed state", async () => {
    const grantee = await createUserWithEmployee(app, tenantA.tenant.id, "Grantee");
    const assignment = await assignTenant(grantee.user.id, roleX.id);
    beforeNextTransaction(() => narrowToSalon(assignment.id));

    const res = await patchAssignment(assignment.id, { accessRoleId: roleY.id });

    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    const stored = await app.prisma.roleAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    expect(stored.accessRoleId).toBe(roleY.id);
    expect(stored.scopeType, "the concurrent narrowing was silently reverted").toBe("SALONS");
    expect(stored.salonIds).toEqual([salonA1.id]);
    const audits = await assignmentAudits(assignment.id, "UPDATE");
    expect(audits).toHaveLength(1);
    expect(audits[0].oldValue).toEqual({
      userId: grantee.user.id,
      accessRoleId: roleX.id,
      roleName: roleX.name,
      scopeType: "SALONS",
      salonIds: [salonA1.id],
      employeeIds: [],
    });
  });

  it("WR-01: a PATCH that asks for the scope a concurrent write already set is a no-op — nothing written, nothing audited", async () => {
    const grantee = await createUserWithEmployee(app, tenantA.tenant.id, "Grantee");
    const assignment = await assignTenant(grantee.user.id, roleX.id);
    let narrowed: RoleAssignment | null = null;
    beforeNextTransaction(async () => {
      narrowed = await narrowToSalon(assignment.id);
    });

    const res = await patchAssignment(assignment.id, {
      scope: { type: "SALONS", salonIds: [salonA1.id] },
    });

    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    const stored = await app.prisma.roleAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    expect(stored).toEqual(narrowed);
    expect(await assignmentAudits(assignment.id, "UPDATE")).toHaveLength(0);
  });

  it("WR-01: DELETE records the state the row had when it was deleted, not a state read before the lock", async () => {
    const grantee = await createUserWithEmployee(app, tenantA.tenant.id, "Grantee");
    const assignment = await assignTenant(grantee.user.id, roleX.id);
    beforeNextTransaction(() => narrowToSalon(assignment.id));

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/role-assignments/${assignment.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    expect(res.statusCode, res.body.slice(0, 400)).toBe(204);
    const audits = await assignmentAudits(assignment.id, "DELETE");
    expect(audits).toHaveLength(1);
    expect(audits[0].oldValue).toMatchObject({ scopeType: "SALONS", salonIds: [salonA1.id] });
  });
});
