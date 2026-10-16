/**
 * Phase 378 (Issue #378) — proves `POST /auth/login`'s `user.permissions` reflects the caller's
 * REAL effective permissions even when the compat `role` cannot: a Salon/Personen-scope role
 * assignment (Salonmanager, Ausbilder templates, #76) contributes nothing to `role` (it stays
 * "EMPLOYEE", #357/D-05 of #91b), which is exactly the gap the web-side fix (#378) needs closed.
 *
 * Uses the REAL `SYSTEM_ROLE_IDS.SALON_MANAGER` / `SYSTEM_ROLE_IDS.TRAINER` templates, not an
 * ad-hoc `AccessRole` — the point is proving the shipped bundle round-trips through login, same
 * anti-pattern note as `system-role-template-salonmanager.test.ts`.
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";

const PASSWORD = "test1234";

describe("Issue #378 — POST /auth/login exposes effective permissions", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createScopedUser(
    label: string,
    accessRoleId: string,
    scope: { scopeType: "SALONS" | "PERSONS"; salonIds?: string[]; employeeIds?: string[] },
  ) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "LoginPermissionsTest",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        accessRoleId,
        scopeType: scope.scopeType,
        salonIds: scope.salonIds ?? [],
        employeeIds: scope.employeeIds ?? [],
      },
    });
    return { user, employee };
  }

  async function login(email: string): Promise<{ permissions: string[] }> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { user: { permissions: string[] } };
    // Issue #539 (D-05): the body carries no role; the permission list is the only access information.
    expect(Object.keys(body.user)).not.toContain("role");
    return body.user;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "lep");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "LEP Salon A" });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("a Salonmanager (SALONS-scope, no tenant-wide assignment) gets approve/plan permissions ", async () => {
    const salonManager = await createScopedUser("lep-salonmgr", SYSTEM_ROLE_IDS.SALON_MANAGER, {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });

    const { permissions } = await login(salonManager.user.email);

    // The exact gap #378 reports: a Salon-scope assignment is visible in the permission list.
    // Salonmanager template (docs/permissions.md) — approves leave and Zeitnachtrag, plans shifts,
    // reads team overview and team time entries. This is what the web needs to show the Team-Bereich.
    expect(permissions).toContain("leave-request:approve:ZUGEWIESEN");
    expect(permissions).toContain("retro-request:approve:ZUGEWIESEN");
    expect(permissions).toContain("time-entry:read:ZUGEWIESEN");
    expect(permissions).toContain("leave-request:read:ZUGEWIESEN");
    expect(permissions).toContain("shift:plan:ZUGEWIESEN");
    expect(permissions).toContain("team-overview:read:ZUGEWIESEN");

    // Explicitly NOT part of the Salonmanager template (docs/permissions.md:444) — proves the
    // list is the real template, not "everything".
    expect(permissions).not.toContain("overtime:read:ZUGEWIESEN");
    expect(permissions).not.toContain("report:read:ZUGEWIESEN");
  });

  it("an Ausbilder (PERSONS-scope) gets read-only permissions, no approve/plan, ", async () => {
    const azubiSuffix = uniqueSuffix("lep-azubi");
    const azubiUser = await app.prisma.user.create({
      data: {
        email: `${azubiSuffix}@test.de`,
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const azubi = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: azubiUser.id,
        employeeNumber: azubiSuffix.toUpperCase().slice(0, 20),
        firstName: "Azubi",
        lastName: "LoginPermissionsTest",
        hireDate: new Date("2024-01-01"),
      },
    });
    const trainer = await createScopedUser("lep-ausbilder", SYSTEM_ROLE_IDS.TRAINER, {
      scopeType: "PERSONS",
      employeeIds: [azubi.id],
    });

    const { permissions } = await login(trainer.user.email);

    // Ausbilder template (docs/permissions.md:446) — read only.
    expect(permissions).toContain("time-entry:read:ZUGEWIESEN");
    expect(permissions).toContain("leave-request:read:ZUGEWIESEN");
    expect(permissions).toContain("shift:read:ZUGEWIESEN");

    // No approve, no create, no plan — the exact AK-378-2 distinction ("keine Genehmigungsaktionen").
    expect(permissions).not.toContain("leave-request:approve:ZUGEWIESEN");
    expect(permissions).not.toContain("leave-request:create:ZUGEWIESEN");
    expect(permissions).not.toContain("retro-request:approve:ZUGEWIESEN");
    expect(permissions).not.toContain("shift:plan:ZUGEWIESEN");
    expect(permissions).not.toContain("team-overview:read:ZUGEWIESEN");
  });

  it("a plain EMPLOYEE (stored Mitarbeiter assignment) gets only EIGENE permissions", async () => {
    const { permissions } = await login(data.empUser.email);

    expect(permissions).toContain("time-entry:read:EIGENE");
    expect(permissions).not.toContain("time-entry:read:ZUGEWIESEN");
    expect(permissions).not.toContain("leave-request:approve:ZUGEWIESEN");
  });

  it("ADMIN (stored Admin assignment) gets the full ZUGEWIESEN set including report:read", async () => {
    const { permissions } = await login(data.adminUser.email);

    expect(permissions).toContain("report:read:ZUGEWIESEN");
    expect(permissions).toContain("team-overview:read:ZUGEWIESEN");
    expect(permissions).toContain("overtime:read:ZUGEWIESEN");
  });
});
