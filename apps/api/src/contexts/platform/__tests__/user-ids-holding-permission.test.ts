/**
 * Phase 75b Plan 10 (Issue #75), D-16/D-17, revised by Issue #367 (2026-09-29 owner decision) —
 * `userIdsHoldingPermission`, the Unterbau facade every notification-recipient site (17 of them)
 * asks instead of a role-based Prisma predicate.
 *
 * A holder is a well-formed stored assignment of ANY scope (TENANT, SALONS or PERSONS) whose role
 * belongs to the tenant and grants the permission — and nothing else: since #539 (Release A) a user
 * with NO stored assignment in the tenant is never a holder, whatever their `User.role` column says
 * (the former D-08 "Altrollen-Rückfall" no longer exists). Before Issue #367 (the
 * original D-09), a SALONS/PERSONS assignment never made a holder here — narrowing to the actual
 * scope is `resolveScopedHolderIds()`'s job (D-17); a malformed row (any scope) and a foreign
 * tenant's customer role still never make a holder. The facade does NOT filter `isActive` itself —
 * every site keeps that filter (and every other filter) on its own side; this test proves an
 * inactive holder is still returned here.
 *
 * Phase 355 (Issue #355): the facade DOES filter a departed holder — `Employee.exitDate` set and
 * in the past — itself, because no
 * site filtered `exitDate` on its own before this (the personal-data leak #355 reports). A holder
 * whose `exitDate` is in the future (not yet effective) is unaffected.
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import type { Prisma, Role } from "@clokr/db";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { roleNameKey, normalizeRolePermissions } from "../access-role";
import { DEFAULT_SALON_OPENING_HOURS } from "../facade/salons";
import { userIdsHoldingPermission } from "../facade/role-assignments";
import { SYSTEM_ROLE_IDS } from "../system-roles";

/** A,M permission with a real notification meaning (site #1, leave-request:approve). */
const LEAVE_REQUEST_APPROVE = "leave-request:approve:ZUGEWIESEN";
const LEAVE_REQUEST_READ_EIGENE = "leave-request:read:EIGENE";

function uniqueSuffix(label: string): string {
  return label + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Role-descriptive fixture user + employee — no person names (CLAUDE.md PII rule). */
async function createUserWithEmployee(
  app: FastifyInstance,
  tenantId: string,
  label: string,
  options: { role?: Role; isActive?: boolean; exitDate?: Date } = {},
) {
  const s = uniqueSuffix(label);
  const passwordHash = await bcrypt.hash("test1234", 10);
  const user = await app.prisma.user.create({
    data: {
      email: `uihp-${s}@test.de`,
      passwordHash,
      role: options.role ?? "EMPLOYEE",
      isActive: options.isActive ?? true,
    },
  });
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `UIHP-${s}`.slice(0, 20),
      firstName: label,
      lastName: "Test",
      hireDate: new Date("2024-01-01"),
      exitDate: options.exitDate,
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

async function createSalon(app: FastifyInstance, tenantId: string, name: string) {
  return app.prisma.salon.create({
    data: {
      tenantId,
      name,
      federalState: "NIEDERSACHSEN",
      openingHours: DEFAULT_SALON_OPENING_HOURS,
      isActive: true,
    },
  });
}

function assignTenant(
  app: FastifyInstance,
  tenantId: string,
  userId: string,
  accessRoleId: string,
) {
  return app.prisma.roleAssignment.create({
    data: { tenantId, userId, accessRoleId, scopeType: "TENANT", salonIds: [], employeeIds: [] },
  });
}

describe("userIdsHoldingPermission (Phase 75b, Issue #75, D-16/D-17)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;

  let storedAdmin: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let storedManager: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let storedEmployeeRole: Awaited<ReturnType<typeof createUserWithEmployee>>;

  let fallbackAdmin: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let fallbackManager: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let fallbackEmployee: Awaited<ReturnType<typeof createUserWithEmployee>>;

  let customerRoleGranting: Awaited<ReturnType<typeof createRole>>;
  let customerRoleHolder: Awaited<ReturnType<typeof createUserWithEmployee>>;

  let salon: Awaited<ReturnType<typeof createSalon>>;
  let salonScopeRole: Awaited<ReturnType<typeof createRole>>;
  let salonHolder: Awaited<ReturnType<typeof createUserWithEmployee>>;

  let personsScopeRole: Awaited<ReturnType<typeof createRole>>;
  let personsHolderTarget: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let personsHolder: Awaited<ReturnType<typeof createUserWithEmployee>>;

  let malformedTenantRole: Awaited<ReturnType<typeof createRole>>;
  let malformedHolder: Awaited<ReturnType<typeof createUserWithEmployee>>;

  // Issue #367: a malformed SALONS row (empty salonIds) — the same D-03 fail-closed shape check
  // now applies to a non-TENANT scope too, since Issue #367 widened the candidate set to include
  // well-formed SALONS/PERSONS rows.
  let malformedSalonsRole: Awaited<ReturnType<typeof createRole>>;
  let malformedSalonsHolder: Awaited<ReturnType<typeof createUserWithEmployee>>;

  let foreignRoleInB: Awaited<ReturnType<typeof createRole>>;
  let foreignCustomerHolder: Awaited<ReturnType<typeof createUserWithEmployee>>;

  let tenantBHolder: Awaited<ReturnType<typeof createUserWithEmployee>>;

  let inactiveHolder: Awaited<ReturnType<typeof createUserWithEmployee>>;

  let dedupeHolder: Awaited<ReturnType<typeof createUserWithEmployee>>;

  // Phase 355 (Issue #355): a departed ADMIN/MANAGER — active user, but `exitDate` in the past —
  // must not be returned (stored TENANT-scope assignment; a user without a row is never a holder since #539).
  let departedStoredAdmin: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let departedFallbackManager: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let futureExitAdmin: Awaited<ReturnType<typeof createUserWithEmployee>>;

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "75b10-uihp-a");
    tenantB = await seedTestData(app, "75b10-uihp-b");

    storedAdmin = await createUserWithEmployee(app, tenantA.tenant.id, "StoredAdmin");
    await assignTenant(app, tenantA.tenant.id, storedAdmin.user.id, SYSTEM_ROLE_IDS.ADMIN);
    storedManager = await createUserWithEmployee(app, tenantA.tenant.id, "StoredManager");
    await assignTenant(app, tenantA.tenant.id, storedManager.user.id, SYSTEM_ROLE_IDS.MANAGER);
    storedEmployeeRole = await createUserWithEmployee(app, tenantA.tenant.id, "StoredEmployeeRole");
    await assignTenant(
      app,
      tenantA.tenant.id,
      storedEmployeeRole.user.id,
      SYSTEM_ROLE_IDS.EMPLOYEE,
    );

    fallbackAdmin = await createUserWithEmployee(app, tenantA.tenant.id, "FallbackAdmin", {
      role: "ADMIN",
    });
    fallbackManager = await createUserWithEmployee(app, tenantA.tenant.id, "FallbackManager", {
      role: "MANAGER",
    });
    fallbackEmployee = await createUserWithEmployee(app, tenantA.tenant.id, "FallbackEmployee", {
      role: "EMPLOYEE",
    });

    customerRoleGranting = await createRole(app, tenantA.tenant.id, "CustomerGrant", [
      LEAVE_REQUEST_APPROVE,
    ]);
    customerRoleHolder = await createUserWithEmployee(app, tenantA.tenant.id, "CustomerRoleHolder");
    await assignTenant(app, tenantA.tenant.id, customerRoleHolder.user.id, customerRoleGranting.id);

    salon = await createSalon(app, tenantA.tenant.id, "Salon UIHP");
    salonScopeRole = await createRole(app, tenantA.tenant.id, "SalonGrant", [
      LEAVE_REQUEST_APPROVE,
    ]);
    salonHolder = await createUserWithEmployee(app, tenantA.tenant.id, "SalonHolder");
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        userId: salonHolder.user.id,
        accessRoleId: salonScopeRole.id,
        scopeType: "SALONS",
        salonIds: [salon.id],
        employeeIds: [],
      },
    });

    personsScopeRole = await createRole(app, tenantA.tenant.id, "PersonsGrant", [
      LEAVE_REQUEST_APPROVE,
    ]);
    personsHolderTarget = await createUserWithEmployee(app, tenantA.tenant.id, "PersonsTarget");
    personsHolder = await createUserWithEmployee(app, tenantA.tenant.id, "PersonsHolder");
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        userId: personsHolder.user.id,
        accessRoleId: personsScopeRole.id,
        scopeType: "PERSONS",
        salonIds: [],
        employeeIds: [personsHolderTarget.employee.id],
      },
    });

    // A malformed TENANT row (D-03 violation) — bypasses the API's own validation on purpose,
    // the same way 74b review IN-02 tests it: this facade must fail closed on it, not throw.
    malformedTenantRole = await createRole(app, tenantA.tenant.id, "MalformedGrant", [
      LEAVE_REQUEST_APPROVE,
    ]);
    malformedHolder = await createUserWithEmployee(app, tenantA.tenant.id, "MalformedHolder");
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        userId: malformedHolder.user.id,
        accessRoleId: malformedTenantRole.id,
        scopeType: "TENANT",
        salonIds: [salon.id],
        employeeIds: [],
      },
    });

    // Issue #367: a malformed SALONS row — scopeType SALONS with an empty salonIds list violates
    // storedRoleAssignmentScope's D-03 shape (SALONS requires salonIds.length > 0), so it must
    // fail closed exactly like the malformed TENANT row above.
    malformedSalonsRole = await createRole(app, tenantA.tenant.id, "MalformedSalonsGrant", [
      LEAVE_REQUEST_APPROVE,
    ]);
    malformedSalonsHolder = await createUserWithEmployee(
      app,
      tenantA.tenant.id,
      "MalformedSalonsHolder",
    );
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        userId: malformedSalonsHolder.user.id,
        accessRoleId: malformedSalonsRole.id,
        scopeType: "SALONS",
        salonIds: [],
        employeeIds: [],
      },
    });

    // A TENANT-scope row of tenantA referencing a customer role that belongs to tenantB — models
    // a foreign tenant's customer role slipping onto a row (never producible through the API).
    foreignRoleInB = await createRole(app, tenantB.tenant.id, "ForeignGrant", [
      LEAVE_REQUEST_APPROVE,
    ]);
    foreignCustomerHolder = await createUserWithEmployee(
      app,
      tenantA.tenant.id,
      "ForeignCustomerHolder",
    );
    await assignTenant(app, tenantA.tenant.id, foreignCustomerHolder.user.id, foreignRoleInB.id);

    tenantBHolder = await createUserWithEmployee(app, tenantB.tenant.id, "TenantBHolder");
    await assignTenant(app, tenantB.tenant.id, tenantBHolder.user.id, SYSTEM_ROLE_IDS.ADMIN);

    inactiveHolder = await createUserWithEmployee(app, tenantA.tenant.id, "InactiveHolder", {
      isActive: false,
    });
    await assignTenant(app, tenantA.tenant.id, inactiveHolder.user.id, SYSTEM_ROLE_IDS.ADMIN);

    dedupeHolder = await createUserWithEmployee(app, tenantA.tenant.id, "DedupeHolder");
    await assignTenant(app, tenantA.tenant.id, dedupeHolder.user.id, SYSTEM_ROLE_IDS.ADMIN);
    await assignTenant(app, tenantA.tenant.id, dedupeHolder.user.id, customerRoleGranting.id);

    // Phase 355 (Issue #355): departed (exitDate in the past), still active — a stored TENANT
    // assignment, and one with no stored row at all (never a holder since #539).
    departedStoredAdmin = await createUserWithEmployee(
      app,
      tenantA.tenant.id,
      "DepartedStoredAdmin",
      {
        exitDate: new Date("2020-01-01"),
      },
    );
    await assignTenant(app, tenantA.tenant.id, departedStoredAdmin.user.id, SYSTEM_ROLE_IDS.ADMIN);
    departedFallbackManager = await createUserWithEmployee(
      app,
      tenantA.tenant.id,
      "DepartedFallbackManager",
      { role: "MANAGER", exitDate: new Date("2020-01-01") },
    );
    // A planned, not-yet-effective departure must still be a holder.
    futureExitAdmin = await createUserWithEmployee(app, tenantA.tenant.id, "FutureExitAdmin", {
      exitDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    });
    await assignTenant(app, tenantA.tenant.id, futureExitAdmin.user.id, SYSTEM_ROLE_IDS.ADMIN);
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

  it("stored TENANT Admin/Manager system-role holders are returned; a Mitarbeiter holder is not", async () => {
    const ids = await userIdsHoldingPermission(
      app.prisma,
      tenantA.tenant.id,
      LEAVE_REQUEST_APPROVE,
    );
    expect(ids).toContain(storedAdmin.user.id);
    expect(ids).toContain(storedManager.user.id);
    expect(ids).not.toContain(storedEmployeeRole.user.id);
  });

  it("a user with no stored assignment is never returned, whatever their User.role says (#539: no Altrollen-Rückfall)", async () => {
    const ids = await userIdsHoldingPermission(
      app.prisma,
      tenantA.tenant.id,
      LEAVE_REQUEST_APPROVE,
    );
    expect(ids).not.toContain(fallbackAdmin.user.id);
    expect(ids).not.toContain(fallbackManager.user.id);
    expect(ids).not.toContain(fallbackEmployee.user.id);
  });

  it("Issue #367: a well-formed SALONS or PERSONS assignment granting the permission NOW makes a holder (revises D-09)", async () => {
    const ids = await userIdsHoldingPermission(
      app.prisma,
      tenantA.tenant.id,
      LEAVE_REQUEST_APPROVE,
    );
    expect(ids).toContain(salonHolder.user.id);
    expect(ids).toContain(personsHolder.user.id);
  });

  it("Issue #367: a malformed SALONS row (empty salonIds) still does not make a holder (D-03 shape, fail closed for every scope)", async () => {
    const ids = await userIdsHoldingPermission(
      app.prisma,
      tenantA.tenant.id,
      LEAVE_REQUEST_APPROVE,
    );
    expect(ids).not.toContain(malformedSalonsHolder.user.id);
  });

  it("a malformed TENANT row does not make a holder (D-03 shape, fail closed)", async () => {
    const ids = await userIdsHoldingPermission(
      app.prisma,
      tenantA.tenant.id,
      LEAVE_REQUEST_APPROVE,
    );
    expect(ids).not.toContain(malformedHolder.user.id);
  });

  it("a foreign tenant's customer role does not make a holder", async () => {
    const ids = await userIdsHoldingPermission(
      app.prisma,
      tenantA.tenant.id,
      LEAVE_REQUEST_APPROVE,
    );
    expect(ids).not.toContain(foreignCustomerHolder.user.id);
  });

  it("a TENANT customer-role holder of the permission IS returned (new behaviour)", async () => {
    const ids = await userIdsHoldingPermission(
      app.prisma,
      tenantA.tenant.id,
      LEAVE_REQUEST_APPROVE,
    );
    expect(ids).toContain(customerRoleHolder.user.id);
  });

  it("users of another tenant are never returned", async () => {
    const ids = await userIdsHoldingPermission(
      app.prisma,
      tenantA.tenant.id,
      LEAVE_REQUEST_APPROVE,
    );
    expect(ids).not.toContain(tenantBHolder.user.id);
  });

  it("inactive users ARE returned — the site filters isActive itself", async () => {
    const ids = await userIdsHoldingPermission(
      app.prisma,
      tenantA.tenant.id,
      LEAVE_REQUEST_APPROVE,
    );
    expect(ids).toContain(inactiveHolder.user.id);
  });

  it("a departed holder (exitDate in the past) is NOT returned, stored assignment (Issue #355)", async () => {
    const ids = await userIdsHoldingPermission(
      app.prisma,
      tenantA.tenant.id,
      LEAVE_REQUEST_APPROVE,
    );
    expect(ids).not.toContain(departedStoredAdmin.user.id);
  });

  it("a departed user without a stored assignment is NOT returned either (Issue #355; since #539 never a holder)", async () => {
    const ids = await userIdsHoldingPermission(
      app.prisma,
      tenantA.tenant.id,
      LEAVE_REQUEST_APPROVE,
    );
    expect(ids).not.toContain(departedFallbackManager.user.id);
  });

  it("a holder with a FUTURE exitDate (not yet departed) IS returned (Issue #355)", async () => {
    const ids = await userIdsHoldingPermission(
      app.prisma,
      tenantA.tenant.id,
      LEAVE_REQUEST_APPROVE,
    );
    expect(ids).toContain(futureExitAdmin.user.id);
  });

  it("an EIGENE key throws", async () => {
    await expect(
      userIdsHoldingPermission(app.prisma, tenantA.tenant.id, LEAVE_REQUEST_READ_EIGENE),
    ).rejects.toThrow();
  });

  it("the result has no duplicates, even for a user with two granting assignments", async () => {
    const ids = await userIdsHoldingPermission(
      app.prisma,
      tenantA.tenant.id,
      LEAVE_REQUEST_APPROVE,
    );
    expect(ids.filter((id) => id === dedupeHolder.user.id)).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // ── Issue #359, as of #539 ───────────────────────────────────────────────────
  // A fallback-eligible user's system role used to be looked up, and a missing system-role row made
  // this function throw (Issue #359). Since #539 there is no fallback and no system-role lookup: the
  // facade reads stored rows only. A fake `db` (never `app.prisma`) WITHOUT an `accessRole` or `user`
  // delegate proves it — any such read would be a TypeError instead of the empty answer.
  it("Issue #359 / #539: with no stored row the facade answers [] without any system-role or user lookup", async () => {
    const fakeDb = {
      roleAssignment: { findMany: async () => [] },
    } as unknown as Prisma.TransactionClient;

    await expect(
      userIdsHoldingPermission(fakeDb, tenantA.tenant.id, LEAVE_REQUEST_APPROVE),
    ).resolves.toEqual([]);
  });
});
