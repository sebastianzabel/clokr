/**
 * Phase 75b (Issue #75) — the system roles and the legacy-role data migration, proven on REAL SQL
 * execution of the checked-in file (`legacy-role-migration-sql.ts`), never on a restatement of it.
 *
 * - D-04 drift: the three global rows in the migrated worker database equal
 *   `SYSTEM_ROLE_PERMISSIONS` — the code constant and the migration cannot silently diverge.
 * - AC-75-4 / AC-75-6: a legacy MANAGER with an Employee receives exactly one TENANT assignment on
 *   the Manager system role, with exactly one CREATE audit row whose actor is the system.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { executeLegacyRoleMigration } from "./legacy-role-migration-sql";
import { SYSTEM_ROLE_IDS, SYSTEM_ROLE_NAMES, SYSTEM_ROLE_PERMISSIONS } from "../contexts/platform";

type LegacyRole = "ADMIN" | "MANAGER" | "EMPLOYEE";

/** Role-descriptive fixture user + employee — no person names (CLAUDE.md PII rule). */
async function createUserWithEmployee(
  app: FastifyInstance,
  tenantId: string,
  label: string,
  role: LegacyRole,
) {
  const s = label + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const passwordHash = await bcrypt.hash("test1234", 4);
  const user = await app.prisma.user.create({
    data: { email: `${s}@test.de`, passwordHash, role, isActive: true },
  });
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `MIG-${s}`.slice(0, 20),
      firstName: label,
      lastName: "Test",
      hireDate: new Date("2024-01-01"),
    },
  });
  return { user, employee };
}

/** The exact audit `newValue` the migration writes (74b keys verbatim + origin/reason/legacyRole). */
function expectedAuditValue(
  userId: string,
  accessRoleId: string,
  roleName: string,
  legacyRole: LegacyRole,
) {
  return {
    origin: "SYSTEM",
    reason: "Migration der Alt-Rolle (#75)",
    userId,
    accessRoleId,
    roleName,
    scopeType: "TENANT",
    salonIds: [],
    employeeIds: [],
    legacyRole,
  };
}

describe("Phase 75b — system roles and legacy-role migration (Issue #75)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let manager: Awaited<ReturnType<typeof createUserWithEmployee>>;

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "75b-mig-a");
    manager = await createUserWithEmployee(app, tenantA.tenant.id, "Manager", "MANAGER");
    await executeLegacyRoleMigration(app.prisma);
  });

  afterAll(async () => {
    try {
      // The user cascade removes the users' role assignments before the tenant is deleted.
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("(a) D-04 drift: the three global rows equal SYSTEM_ROLE_PERMISSIONS", async () => {
    const rows = await app.prisma.accessRole.findMany({
      where: { id: { in: Object.values(SYSTEM_ROLE_IDS) } },
      orderBy: { id: "asc" },
    });
    expect(rows).toHaveLength(3);
    const bySlot = [
      ["ADMIN", rows[0]],
      ["MANAGER", rows[1]],
      ["EMPLOYEE", rows[2]],
    ] as const;
    for (const [slot, row] of bySlot) {
      expect(row.id).toBe(SYSTEM_ROLE_IDS[slot]);
      expect(row.tenantId).toBeNull();
      expect(row.name).toBe(SYSTEM_ROLE_NAMES[slot]);
      expect(row.nameKey).toBe(SYSTEM_ROLE_NAMES[slot].toLowerCase());
      expect(row.permissions).toEqual([...SYSTEM_ROLE_PERMISSIONS[slot]]);
    }
  });

  it("(b) a legacy MANAGER receives one TENANT assignment on the Manager role, audited as System", async () => {
    const assignments = await app.prisma.roleAssignment.findMany({
      where: { userId: manager.user.id },
    });
    expect(assignments).toHaveLength(1);
    const [assignment] = assignments;
    expect(assignment).toMatchObject({
      tenantId: tenantA.tenant.id,
      accessRoleId: SYSTEM_ROLE_IDS.MANAGER,
      scopeType: "TENANT",
      salonIds: [],
      employeeIds: [],
    });

    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "RoleAssignment", entityId: assignment.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBeNull();
    expect(audits[0].action).toBe("CREATE");
    expect(audits[0].newValue).toEqual(
      expectedAuditValue(
        manager.user.id,
        SYSTEM_ROLE_IDS.MANAGER,
        SYSTEM_ROLE_NAMES.MANAGER,
        "MANAGER",
      ),
    );
  });
});
