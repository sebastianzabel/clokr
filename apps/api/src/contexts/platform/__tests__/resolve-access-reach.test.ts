/**
 * Phase 91b Plan 01 (Issue #91), D-03/D-04 — unit + integration tests for `resolveAccessReach`,
 * the function that answers "how far does this caller reach, for THIS specific permission".
 *
 * `AccessContext` objects are hand-built (no HTTP layer, no `accessContextFromRequest` — that
 * constructor is Phase 77b's own, already tested); `resolveAccessReach` is exercised directly
 * against the real worker database, the same way `role-assignments.test.ts` exercises the sibling
 * facade functions `userMayApply`/`userIdsHoldingPermission`.
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import type { Role } from "@clokr/db";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { resolveAccessReach } from "../facade/role-assignments";
import type { AccessContext } from "../access-context";
import { roleNameKey } from "../access-role";
import { DEFAULT_SALON_OPENING_HOURS } from "../facade/salons";
import { SYSTEM_ROLE_IDS } from "../system-roles";
import type { PermissionKey } from "../permission-catalog";

type Seed = Awaited<ReturnType<typeof seedTestData>>;

function uniqueSuffix(label: string): string {
  return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** A hand-built `AccessContext` for a user actor — `resolveAccessReach` reads only `tenantId`
 * and `actor` from it, never `reach` (that field is what this function itself resolves). */
function ctxForUser(tenantId: string, userId: string): AccessContext {
  return { tenantId, actor: { kind: "user", userId }, reach: { kind: "wholeTenant" } };
}

function ctxForApiKey(tenantId: string): AccessContext {
  return {
    tenantId,
    actor: { kind: "apiKey", apiKeyId: "rar-key" },
    reach: { kind: "wholeTenant" },
  };
}

function ctxForSystem(tenantId: string): AccessContext {
  return { tenantId, actor: { kind: "system", job: "rar-job" }, reach: { kind: "wholeTenant" } };
}

/** A `db` handle that throws on ANY property access — proves a code path never touches the DB. */
function dbThatMustNotBeTouched(): never {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("resolveAccessReach must not read the database for this actor kind");
      },
    },
  ) as never;
}

describe("resolveAccessReach (Phase 91b Plan 01, Issue #91, D-03/D-04)", () => {
  let app: FastifyInstance;
  let tA: Seed;
  let tB: Seed;
  const createdUserIds: string[] = [];

  /** A user with an Employee in `tenantId`, legacy column `role`, no stored assignment. */
  async function createUser(tenantId: string, role: Role, label: string) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash("test1234", 10);
    const user = await app.prisma.user.create({
      data: { email: `rar-${s}@test.de`, passwordHash, role, isActive: true },
    });
    createdUserIds.push(user.id);
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `RAR-${s}`.slice(0, 20),
        firstName: label,
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
      },
    });
    return { user, employee };
  }

  async function assign(
    tenantId: string,
    userId: string,
    accessRoleId: string,
    scope: {
      scopeType: "TENANT" | "SALONS" | "PERSONS";
      salonIds?: string[];
      employeeIds?: string[];
    },
  ) {
    await app.prisma.roleAssignment.create({
      data: {
        tenantId,
        userId,
        accessRoleId,
        scopeType: scope.scopeType,
        salonIds: scope.salonIds ?? [],
        employeeIds: scope.employeeIds ?? [],
      },
    });
  }

  async function customerRole(tenantId: string, label: string, permissions: PermissionKey[]) {
    const name = `Rolle ${uniqueSuffix(label)}`;
    return app.prisma.accessRole.create({
      data: { tenantId, name, nameKey: roleNameKey(name), permissions },
    });
  }

  async function createSalon(tenantId: string, name: string, isActive: boolean) {
    return app.prisma.salon.create({
      data: {
        tenantId,
        name,
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive,
        federalState: "NIEDERSACHSEN", // Phase 71b (issue #71) — required since the merge; irrelevant to this test's own assertions
        ...(isActive ? {} : { deactivatedAt: new Date() }),
      },
    });
  }

  let salonA1: Awaited<ReturnType<typeof createSalon>>;
  let salonA2: Awaited<ReturnType<typeof createSalon>>;
  let salonA3Inactive: Awaited<ReturnType<typeof createSalon>>;

  beforeAll(async () => {
    app = await getTestApp();
    tA = await seedTestData(app, "rar-a");
    tB = await seedTestData(app, "rar-b");
    salonA1 = await createSalon(tA.tenant.id, "RAR Salon A1", true);
    salonA2 = await createSalon(tA.tenant.id, "RAR Salon A2", true);
    salonA3Inactive = await createSalon(tA.tenant.id, "RAR Salon A3", false);
  });

  afterAll(async () => {
    for (const seed of [tA, tB]) {
      try {
        await app.prisma.roleAssignment.deleteMany({ where: { tenantId: seed.tenant.id } });
        await app.prisma.accessRole.deleteMany({ where: { tenantId: seed.tenant.id } });
        await cleanupTestData(app, seed.tenant.id);
      } catch (err) {
        console.error("Cleanup failed:", err);
      }
    }
    await closeTestApp();
  });

  // ── D-03 union shape ─────────────────────────────────────────────────────────

  it("a TENANT-scope assignment whose role grants the permission resolves to wholeTenant", async () => {
    const { user } = await createUser(tA.tenant.id, "EMPLOYEE", "tenant");
    await assign(tA.tenant.id, user.id, SYSTEM_ROLE_IDS.MANAGER, { scopeType: "TENANT" });
    const reach = await resolveAccessReach(
      app.prisma,
      ctxForUser(tA.tenant.id, user.id),
      "time-entry:read:ZUGEWIESEN",
    );
    expect(reach).toEqual({ kind: "wholeTenant" });
  });

  it("a SALONS-scope assignment (2 active salons) resolves to their sorted ids, no employees", async () => {
    const { user } = await createUser(tA.tenant.id, "EMPLOYEE", "salons2");
    await assign(tA.tenant.id, user.id, SYSTEM_ROLE_IDS.MANAGER, {
      scopeType: "SALONS",
      salonIds: [salonA2.id, salonA1.id],
    });
    const reach = await resolveAccessReach(
      app.prisma,
      ctxForUser(tA.tenant.id, user.id),
      "time-entry:read:ZUGEWIESEN",
    );
    expect(reach).toEqual({
      kind: "scoped",
      salonIds: [salonA1.id, salonA2.id].sort(),
      employeeIds: [],
    });
  });

  it("a PERSONS-scope assignment (2 employees) resolves to their sorted ids, no salons", async () => {
    const { user } = await createUser(tA.tenant.id, "EMPLOYEE", "persons2");
    const personX = await createUser(tA.tenant.id, "EMPLOYEE", "persons2-x");
    const personY = await createUser(tA.tenant.id, "EMPLOYEE", "persons2-y");
    await assign(tA.tenant.id, user.id, SYSTEM_ROLE_IDS.MANAGER, {
      scopeType: "PERSONS",
      employeeIds: [personY.employee.id, personX.employee.id],
    });
    const reach = await resolveAccessReach(
      app.prisma,
      ctxForUser(tA.tenant.id, user.id),
      "time-entry:read:ZUGEWIESEN",
    );
    expect(reach).toEqual({
      kind: "scoped",
      salonIds: [],
      employeeIds: [personX.employee.id, personY.employee.id].sort(),
    });
  });

  it("two assignments (SALONS A + PERSONS on employee C) resolve to the UNION, never two separate reaches", async () => {
    const { user } = await createUser(tA.tenant.id, "EMPLOYEE", "union");
    const personC = await createUser(tA.tenant.id, "EMPLOYEE", "union-c");
    await assign(tA.tenant.id, user.id, SYSTEM_ROLE_IDS.MANAGER, {
      scopeType: "SALONS",
      salonIds: [salonA1.id],
    });
    await assign(tA.tenant.id, user.id, SYSTEM_ROLE_IDS.MANAGER, {
      scopeType: "PERSONS",
      employeeIds: [personC.employee.id],
    });
    const reach = await resolveAccessReach(
      app.prisma,
      ctxForUser(tA.tenant.id, user.id),
      "time-entry:read:ZUGEWIESEN",
    );
    expect(reach).toEqual({
      kind: "scoped",
      salonIds: [salonA1.id],
      employeeIds: [personC.employee.id],
    });
  });

  // ── D-04 live salon-activity filter ─────────────────────────────────────────

  it("a SALONS assignment naming a currently INACTIVE salon excludes that salon id", async () => {
    const { user } = await createUser(tA.tenant.id, "EMPLOYEE", "inactive-salon");
    await assign(tA.tenant.id, user.id, SYSTEM_ROLE_IDS.MANAGER, {
      scopeType: "SALONS",
      salonIds: [salonA1.id, salonA3Inactive.id],
    });
    const reach = await resolveAccessReach(
      app.prisma,
      ctxForUser(tA.tenant.id, user.id),
      "time-entry:read:ZUGEWIESEN",
    );
    expect(reach).toEqual({ kind: "scoped", salonIds: [salonA1.id], employeeIds: [] });
  });

  // ── fail closed ──────────────────────────────────────────────────────────────

  it("a malformed stored row (TENANT with salon ids) contributes nothing", async () => {
    const { user } = await createUser(tA.tenant.id, "EMPLOYEE", "malformed");
    await assign(tA.tenant.id, user.id, SYSTEM_ROLE_IDS.MANAGER, {
      scopeType: "TENANT",
      salonIds: [salonA1.id],
    });
    const reach = await resolveAccessReach(
      app.prisma,
      ctxForUser(tA.tenant.id, user.id),
      "time-entry:read:ZUGEWIESEN",
    );
    expect(reach).toEqual({ kind: "scoped", salonIds: [], employeeIds: [] });
  });

  it("an assignment whose role does not grant the permission contributes nothing", async () => {
    const { user } = await createUser(tA.tenant.id, "EMPLOYEE", "non-granting");
    const role = await customerRole(tA.tenant.id, "non-granting", ["audit-log:read:ZUGEWIESEN"]);
    await assign(tA.tenant.id, user.id, role.id, { scopeType: "SALONS", salonIds: [salonA1.id] });
    const reach = await resolveAccessReach(
      app.prisma,
      ctxForUser(tA.tenant.id, user.id),
      "time-entry:read:ZUGEWIESEN",
    );
    expect(reach).toEqual({ kind: "scoped", salonIds: [], employeeIds: [] });
  });

  it("an assignment on a role belonging to a FOREIGN tenant contributes nothing", async () => {
    const { user } = await createUser(tA.tenant.id, "EMPLOYEE", "foreign-role");
    const foreignRole = await customerRole(tB.tenant.id, "foreign", ["time-entry:read:ZUGEWIESEN"]);
    await assign(tA.tenant.id, user.id, foreignRole.id, {
      scopeType: "SALONS",
      salonIds: [salonA1.id],
    });
    const reach = await resolveAccessReach(
      app.prisma,
      ctxForUser(tA.tenant.id, user.id),
      "time-entry:read:ZUGEWIESEN",
    );
    expect(reach).toEqual({ kind: "scoped", salonIds: [], employeeIds: [] });
  });

  // ── the legacy-fallback regression (load-bearing, see mutation proof M2) ─────

  it("a user with ZERO stored assignments whose legacy role grants the permission resolves to wholeTenant (Altrollen-Rückfall)", async () => {
    const { user } = await createUser(tA.tenant.id, "MANAGER", "fallback-grants");
    const reach = await resolveAccessReach(
      app.prisma,
      ctxForUser(tA.tenant.id, user.id),
      "time-entry:read:ZUGEWIESEN",
    );
    expect(reach).toEqual({ kind: "wholeTenant" });
  });

  it("a user with ZERO stored assignments whose legacy role does NOT grant the permission resolves to scoped-empty", async () => {
    const { user } = await createUser(tA.tenant.id, "EMPLOYEE", "fallback-denies");
    const reach = await resolveAccessReach(
      app.prisma,
      ctxForUser(tA.tenant.id, user.id),
      "time-entry:read:ZUGEWIESEN",
    );
    expect(reach).toEqual({ kind: "scoped", salonIds: [], employeeIds: [] });
  });

  it("a deleted user (valid token, no User row) resolves to scoped-empty", async () => {
    const reach = await resolveAccessReach(
      app.prisma,
      ctxForUser(tA.tenant.id, "00000000-0000-4000-8000-0000000dead2"),
      "time-entry:read:ZUGEWIESEN",
    );
    expect(reach).toEqual({ kind: "scoped", salonIds: [], employeeIds: [] });
  });

  // ── non-user actors ──────────────────────────────────────────────────────────

  it("an apiKey actor resolves to wholeTenant unconditionally, with NO database read at all", async () => {
    const reach = await resolveAccessReach(
      dbThatMustNotBeTouched(),
      ctxForApiKey(tA.tenant.id),
      "time-entry:read:ZUGEWIESEN",
    );
    expect(reach).toEqual({ kind: "wholeTenant" });
  });

  it("a system actor resolves to wholeTenant unconditionally, with NO database read at all", async () => {
    const reach = await resolveAccessReach(
      dbThatMustNotBeTouched(),
      ctxForSystem(tA.tenant.id),
      "time-entry:read:ZUGEWIESEN",
    );
    expect(reach).toEqual({ kind: "wholeTenant" });
  });

  // ── unknown permission ───────────────────────────────────────────────────────

  it("an unknown permission key throws", async () => {
    await expect(
      resolveAccessReach(
        app.prisma,
        ctxForUser(tA.tenant.id, tA.adminUser.id),
        "audit-log:fly:ZUGEWIESEN" as PermissionKey,
      ),
    ).rejects.toThrow(/unknown permission/i);
  });
});
