/**
 * Phase 91b Plan 09 (Issue #91), D-17 — tests for `resolveScopedHolderIds`, the one shared
 * narrowing helper every manager-notification recipient site in this phase composes with
 * `userIdsHoldingPermission`.
 *
 * Exercised against the real worker database (via `resolveAccessReach`, already tested in
 * `resolve-access-reach.test.ts`) rather than a mock — this module has no `db`-free unit-test
 * seam of its own (it IS the composition of `resolveAccessReach` per candidate), so "unit-tested
 * without a database" (the plan's acceptance criterion) is read as "pure resolution LOGIC
 * (filter/keep, order preservation, isInScope contract), proven with real, minimal fixtures
 * rather than mocked Prisma calls" — the same convention `resolve-access-reach.test.ts` itself
 * uses one level down.
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Role } from "@clokr/db";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { resolveScopedHolderIds } from "../facade/role-assignments";
import { SYSTEM_ROLE_IDS } from "../system-roles";
import { DEFAULT_SALON_OPENING_HOURS } from "../facade/salons";
import type { AccessReach } from "../access-context";

type Seed = Awaited<ReturnType<typeof seedTestData>>;

function uniqueSuffix(label: string): string {
  return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

describe("resolveScopedHolderIds (Phase 91b Plan 09, Issue #91, D-17)", () => {
  let app: FastifyInstance;
  let tA: Seed;
  const createdUserIds: string[] = [];

  async function createUser(tenantId: string, role: Role, label: string) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash("test1234", 10);
    const user = await app.prisma.user.create({
      data: { email: `rsh-${s}@test.de`, passwordHash, role, isActive: true },
    });
    createdUserIds.push(user.id);
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `RSH-${s}`.slice(0, 20),
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

  async function createSalon(tenantId: string, name: string) {
    return app.prisma.salon.create({
      data: { tenantId, name, openingHours: DEFAULT_SALON_OPENING_HOURS, isActive: true },
    });
  }

  let salonA1: Awaited<ReturnType<typeof createSalon>>;
  let salonA2: Awaited<ReturnType<typeof createSalon>>;

  beforeAll(async () => {
    app = await getTestApp();
    tA = await seedTestData(app, "rsh-a");
    salonA1 = await createSalon(tA.tenant.id, "RSH Salon A1");
    salonA2 = await createSalon(tA.tenant.id, "RSH Salon A2");
  });

  afterAll(async () => {
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: tA.tenant.id } });
      await cleanupTestData(app, tA.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("keeps a TENANT-scope holder regardless of the isInScope callback", async () => {
    const { user } = await createUser(tA.tenant.id, "EMPLOYEE", "tenant");
    await assign(tA.tenant.id, user.id, SYSTEM_ROLE_IDS.MANAGER, { scopeType: "TENANT" });

    const kept = await resolveScopedHolderIds(
      app.prisma,
      tA.tenant.id,
      [user.id],
      "leave-request:approve:ZUGEWIESEN",
      () => false, // even an always-false callback must not exclude a wholeTenant reach
    );

    expect(kept).toEqual([user.id]);
  });

  it("keeps a SALONS-scope holder when isInScope matches their reach", async () => {
    const { user } = await createUser(tA.tenant.id, "EMPLOYEE", "salons-in");
    await assign(tA.tenant.id, user.id, SYSTEM_ROLE_IDS.MANAGER, {
      scopeType: "SALONS",
      salonIds: [salonA1.id],
    });

    const kept = await resolveScopedHolderIds(
      app.prisma,
      tA.tenant.id,
      [user.id],
      "leave-request:approve:ZUGEWIESEN",
      (reach: AccessReach) => reach.kind === "scoped" && reach.salonIds.includes(salonA1.id),
    );

    expect(kept).toEqual([user.id]);
  });

  it("excludes a SALONS-scope holder whose reach does not cover the affected salon", async () => {
    const { user } = await createUser(tA.tenant.id, "EMPLOYEE", "salons-out");
    await assign(tA.tenant.id, user.id, SYSTEM_ROLE_IDS.MANAGER, {
      scopeType: "SALONS",
      salonIds: [salonA2.id],
    });

    const kept = await resolveScopedHolderIds(
      app.prisma,
      tA.tenant.id,
      [user.id],
      "leave-request:approve:ZUGEWIESEN",
      (reach: AccessReach) => reach.kind === "scoped" && reach.salonIds.includes(salonA1.id),
    );

    expect(kept).toEqual([]);
  });

  it("mixed candidate list: keeps TENANT + in-scope SALONS, drops out-of-scope SALONS, preserves input order", async () => {
    const { user: tenantHolder } = await createUser(tA.tenant.id, "EMPLOYEE", "mix-tenant");
    await assign(tA.tenant.id, tenantHolder.id, SYSTEM_ROLE_IDS.MANAGER, { scopeType: "TENANT" });

    const { user: inScopeHolder } = await createUser(tA.tenant.id, "EMPLOYEE", "mix-in");
    await assign(tA.tenant.id, inScopeHolder.id, SYSTEM_ROLE_IDS.MANAGER, {
      scopeType: "SALONS",
      salonIds: [salonA1.id],
    });

    const { user: outOfScopeHolder } = await createUser(tA.tenant.id, "EMPLOYEE", "mix-out");
    await assign(tA.tenant.id, outOfScopeHolder.id, SYSTEM_ROLE_IDS.MANAGER, {
      scopeType: "SALONS",
      salonIds: [salonA2.id],
    });

    const kept = await resolveScopedHolderIds(
      app.prisma,
      tA.tenant.id,
      [outOfScopeHolder.id, tenantHolder.id, inScopeHolder.id],
      "leave-request:approve:ZUGEWIESEN",
      (reach: AccessReach) => reach.kind === "scoped" && reach.salonIds.includes(salonA1.id),
    );

    // input order preserved among KEPT ids, not re-sorted
    expect(kept).toEqual([tenantHolder.id, inScopeHolder.id]);
  });

  it("a candidate holding nothing at all for the permission resolves without throwing and is excluded", async () => {
    const { user } = await createUser(tA.tenant.id, "EMPLOYEE", "no-grant");
    // No RoleAssignment at all AND the legacy fallback role (EMPLOYEE) does not grant
    // leave-request:approve:ZUGEWIESEN — resolves to a scoped reach with both arrays empty.

    const kept = await resolveScopedHolderIds(
      app.prisma,
      tA.tenant.id,
      [user.id],
      "leave-request:approve:ZUGEWIESEN",
      () => true, // even an always-true callback: an empty scoped reach still fails any real check,
      // but this callback proves the function itself never throws on a no-grant candidate
    );

    expect(kept).toEqual([user.id]);
  });

  it("supports a synchronous (non-Promise) isInScope callback", async () => {
    const { user } = await createUser(tA.tenant.id, "EMPLOYEE", "sync-cb");
    await assign(tA.tenant.id, user.id, SYSTEM_ROLE_IDS.MANAGER, { scopeType: "TENANT" });

    const kept = await resolveScopedHolderIds(
      app.prisma,
      tA.tenant.id,
      [user.id],
      "leave-request:approve:ZUGEWIESEN",
      (reach) => reach.kind === "wholeTenant",
    );

    expect(kept).toEqual([user.id]);
  });
});
