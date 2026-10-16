/**
 * Issue #539 (Release A), D-12 — the selection rule of `seed-int-admin.ts`.
 *
 * Since Release A only stored role assignments grant permissions, so the int admin restore picks
 * its user by a stored TENANT assignment on the Admin system role and never by the compat column
 * `User.role`. A user whose column says ADMIN but who holds no stored assignment would be refused
 * at login (NO_ROLE_ASSIGNED), so handing it a fresh password would hand out a login that does
 * not work.
 *
 * The rule lives in `restorable-admin.ts` (no top-level code, safe to import); the script itself
 * runs `main()` at import and is only read as text here.
 *
 * Fixtures: synthetic `@example.invalid` addresses only, no person names.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  grantSystemRole,
} from "../../src/__tests__/setup";
import { SYSTEM_ROLE_IDS } from "../../src/contexts/platform/system-roles";
import { restorableAdminWhere, pinnedUserRefusal } from "../restorable-admin";

describe("restorable-admin (Issue #539, D-12)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let assignedAdminId: string;
  let columnOnlyAdminId: string;
  let assignedManagerId: string;

  async function person(label: string, role: "ADMIN" | "MANAGER") {
    const s = randomBytes(4).toString("hex");
    const user = await app.prisma.user.create({
      data: {
        email: `ra539-${label}-${s}@example.invalid`,
        passwordHash: "x",
        role,
        isActive: true,
      },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: seed.tenant.id,
        userId: user.id,
        employeeNumber: `RA-${s}`,
        firstName: label,
        lastName: "Restore",
        hireDate: new Date("2024-01-01"),
      },
    });
    return user.id;
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "539-restorable");
    // The seed admin holds a stored Admin assignment already; the three below are the cases.
    assignedAdminId = await person("assigned", "ADMIN");
    await grantSystemRole(app.prisma, {
      tenantId: seed.tenant.id,
      userId: assignedAdminId,
      role: "ADMIN",
    });
    columnOnlyAdminId = await person("column-only", "ADMIN");
    assignedManagerId = await person("manager", "MANAGER");
    await grantSystemRole(app.prisma, {
      tenantId: seed.tenant.id,
      userId: assignedManagerId,
      role: "MANAGER",
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (error) {
      console.error("restorable-admin-539 cleanup failed", error);
    }
    await closeTestApp();
  });

  it("restorableAdminWhere finds a user holding a TENANT Admin assignment and not an ADMIN-column user without one", async () => {
    const found = await app.prisma.user.findMany({
      where: { AND: [restorableAdminWhere(), { employee: { tenantId: seed.tenant.id } }] },
      select: { id: true },
    });
    const ids = found.map((u) => u.id);
    expect(ids).toContain(assignedAdminId);
    expect(ids).toContain(seed.adminUser.id);
    // The column says ADMIN, no stored assignment: never picked.
    expect(ids).not.toContain(columnOnlyAdminId);
    // A stored assignment on another system role is not an Admin assignment.
    expect(ids).not.toContain(assignedManagerId);
    // Anti-vacuity: the unfiltered tenant has all of them.
    const all = await app.prisma.user.count({ where: { employee: { tenantId: seed.tenant.id } } });
    expect(all).toBeGreaterThanOrEqual(found.length + 2);
  });

  it("restorableAdminWhere skips an inactive user and a user without an Employee", async () => {
    const inactive = await person("inactive", "ADMIN");
    await grantSystemRole(app.prisma, {
      tenantId: seed.tenant.id,
      userId: inactive,
      role: "ADMIN",
    });
    await app.prisma.user.update({ where: { id: inactive }, data: { isActive: false } });
    const found = await app.prisma.user.findMany({
      where: { AND: [restorableAdminWhere(), { employee: { tenantId: seed.tenant.id } }] },
      select: { id: true },
    });
    expect(found.map((u) => u.id)).not.toContain(inactive);

    // No Employee row: not found regardless of the stored assignment (nothing to filter by tenant
    // here, so the lookup is by id).
    const bare = await app.prisma.user.create({
      data: {
        email: `ra539-bare-${randomBytes(4).toString("hex")}@example.invalid`,
        passwordHash: "x",
        role: "ADMIN",
        isActive: true,
      },
    });
    try {
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: seed.tenant.id,
          userId: bare.id,
          accessRoleId: SYSTEM_ROLE_IDS.ADMIN,
          scopeType: "TENANT",
          salonIds: [],
          employeeIds: [],
        },
      });
      const hit = await app.prisma.user.findFirst({
        where: { AND: [restorableAdminWhere(), { id: bare.id }] },
      });
      expect(hit).toBeNull();
    } finally {
      await app.prisma.user.delete({ where: { id: bare.id } });
    }
  });

  describe("pinnedUserRefusal", () => {
    const adminRow = { accessRoleId: SYSTEM_ROLE_IDS.ADMIN, scopeType: "TENANT" as const };
    const managerRow = { accessRoleId: SYSTEM_ROLE_IDS.MANAGER, scopeType: "TENANT" as const };

    it("refuses a user without an Employee", () => {
      expect(
        pinnedUserRefusal({
          email: "a@example.invalid",
          hasEmployee: false,
          assignments: [adminRow],
        }),
      ).toMatch(/no Employee/);
    });

    it("refuses a user without any stored assignment, naming NO_ROLE_ASSIGNED", () => {
      expect(
        pinnedUserRefusal({ email: "a@example.invalid", hasEmployee: true, assignments: [] }),
      ).toMatch(/NO_ROLE_ASSIGNED/);
    });

    it("refuses a user whose stored assignments hold no Admin system role", () => {
      expect(
        pinnedUserRefusal({
          email: "a@example.invalid",
          hasEmployee: true,
          assignments: [managerRow],
        }),
      ).toMatch(/Admin/);
    });

    it("accepts an assigned admin with an Employee", () => {
      expect(
        pinnedUserRefusal({
          email: "a@example.invalid",
          hasEmployee: true,
          assignments: [managerRow, adminRow],
        }),
      ).toBeNull();
    });
  });

  it("seed-int-admin.ts reads no role column to decide: no `role:` key in a where and no `user.role` read", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../seed-int-admin.ts", import.meta.url)),
      "utf8",
    );
    expect(source.length).toBeGreaterThan(1000); // anti-vacuity: a real file was read
    expect(source).toContain("restorableAdminWhere()");
    expect(source).toContain("pinnedUserRefusal(");
    expect(source).not.toMatch(/\brole:\s*"ADMIN"/);
    expect(source).not.toMatch(/\buser\.role\b/);
  });
});
