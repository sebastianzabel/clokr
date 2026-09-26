/**
 * Phase 74b (Issue #74) — function-level resolution of effective rights.
 *
 * "May user U apply permission P to a target described by employee and/or salon?" — proven at
 * function level only (enforcement wiring is #91). Task 1 covers the TENANT-scope tracer slice
 * (t1-t7); Task 2 adds SALONS/PERSONS scope, EIGENE and MANDANT-relation coverage (AK-74-6..11)
 * plus a DB-free unit matrix, and imports `userMayApply`/`decideUserMayApply`/
 * `normalizeRoleAssignmentScope` from the Unterbau's public surface (`..`) — the export-path
 * proof, same as 73b's `roleGrants` import.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { roleNameKey, normalizeRolePermissions } from "../access-role";
import {
  userMayApply,
  decideUserMayApply,
  normalizeRoleAssignmentScope,
  DEFAULT_SALON_OPENING_HOURS,
  deactivateSalon,
  activateSalon,
} from "..";
import type { UserMayApplyFacts } from "../role-assignment";
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
  let r2Id: string;
  let reId: string;
  let rmId: string;
  let holder: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let tenantAOther: Awaited<ReturnType<typeof createUserWithEmployee>>; // "Kollege" — non-listed
  let ausbilder: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let azubi1: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let azubi2: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let azubi3: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let mehrsalon: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let mandantenweit: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let salonMandant: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let personenMandant: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let salonC: { id: string };
  let salonD: { id: string }; // created inactive, never activated in these tests

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

    const r2Name = `R2 ${Date.now().toString(36)}`;
    const r2 = await app.prisma.accessRole.create({
      data: {
        tenantId: tenantA.tenant.id,
        name: r2Name,
        nameKey: roleNameKey(r2Name),
        permissions: normalizeRolePermissions(["leave-request:read:ZUGEWIESEN"]),
      },
    });
    r2Id = r2.id;

    const reName = `RE ${Date.now().toString(36)}`;
    const re = await app.prisma.accessRole.create({
      data: {
        tenantId: tenantA.tenant.id,
        name: reName,
        nameKey: roleNameKey(reName),
        permissions: normalizeRolePermissions(["time-entry:read:EIGENE"]),
      },
    });
    reId = re.id;

    const rmName = `RM ${Date.now().toString(36)}`;
    const rm = await app.prisma.accessRole.create({
      data: {
        tenantId: tenantA.tenant.id,
        name: rmName,
        nameKey: roleNameKey(rmName),
        permissions: normalizeRolePermissions(["tenant-settings:read:ZUGEWIESEN"]),
      },
    });
    rmId = rm.id;

    holder = await createUserWithEmployee(app, tenantA.tenant.id, "Salonleitung");
    tenantAOther = await createUserWithEmployee(app, tenantA.tenant.id, "Kollege");
    ausbilder = await createUserWithEmployee(app, tenantA.tenant.id, "Ausbilder");
    azubi1 = await createUserWithEmployee(app, tenantA.tenant.id, "Azubi1");
    azubi2 = await createUserWithEmployee(app, tenantA.tenant.id, "Azubi2");
    azubi3 = await createUserWithEmployee(app, tenantA.tenant.id, "Azubi3");
    mehrsalon = await createUserWithEmployee(app, tenantA.tenant.id, "Mehrsalon");
    mandantenweit = await createUserWithEmployee(app, tenantA.tenant.id, "Mandantenweit");
    salonMandant = await createUserWithEmployee(app, tenantA.tenant.id, "SalonMandant");
    personenMandant = await createUserWithEmployee(app, tenantA.tenant.id, "PersonenMandant");

    salonA = await app.prisma.salon.create({
      data: {
        tenantId: tenantA.tenant.id,
        federalState: "NIEDERSACHSEN",
        name: "Salon A",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
    salonB = await app.prisma.salon.create({
      data: {
        tenantId: tenantA.tenant.id,
        federalState: "NIEDERSACHSEN",
        name: "Salon B",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
    salonC = await app.prisma.salon.create({
      data: {
        tenantId: tenantA.tenant.id,
        federalState: "NIEDERSACHSEN",
        name: "Salon C",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
    salonD = await app.prisma.salon.create({
      data: {
        tenantId: tenantA.tenant.id,
        federalState: "NIEDERSACHSEN",
        name: "Salon D (inaktiv erstellt)",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: false,
        deactivatedAt: new Date(),
      },
    });

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

    // AK-74-7/AK-74-8: trainer with a PERSONS scope on three trainees across (unlisted) salons.
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        userId: ausbilder.user.id,
        accessRoleId: r1Id,
        scopeType: "PERSONS",
        salonIds: [],
        employeeIds: [azubi1.employee.id, azubi2.employee.id, azubi3.employee.id],
      },
    });

    // AK-74-6: one user, two roles, two disjoint salon scopes.
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        userId: mehrsalon.user.id,
        accessRoleId: r1Id,
        scopeType: "SALONS",
        salonIds: [salonA.id],
        employeeIds: [],
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        userId: mehrsalon.user.id,
        accessRoleId: r2Id,
        scopeType: "SALONS",
        salonIds: [salonB.id],
        employeeIds: [],
      },
    });

    // AK-74-10: EIGENE under a TENANT scope.
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        userId: mandantenweit.user.id,
        accessRoleId: reId,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    // AK-74-11 positive control: a MANDANT-relation permission from a TENANT scope.
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        userId: mandantenweit.user.id,
        accessRoleId: rmId,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });

    // AK-74-9: SALONS scope on two active salons plus one inactive-created salon.
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        userId: salonMandant.user.id,
        accessRoleId: r1Id,
        scopeType: "SALONS",
        salonIds: [salonA.id, salonC.id, salonD.id],
        employeeIds: [],
      },
    });
    // AK-74-11: MANDANT-relation permission from a SALONS scope -> denied.
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        userId: salonMandant.user.id,
        accessRoleId: rmId,
        scopeType: "SALONS",
        salonIds: [salonA.id],
        employeeIds: [],
      },
    });

    // AK-74-11: MANDANT-relation permission from a PERSONS scope -> denied.
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        userId: personenMandant.user.id,
        accessRoleId: rmId,
        scopeType: "PERSONS",
        salonIds: [],
        employeeIds: [azubi1.employee.id],
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

  describe("AK-74-6: two salons, two roles — no cross-salon leakage", () => {
    it("grants R1's permission in salon A and R2's in salon B, never the other way round", async () => {
      expect(
        await userMayApply(
          app.prisma,
          tenantA.tenant.id,
          mehrsalon.user.id,
          "time-entry:read:ZUGEWIESEN",
          { salonId: salonA.id },
        ),
      ).toBe(true);
      expect(
        await userMayApply(
          app.prisma,
          tenantA.tenant.id,
          mehrsalon.user.id,
          "leave-request:read:ZUGEWIESEN",
          { salonId: salonB.id },
        ),
      ).toBe(true);
      expect(
        await userMayApply(
          app.prisma,
          tenantA.tenant.id,
          mehrsalon.user.id,
          "time-entry:read:ZUGEWIESEN",
          { salonId: salonB.id },
        ),
      ).toBe(false);
      expect(
        await userMayApply(
          app.prisma,
          tenantA.tenant.id,
          mehrsalon.user.id,
          "leave-request:read:ZUGEWIESEN",
          { salonId: salonA.id },
        ),
      ).toBe(false);
    });

    it("a SALONS grant with no salonId in the target -> false (no TENANT/PERSONS grant to fall back on)", async () => {
      expect(
        await userMayApply(
          app.prisma,
          tenantA.tenant.id,
          mehrsalon.user.id,
          "time-entry:read:ZUGEWIESEN",
          { employeeId: azubi1.employee.id },
        ),
      ).toBe(false);
      expect(
        await userMayApply(
          app.prisma,
          tenantA.tenant.id,
          mehrsalon.user.id,
          "time-entry:read:ZUGEWIESEN",
          {},
        ),
      ).toBe(false);
    });
  });

  describe("AK-74-7/AK-74-8: PERSONS scope crosses salons but not people", () => {
    it("(AK-74-7) allowed for a listed trainee whose target salon the trainer has no SALONS scope for", async () => {
      expect(
        await userMayApply(
          app.prisma,
          tenantA.tenant.id,
          ausbilder.user.id,
          "time-entry:read:ZUGEWIESEN",
          { employeeId: azubi2.employee.id, salonId: salonB.id },
        ),
      ).toBe(true);
    });

    it("(AK-74-8) denied for a non-listed colleague in the same salon as a listed trainee", async () => {
      expect(
        await userMayApply(
          app.prisma,
          tenantA.tenant.id,
          ausbilder.user.id,
          "time-entry:read:ZUGEWIESEN",
          { employeeId: tenantAOther.employee.id, salonId: salonA.id },
        ),
      ).toBe(false);
    });

    it("an empty target -> false (a PERSONS grant needs a named employee)", async () => {
      expect(
        await userMayApply(
          app.prisma,
          tenantA.tenant.id,
          ausbilder.user.id,
          "time-entry:read:ZUGEWIESEN",
          {},
        ),
      ).toBe(false);
    });

    it("a listed but anonymized trainee -> false, although still listed", async () => {
      await app.prisma.employee.update({
        where: { id: azubi3.employee.id },
        data: { firstName: "Gelöscht", lastName: "GELÖSCHT-74B" },
      });
      expect(
        await userMayApply(
          app.prisma,
          tenantA.tenant.id,
          ausbilder.user.id,
          "time-entry:read:ZUGEWIESEN",
          { employeeId: azubi3.employee.id },
        ),
      ).toBe(false);
    });
  });

  describe("AK-74-9: deactivated salon denies live, reactivation restores", () => {
    it("both scoped salons allow before any deactivation", async () => {
      expect(
        await userMayApply(
          app.prisma,
          tenantA.tenant.id,
          salonMandant.user.id,
          "time-entry:read:ZUGEWIESEN",
          { salonId: salonA.id },
        ),
      ).toBe(true);
      expect(
        await userMayApply(
          app.prisma,
          tenantA.tenant.id,
          salonMandant.user.id,
          "time-entry:read:ZUGEWIESEN",
          { salonId: salonC.id },
        ),
      ).toBe(true);
    });

    it("deactivating salon A denies A but salon C keeps working; reactivating A restores it", async () => {
      await app.prisma.$transaction((tx) => deactivateSalon(tx, tenantA.tenant.id, salonA.id));
      try {
        expect(
          await userMayApply(
            app.prisma,
            tenantA.tenant.id,
            salonMandant.user.id,
            "time-entry:read:ZUGEWIESEN",
            { salonId: salonA.id },
          ),
        ).toBe(false);
        expect(
          await userMayApply(
            app.prisma,
            tenantA.tenant.id,
            salonMandant.user.id,
            "time-entry:read:ZUGEWIESEN",
            { salonId: salonC.id },
          ),
        ).toBe(true);
      } finally {
        await app.prisma.$transaction((tx) => activateSalon(tx, tenantA.tenant.id, salonA.id));
      }
      expect(
        await userMayApply(
          app.prisma,
          tenantA.tenant.id,
          salonMandant.user.id,
          "time-entry:read:ZUGEWIESEN",
          { salonId: salonA.id },
        ),
      ).toBe(true);
    });

    it("a listed but never-activated salon -> false", async () => {
      expect(
        await userMayApply(
          app.prisma,
          tenantA.tenant.id,
          salonMandant.user.id,
          "time-entry:read:ZUGEWIESEN",
          { salonId: salonD.id },
        ),
      ).toBe(false);
    });
  });

  describe("AK-74-10: EIGENE takes effect only for the user's own employee, even under TENANT scope", () => {
    it("own employee -> true; another employee -> false; empty target -> false", async () => {
      expect(
        await userMayApply(
          app.prisma,
          tenantA.tenant.id,
          mandantenweit.user.id,
          "time-entry:read:EIGENE",
          { employeeId: mandantenweit.employee.id },
        ),
      ).toBe(true);
      expect(
        await userMayApply(
          app.prisma,
          tenantA.tenant.id,
          mandantenweit.user.id,
          "time-entry:read:EIGENE",
          { employeeId: azubi1.employee.id },
        ),
      ).toBe(false);
      expect(
        await userMayApply(
          app.prisma,
          tenantA.tenant.id,
          mandantenweit.user.id,
          "time-entry:read:EIGENE",
          {},
        ),
      ).toBe(false);
    });
  });

  describe("AK-74-11: a MANDANT-relation permission takes effect only from a TENANT scope", () => {
    it("denied from a SALONS scope", async () => {
      expect(
        await userMayApply(
          app.prisma,
          tenantA.tenant.id,
          salonMandant.user.id,
          "tenant-settings:read:ZUGEWIESEN",
          { salonId: salonA.id },
        ),
      ).toBe(false);
    });

    it("denied from a PERSONS scope", async () => {
      expect(
        await userMayApply(
          app.prisma,
          tenantA.tenant.id,
          personenMandant.user.id,
          "tenant-settings:read:ZUGEWIESEN",
          { employeeId: azubi1.employee.id },
        ),
      ).toBe(false);
    });

    it("allowed from a TENANT scope (positive control)", async () => {
      expect(
        await userMayApply(
          app.prisma,
          tenantA.tenant.id,
          mandantenweit.user.id,
          "tenant-settings:read:ZUGEWIESEN",
          {},
        ),
      ).toBe(true);
    });
  });
});

describe("decideUserMayApply — pure matrix (DB-free)", () => {
  const salonScope = (salonIds: readonly string[]) => ({
    scopeType: "SALONS" as const,
    salonIds: [...salonIds],
    employeeIds: [],
  });
  const personsScope = (employeeIds: readonly string[]) => ({
    scopeType: "PERSONS" as const,
    salonIds: [],
    employeeIds: [...employeeIds],
  });
  const tenantScope = () => ({ scopeType: "TENANT" as const, salonIds: [], employeeIds: [] });

  const baseFacts: UserMayApplyFacts = {
    reach: "ZUGEWIESEN",
    relation: "PERSON",
    ownEmployeeId: null,
    grantingScopes: [],
    target: {},
    targetEmployeeValid: null,
    targetSalon: null,
  };

  it("no granting scope at all -> false", () => {
    expect(decideUserMayApply({ ...baseFacts, grantingScopes: [] })).toBe(false);
  });

  it("EIGENE: matching own valid employee -> true", () => {
    expect(
      decideUserMayApply({
        ...baseFacts,
        reach: "EIGENE",
        grantingScopes: [tenantScope()],
        ownEmployeeId: "emp-1",
        target: { employeeId: "emp-1" },
        targetEmployeeValid: true,
      }),
    ).toBe(true);
  });

  it("EIGENE: no employeeId in target -> false", () => {
    expect(
      decideUserMayApply({
        ...baseFacts,
        reach: "EIGENE",
        grantingScopes: [tenantScope()],
        ownEmployeeId: "emp-1",
        target: {},
        targetEmployeeValid: null,
      }),
    ).toBe(false);
  });

  it("EIGENE: ownEmployeeId is null -> false", () => {
    expect(
      decideUserMayApply({
        ...baseFacts,
        reach: "EIGENE",
        grantingScopes: [tenantScope()],
        ownEmployeeId: null,
        target: { employeeId: "emp-1" },
        targetEmployeeValid: true,
      }),
    ).toBe(false);
  });

  it("EIGENE: mismatched employeeId -> false", () => {
    expect(
      decideUserMayApply({
        ...baseFacts,
        reach: "EIGENE",
        grantingScopes: [tenantScope()],
        ownEmployeeId: "emp-1",
        target: { employeeId: "emp-2" },
        targetEmployeeValid: true,
      }),
    ).toBe(false);
  });

  it("EIGENE: matching id but targetEmployeeValid false -> false", () => {
    expect(
      decideUserMayApply({
        ...baseFacts,
        reach: "EIGENE",
        grantingScopes: [tenantScope()],
        ownEmployeeId: "emp-1",
        target: { employeeId: "emp-1" },
        targetEmployeeValid: false,
      }),
    ).toBe(false);
  });

  it("ZUGEWIESEN: targetEmployeeValid false -> false, even with a TENANT grant", () => {
    expect(
      decideUserMayApply({
        ...baseFacts,
        grantingScopes: [tenantScope()],
        target: { employeeId: "emp-1" },
        targetEmployeeValid: false,
      }),
    ).toBe(false);
  });

  it("ZUGEWIESEN: targetSalon.inTenant false -> false, even with a TENANT grant", () => {
    expect(
      decideUserMayApply({
        ...baseFacts,
        grantingScopes: [tenantScope()],
        target: { salonId: "salon-foreign" },
        targetSalon: { inTenant: false, isActive: true },
      }),
    ).toBe(false);
  });

  it("ZUGEWIESEN: a TENANT grant -> true for either relation", () => {
    expect(decideUserMayApply({ ...baseFacts, grantingScopes: [tenantScope()] })).toBe(true);
    expect(
      decideUserMayApply({ ...baseFacts, relation: "MANDANT", grantingScopes: [tenantScope()] }),
    ).toBe(true);
  });

  it("ZUGEWIESEN, MANDANT relation, no TENANT grant -> false even with a matching SALONS/PERSONS grant", () => {
    expect(
      decideUserMayApply({
        ...baseFacts,
        relation: "MANDANT",
        grantingScopes: [salonScope(["salon-a"])],
        target: { salonId: "salon-a" },
        targetSalon: { inTenant: true, isActive: true },
      }),
    ).toBe(false);
    expect(
      decideUserMayApply({
        ...baseFacts,
        relation: "MANDANT",
        grantingScopes: [personsScope(["emp-1"])],
        target: { employeeId: "emp-1" },
        targetEmployeeValid: true,
      }),
    ).toBe(false);
  });

  it("ZUGEWIESEN, PERSON relation, SALONS grant matching + active + in tenant -> true", () => {
    expect(
      decideUserMayApply({
        ...baseFacts,
        grantingScopes: [salonScope(["salon-a"])],
        target: { salonId: "salon-a" },
        targetSalon: { inTenant: true, isActive: true },
      }),
    ).toBe(true);
  });

  it("ZUGEWIESEN, PERSON relation, SALONS grant matching but salon inactive -> false", () => {
    expect(
      decideUserMayApply({
        ...baseFacts,
        grantingScopes: [salonScope(["salon-a"])],
        target: { salonId: "salon-a" },
        targetSalon: { inTenant: true, isActive: false },
      }),
    ).toBe(false);
  });

  it("ZUGEWIESEN, PERSON relation, SALONS grant but no salonId in target -> false", () => {
    expect(
      decideUserMayApply({
        ...baseFacts,
        grantingScopes: [salonScope(["salon-a"])],
        target: {},
        targetSalon: null,
      }),
    ).toBe(false);
  });

  it("ZUGEWIESEN, PERSON relation, PERSONS grant matching + valid -> true", () => {
    expect(
      decideUserMayApply({
        ...baseFacts,
        grantingScopes: [personsScope(["emp-1"])],
        target: { employeeId: "emp-1" },
        targetEmployeeValid: true,
      }),
    ).toBe(true);
  });

  it("ZUGEWIESEN, PERSON relation, PERSONS grant but employeeId not listed -> false", () => {
    expect(
      decideUserMayApply({
        ...baseFacts,
        grantingScopes: [personsScope(["emp-1"])],
        target: { employeeId: "emp-2" },
        targetEmployeeValid: true,
      }),
    ).toBe(false);
  });

  it("ZUGEWIESEN, PERSON relation, no matching scope at all -> false", () => {
    expect(
      decideUserMayApply({
        ...baseFacts,
        grantingScopes: [salonScope(["salon-a"]), personsScope(["emp-1"])],
        target: { employeeId: "emp-2", salonId: "salon-b" },
        targetEmployeeValid: true,
        targetSalon: { inTenant: true, isActive: true },
      }),
    ).toBe(false);
  });
});

describe("normalizeRoleAssignmentScope", () => {
  it("TENANT -> both arrays empty", () => {
    expect(normalizeRoleAssignmentScope({ type: "TENANT" })).toEqual({
      scopeType: "TENANT",
      salonIds: [],
      employeeIds: [],
    });
  });

  it("SALONS -> de-duplicated, ascending-sorted salonIds, empty employeeIds", () => {
    expect(
      normalizeRoleAssignmentScope({
        type: "SALONS",
        salonIds: ["salon-c", "salon-a", "salon-a", "salon-b"],
      }),
    ).toEqual({
      scopeType: "SALONS",
      salonIds: ["salon-a", "salon-b", "salon-c"],
      employeeIds: [],
    });
  });

  it("PERSONS -> de-duplicated, ascending-sorted employeeIds, empty salonIds", () => {
    expect(
      normalizeRoleAssignmentScope({
        type: "PERSONS",
        employeeIds: ["emp-b", "emp-a", "emp-b"],
      }),
    ).toEqual({ scopeType: "PERSONS", salonIds: [], employeeIds: ["emp-a", "emp-b"] });
  });

  it("SALONS with an empty list throws RangeError", () => {
    expect(() => normalizeRoleAssignmentScope({ type: "SALONS", salonIds: [] })).toThrow(
      RangeError,
    );
  });

  it("PERSONS with an empty list throws RangeError", () => {
    expect(() => normalizeRoleAssignmentScope({ type: "PERSONS", employeeIds: [] })).toThrow(
      RangeError,
    );
  });
});
