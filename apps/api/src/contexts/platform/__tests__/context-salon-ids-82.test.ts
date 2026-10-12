/**
 * Phase 82 (Issue #82), D-03/D-04 — `contextSalonIds`, the one function that answers "which active
 * salons can this caller reach" for the web's salon context.
 *
 * What the consistency proof (D-04) protects: a "reachable salons" answer that silently drifts
 * from the reach the endpoints enforce. For every actor below, the managed part must equal the
 * union over EVERY ZUGEWIESEN catalog key of `resolveAccessReach` mapped to salons (wholeTenant →
 * every active salon, scoped → `salonIds`). A drift in either function turns this file red.
 *
 * Mutations, recorded here, not re-run by CI (Phase 82, 2026-10-12):
 * - M1: drop `isActive: true` from the SALONS-branch salon filter of `contextSalonIds` → red:
 *   "SALONS [A, I] reaches A only" and the D-04 comparison (the inactive salon appears in managed
 *   but never in resolveAccessReach's reach).
 * - M2: remove the "role belongs here" skip → red: "a row on a foreign tenant's customer role
 *   contributes nothing" and the D-04 comparison for that actor.
 *
 * `AccessContext` objects are hand-built, as in `resolve-access-reach.test.ts`. No person names in
 * fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import type { Role } from "@clokr/db";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { contextSalonIds, resolveAccessReach } from "../facade/role-assignments";
import type { AccessContext } from "../access-context";
import { normalizeRolePermissions, roleNameKey } from "../access-role";
import { DEFAULT_SALON_OPENING_HOURS } from "../facade/salons";
import { SYSTEM_ROLE_IDS } from "../system-roles";
import { PERMISSIONS, permissionKey, type PermissionKey } from "../permission-catalog";

type Seed = Awaited<ReturnType<typeof seedTestData>>;

const TODAY = new Date("2026-06-15T10:00:00.000Z");
const ZUGEWIESEN_KEYS: PermissionKey[] = PERMISSIONS.filter((p) => p.reach === "ZUGEWIESEN").map(
  permissionKey,
);

function uniqueSuffix(label: string): string {
  return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function ctxForUser(tenantId: string, userId: string): AccessContext {
  return { tenantId, actor: { kind: "user", userId }, reach: { kind: "wholeTenant" } };
}

describe("contextSalonIds (Phase 82, Issue #82, D-03/D-04)", () => {
  let app: FastifyInstance;
  let tA: Seed;
  let tB: Seed;
  let salonA: { id: string };
  let salonB: { id: string };
  let salonI: { id: string };
  let allActive: string[];
  const actors: { label: string; ctx: AccessContext }[] = [];

  async function createUser(role: Role, label: string, tenantId = tA.tenant.id) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash("test1234", 10);
    const user = await app.prisma.user.create({
      data: { email: `csi-${s}@test.de`, passwordHash, role, isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `CSI-${s}`.slice(0, 20),
        firstName: label,
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
      },
    });
    const ctx = ctxForUser(tenantId, user.id);
    actors.push({ label, ctx });
    return { user, employee, ctx };
  }

  function assign(
    userId: string,
    accessRoleId: string,
    scope: {
      scopeType: "TENANT" | "SALONS" | "PERSONS";
      salonIds?: string[];
      employeeIds?: string[];
    },
  ) {
    return app.prisma.roleAssignment.create({
      data: {
        tenantId: tA.tenant.id,
        userId,
        accessRoleId,
        scopeType: scope.scopeType,
        salonIds: scope.salonIds ?? [],
        employeeIds: scope.employeeIds ?? [],
      },
    });
  }

  function customerRole(tenantId: string, label: string, permissions: string[]) {
    const name = `Rolle ${uniqueSuffix(label)}`;
    return app.prisma.accessRole.create({
      data: {
        tenantId,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(permissions),
      },
    });
  }

  function createSalon(tenantId: string, name: string, isActive: boolean) {
    return app.prisma.salon.create({
      data: {
        tenantId,
        name,
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive,
        federalState: "NIEDERSACHSEN",
        ...(isActive ? {} : { deactivatedAt: new Date() }),
      },
    });
  }

  function deployment(employeeId: string, salonId: string, validFrom: string, until: string) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: tA.tenant.id,
        employeeId,
        salonId,
        kind: "DEPLOYMENT",
        validFrom: new Date(`${validFrom}T00:00:00Z`),
        validUntil: new Date(`${until}T00:00:00Z`),
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    tA = await seedTestData(app, "csi82a");
    tB = await seedTestData(app, "csi82b");
    salonA = await createSalon(tA.tenant.id, "CSI A", true);
    salonB = await createSalon(tA.tenant.id, "CSI B", true);
    salonI = await createSalon(tA.tenant.id, "CSI inactive", false);
    allActive = [tA.salonId, salonA.id, salonB.id].sort();
  });

  afterAll(async () => {
    try {
      // RoleAssignment.accessRole is Restrict: main tenant's assignments before tB's roles.
      for (const seed of [tA, tB]) {
        await app.prisma.roleAssignment.deleteMany({ where: { tenantId: seed.tenant.id } });
      }
      for (const seed of [tA, tB]) {
        await app.prisma.accessRole.deleteMany({ where: { tenantId: seed.tenant.id } });
      }
      await cleanupTestData(app, tA.tenant.id);
      await cleanupTestData(app, tB.tenant.id);
    } catch (err) {
      console.error("context-salon-ids-82 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("fallback MANAGER reaches every active salon, fallback EMPLOYEE none", async () => {
    const { ctx: manager } = await createUser("MANAGER", "fbManager");
    const { ctx: employee } = await createUser("EMPLOYEE", "fbEmployee");
    expect((await contextSalonIds(app.prisma, manager, TODAY)).managedSalonIds).toEqual(allActive);
    expect((await contextSalonIds(app.prisma, employee, TODAY)).managedSalonIds).toEqual([]);
  });

  it("one stored row on an EIGENE-only role disables the fallback, even for User.role ADMIN", async () => {
    const { user, ctx } = await createUser("ADMIN", "eigeneAdmin");
    const role = await customerRole(tA.tenant.id, "eigene", ["time-entry:read:EIGENE"]);
    await assign(user.id, role.id, { scopeType: "TENANT" });
    expect((await contextSalonIds(app.prisma, ctx, TODAY)).managedSalonIds).toEqual([]);
  });

  it("SALONS [A, I] reaches A only", async () => {
    const { user, ctx } = await createUser("EMPLOYEE", "salonsAI");
    await assign(user.id, SYSTEM_ROLE_IDS.SALON_MANAGER, {
      scopeType: "SALONS",
      salonIds: [salonA.id, salonI.id],
    });
    expect((await contextSalonIds(app.prisma, ctx, TODAY)).managedSalonIds).toEqual([salonA.id]);
  });

  it("SALONS [A] plus TENANT on the same user reaches every active salon", async () => {
    const { user, ctx } = await createUser("EMPLOYEE", "salonsPlusTenant");
    await assign(user.id, SYSTEM_ROLE_IDS.SALON_MANAGER, {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    await assign(user.id, SYSTEM_ROLE_IDS.HR, { scopeType: "TENANT" });
    expect((await contextSalonIds(app.prisma, ctx, TODAY)).managedSalonIds).toEqual(allActive);
  });

  it("PERSONS reaches no salon; a malformed row alone reaches nothing", async () => {
    const { employee: target } = await createUser("EMPLOYEE", "personsTarget");
    const { user, ctx } = await createUser("EMPLOYEE", "persons");
    await assign(user.id, SYSTEM_ROLE_IDS.TRAINER, {
      scopeType: "PERSONS",
      employeeIds: [target.id],
    });
    expect((await contextSalonIds(app.prisma, ctx, TODAY)).managedSalonIds).toEqual([]);

    const { user: malformedUser, ctx: malformed } = await createUser("ADMIN", "malformed");
    // TENANT scope must carry no salon id (D-03 shape) — the row contributes nothing, fail closed.
    await assign(malformedUser.id, SYSTEM_ROLE_IDS.HR, {
      scopeType: "TENANT",
      salonIds: [salonA.id],
    });
    expect((await contextSalonIds(app.prisma, malformed, TODAY)).managedSalonIds).toEqual([]);
  });

  it("a row on a foreign tenant's customer role contributes nothing", async () => {
    const { user, ctx } = await createUser("EMPLOYEE", "foreignRole");
    const role = await customerRole(tB.tenant.id, "foreign", ["time-entry:read:ZUGEWIESEN"]);
    await assign(user.id, role.id, { scopeType: "TENANT" });
    expect((await contextSalonIds(app.prisma, ctx, TODAY)).managedSalonIds).toEqual([]);
  });

  it("a deleted user reaches nothing at all", async () => {
    const ctx = ctxForUser(tA.tenant.id, crypto.randomUUID());
    actors.push({ label: "deleted", ctx });
    expect(await contextSalonIds(app.prisma, ctx, TODAY)).toEqual({
      salonIds: [],
      managedSalonIds: [],
      ownSalonIds: [],
      homeSalonId: null,
    });
  });

  it("an API key and a job reach every active salon, no own salons", async () => {
    const apiKey: AccessContext = {
      tenantId: tA.tenant.id,
      actor: { kind: "apiKey", apiKeyId: "csi-key" },
      reach: { kind: "wholeTenant" },
    };
    const job: AccessContext = {
      tenantId: tA.tenant.id,
      actor: { kind: "system", job: "csi-job" },
      reach: { kind: "wholeTenant" },
    };
    actors.push({ label: "apiKey", ctx: apiKey }, { label: "job", ctx: job });
    for (const ctx of [apiKey, job]) {
      expect(await contextSalonIds(app.prisma, ctx, TODAY)).toEqual({
        salonIds: allActive,
        managedSalonIds: allActive,
        ownSalonIds: [],
        homeSalonId: null,
      });
    }
  });

  it("own reach uses the tenant-local day of `today`", async () => {
    const { employee, ctx } = await createUser("EMPLOYEE", "tzEdge");
    await deployment(employee.id, salonA.id, "2026-06-01", "2026-06-30");
    await deployment(employee.id, salonB.id, "2026-06-01", "2026-07-01");
    // 2026-06-30T22:30Z is 2026-07-01 00:30 in Europe/Berlin: the row ending 30.06. is over.
    const result = await contextSalonIds(app.prisma, ctx, new Date("2026-06-30T22:30:00.000Z"));
    expect(result.ownSalonIds).toEqual([salonB.id]);
  });

  it("an anonymized employee has no own reach", async () => {
    const { employee, ctx } = await createUser("EMPLOYEE", "anonymized");
    await deployment(employee.id, salonA.id, "2026-01-01", "2026-12-31");
    await app.prisma.employee.update({
      where: { id: employee.id },
      data: { firstName: "Gelöscht", lastName: `GELÖSCHT-${uniqueSuffix("x")}` },
    });
    expect((await contextSalonIds(app.prisma, ctx, TODAY)).ownSalonIds).toEqual([]);
  });

  it("a missing system-role row throws for both reach functions, each with its own prefix", async () => {
    const stub = {
      roleAssignment: { findMany: async () => [] },
      user: { findUnique: async () => ({ role: "EMPLOYEE" }) },
      accessRole: { findUnique: async () => null },
    } as never;
    const ctx = ctxForUser(tA.tenant.id, "csi-stub-user");
    await expect(contextSalonIds(stub, ctx, TODAY)).rejects.toThrow(
      /^contextSalonIds: system role .* is missing/,
    );
    await expect(resolveAccessReach(stub, ctx, ZUGEWIESEN_KEYS[0])).rejects.toThrow(
      /^resolveAccessReach: system role .* is missing/,
    );
  });

  it("D-04: managed reach equals the union of resolveAccessReach over every ZUGEWIESEN key", async () => {
    expect(ZUGEWIESEN_KEYS.length).toBeGreaterThanOrEqual(50);
    // A stored TENANT grant and a fallback admin, so every comparison class is represented.
    const { user: tenantUser } = await createUser("EMPLOYEE", "storedTenant");
    await assign(tenantUser.id, SYSTEM_ROLE_IDS.HR, { scopeType: "TENANT" });
    await createUser("ADMIN", "fbAdmin");

    const classes = new Set<string>();
    for (const { label, ctx } of actors) {
      const expected = new Set<string>();
      for (const key of ZUGEWIESEN_KEYS) {
        const reach = await resolveAccessReach(app.prisma, ctx, key);
        if (reach.kind === "wholeTenant") allActive.forEach((id) => expected.add(id));
        else reach.salonIds.forEach((id) => expected.add(id));
      }
      const managed = (await contextSalonIds(app.prisma, ctx, TODAY)).managedSalonIds;
      expect(managed, label).toEqual([...expected].sort());

      const stored = await app.prisma.roleAssignment.count({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.actor.kind === "user" ? ctx.actor.userId : "",
        },
      });
      if (ctx.actor.kind !== "user") continue;
      if (managed.length === 0) classes.add("empty");
      else if (managed.length === allActive.length) {
        classes.add(stored > 0 ? "stored-tenant" : "fallback-tenant");
      } else classes.add("scoped");
    }
    expect([...classes].sort()).toEqual(["empty", "fallback-tenant", "scoped", "stored-tenant"]);
  });
});
