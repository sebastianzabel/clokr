/**
 * Phase 75b (Issue #75), D-14 — the compat role is DERIVED from role assignments at one place.
 *
 * `deriveCompatRole` is pure: ADMIN for a well-formed TENANT assignment on the Admin system role
 * (by id), MANAGER when any effective assignment's role grants a ZUGEWIESEN permission, EMPLOYEE
 * otherwise. `compatRoleForUser` reads the stored rows and falls back to the column when there
 * are none — which must equal deriving over the implicit fallback assignment (proved here for all
 * three system roles, so the shortcut cannot drift from the resolver's D-08 fallback).
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import type { Role } from "@clokr/db";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import {
  compatRoleForUser,
  deriveCompatRole,
  systemRoleIdForLegacyRole,
  type CompatRoleAssignmentRow,
} from "../compat-role";
import { SYSTEM_ROLE_IDS, SYSTEM_ROLE_PERMISSIONS, type SystemRoleSlot } from "../system-roles";
import { roleNameKey } from "../access-role";

const TENANT = "tenant-under-test";
const OTHER_TENANT = "another-tenant";

function systemRow(
  slot: SystemRoleSlot,
  scope: Pick<CompatRoleAssignmentRow, "scopeType" | "salonIds" | "employeeIds"> = {
    scopeType: "TENANT",
    salonIds: [],
    employeeIds: [],
  },
): CompatRoleAssignmentRow {
  return {
    ...scope,
    accessRole: {
      id: SYSTEM_ROLE_IDS[slot],
      tenantId: null,
      permissions: SYSTEM_ROLE_PERMISSIONS[slot],
    },
  };
}

function customerRow(
  permissions: string[],
  opts: { tenantId?: string; scopeType?: "TENANT" | "SALONS" | "PERSONS" } = {},
): CompatRoleAssignmentRow {
  const scopeType = opts.scopeType ?? "TENANT";
  return {
    scopeType,
    salonIds: scopeType === "SALONS" ? ["salon-1"] : [],
    employeeIds: scopeType === "PERSONS" ? ["employee-1"] : [],
    accessRole: { id: "customer-role", tenantId: opts.tenantId ?? TENANT, permissions },
  };
}

describe("compat role — pure derivation (D-14)", () => {
  it("systemRoleIdForLegacyRole maps each legacy value onto its system role id", () => {
    expect(systemRoleIdForLegacyRole("ADMIN")).toBe(SYSTEM_ROLE_IDS.ADMIN);
    expect(systemRoleIdForLegacyRole("MANAGER")).toBe(SYSTEM_ROLE_IDS.MANAGER);
    expect(systemRoleIdForLegacyRole("EMPLOYEE")).toBe(SYSTEM_ROLE_IDS.EMPLOYEE);
  });

  it("Admin system role at TENANT scope → ADMIN", () => {
    expect(deriveCompatRole(TENANT, [systemRow("ADMIN")])).toBe("ADMIN");
  });

  it("Admin system role via SALONS scope → MANAGER (never ADMIN below tenant scope)", () => {
    expect(
      deriveCompatRole(TENANT, [
        systemRow("ADMIN", { scopeType: "SALONS", salonIds: ["salon-1"], employeeIds: [] }),
      ]),
    ).toBe("MANAGER");
  });

  it("Manager → MANAGER; Mitarbeiter → EMPLOYEE", () => {
    expect(deriveCompatRole(TENANT, [systemRow("MANAGER")])).toBe("MANAGER");
    expect(deriveCompatRole(TENANT, [systemRow("EMPLOYEE")])).toBe("EMPLOYEE");
  });

  it.each(["TENANT", "SALONS", "PERSONS"] as const)(
    "a customer role with a ZUGEWIESEN key at %s scope → MANAGER",
    (scopeType) => {
      expect(
        deriveCompatRole(TENANT, [
          customerRow(["time-entry:read:EIGENE", "audit-log:read:ZUGEWIESEN"], { scopeType }),
        ]),
      ).toBe("MANAGER");
    },
  );

  it("a customer role with EIGENE keys only → EMPLOYEE", () => {
    expect(
      deriveCompatRole(TENANT, [customerRow(["time-entry:read:EIGENE", "overtime:read:EIGENE"])]),
    ).toBe("EMPLOYEE");
  });

  it("a foreign tenant's customer role and a malformed row contribute nothing", () => {
    expect(
      deriveCompatRole(TENANT, [
        customerRow(["audit-log:read:ZUGEWIESEN"], { tenantId: OTHER_TENANT }),
      ]),
    ).toBe("EMPLOYEE");
    expect(
      deriveCompatRole(TENANT, [
        systemRow("ADMIN", { scopeType: "TENANT", salonIds: ["salon-1"], employeeIds: [] }),
      ]),
    ).toBe("EMPLOYEE");
  });

  it("the union decides: Mitarbeiter plus Admin at TENANT → ADMIN; empty → EMPLOYEE", () => {
    expect(deriveCompatRole(TENANT, [systemRow("EMPLOYEE"), systemRow("ADMIN")])).toBe("ADMIN");
    expect(deriveCompatRole(TENANT, [])).toBe("EMPLOYEE");
  });

  it.each(["ADMIN", "MANAGER", "EMPLOYEE"] as const)(
    "deriving over the implicit fallback assignment of a legacy %s yields exactly that value",
    (role: Role) => {
      const slot = (Object.keys(SYSTEM_ROLE_IDS) as SystemRoleSlot[]).find(
        (s) => SYSTEM_ROLE_IDS[s] === systemRoleIdForLegacyRole(role),
      );
      expect(slot).toBeDefined();
      expect(deriveCompatRole(TENANT, [systemRow(slot as SystemRoleSlot)])).toBe(role);
    },
  );
});

describe("compat role — compatRoleForUser against the database (D-14, AC-75-5)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;

  async function createUser(role: Role, label: string, withEmployee = true) {
    const s = `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `cr-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role,
        isActive: true,
      },
    });
    if (withEmployee) {
      await app.prisma.employee.create({
        data: {
          tenantId: seed.tenant.id,
          userId: user.id,
          employeeNumber: `CR-${s}`.slice(0, 20),
          firstName: label,
          lastName: "Test",
          hireDate: new Date("2024-01-01"),
        },
      });
    }
    return user;
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "compat-role");
  });

  afterAll(async () => {
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: seed.tenant.id } });
      await app.prisma.accessRole.deleteMany({ where: { tenantId: seed.tenant.id } });
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
    await closeTestApp();
  });

  it.each(["ADMIN", "MANAGER", "EMPLOYEE"] as const)(
    "a legacy %s without stored assignments keeps the column value",
    async (role) => {
      const user = await createUser(role, `fb-${role}`);
      expect(await compatRoleForUser(app.prisma, user.id, seed.tenant.id, role)).toBe(role);
    },
  );

  it("an empty tenant (user without Employee) keeps the column value without a query", async () => {
    const user = await createUser("ADMIN", "no-emp", false);
    try {
      expect(await compatRoleForUser(app.prisma, user.id, "", "ADMIN")).toBe("ADMIN");
    } finally {
      await app.prisma.user.delete({ where: { id: user.id } });
    }
  });

  it("stored assignments win over the column: a legacy EMPLOYEE with a TENANT customer role holding a ZUGEWIESEN key → MANAGER", async () => {
    const user = await createUser("EMPLOYEE", "customer");
    const name = `Rolle ${user.id.slice(0, 8)}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: seed.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: ["team-overview:read:ZUGEWIESEN"],
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        userId: user.id,
        accessRoleId: role.id,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    expect(await compatRoleForUser(app.prisma, user.id, seed.tenant.id, "EMPLOYEE")).toBe(
      "MANAGER",
    );
  });

  it("a stored Admin TENANT assignment → ADMIN even when the column says EMPLOYEE", async () => {
    const user = await createUser("EMPLOYEE", "stored-admin");
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        userId: user.id,
        accessRoleId: SYSTEM_ROLE_IDS.ADMIN,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    expect(await compatRoleForUser(app.prisma, user.id, seed.tenant.id, "EMPLOYEE")).toBe("ADMIN");
  });
});
