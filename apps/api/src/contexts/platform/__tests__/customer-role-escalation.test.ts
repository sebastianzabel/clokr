/**
 * Issue #354 (pre-merge security review of #75) — customer-role escalation guards.
 *
 * #75 made customer roles (`AccessRole`) effective. A security review found that this is neutral
 * for the three legacy roles (only the Admin system role ever holds the permissions below), but
 * opens four escalation paths for a tenant's own customer roles:
 *
 * - Fix 1 (HIGH): `employee:create` (`POST /employees`) and `employee:import`
 *   (`POST /imports/employees`) let a holder hand out ANY system role, including Admin, by
 *   setting `role` in the request/row. Both now additionally require `role-assignment:manage`
 *   for any role other than the schema default EMPLOYEE.
 * - Fix 2 (MEDIUM): (a) `api-key:manage` can mint an `admin`-scoped API key, which maps onto the
 *   full Admin system role (`request-permissions.ts`'s `resolveGrants`) — creating a key with
 *   that scope now additionally requires `role-assignment:manage`. (b) `role:manage` can edit a
 *   customer role the caller currently holds via its own assignment and add rights to it —
 *   `PATCH /roles/:id` on a self-held role now additionally requires `role-assignment:manage`.
 *
 * Every actor below is a bare user (no Employee, no legacy-role fallback: it holds exactly one
 * customer role via a TENANT-scope assignment) — never one of the neutrality matrix's actors, so
 * these cells are outside that matrix's territory and cannot change any of its recorded ones.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { roleNameKey, normalizeRolePermissions } from "../access-role";
import type { JwtPayload } from "../../../middleware/auth";

describe("Customer-role escalation guards (Issue #354, pre-merge review of #75)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  // `cleanupTestData` cascades from an Employee, not a bare User — every actor user (which has
  // none) and every accessRole this file creates is tracked here and torn down before it, since
  // `RoleAssignment.tenantId` is `onDelete: Restrict` and would otherwise block the tenant delete.
  const actorUserIds: string[] = [];
  const roleIds: string[] = [];

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "354-esc");
  });

  afterAll(async () => {
    try {
      // Deleting the User cascades its RoleAssignment rows (`onDelete: Cascade` on that
      // relation), which frees every accessRole below from the `onDelete: Restrict` FK.
      if (actorUserIds.length > 0) {
        await app.prisma.user.deleteMany({ where: { id: { in: actorUserIds } } });
      }
      if (roleIds.length > 0) {
        await app.prisma.accessRole.deleteMany({ where: { id: { in: roleIds } } });
      }
    } catch (err) {
      console.error("Actor/role cleanup failed:", err);
    }
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  /**
   * A bare user (no Employee) holding exactly `permissions` via one TENANT-scope assignment of a
   * fresh customer role — no legacy-role fallback, so the actor's only rights are the ones this
   * test grants it. Returns a ready `Authorization` header value.
   */
  async function actorWithPermissions(
    label: string,
    permissions: string[],
  ): Promise<{ userId: string; roleId: string; bearer: string }> {
    const s = `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const passwordHash = await bcrypt.hash("test1234", 10);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    actorUserIds.push(user.id);
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name: s,
        nameKey: roleNameKey(s),
        permissions: normalizeRolePermissions(permissions),
      },
    });
    roleIds.push(role.id);
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        accessRoleId: role.id,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    const payload: JwtPayload = { sub: user.id, role: "EMPLOYEE", tenantId: data.tenant.id };
    return { userId: user.id, roleId: role.id, bearer: `Bearer ${app.jwt.sign(payload)}` };
  }

  describe("Fix 1 (HIGH): employee:create / employee:import cannot hand out a role on their own", () => {
    it("(a) blocks POST /employees with role ADMIN for an actor holding only employee:create", async () => {
      const actor = await actorWithPermissions("create-only", ["employee:create:ZUGEWIESEN"]);
      const uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { authorization: actor.bearer },
        payload: {
          email: `esc-a-${uid}@test.de`,
          firstName: "Eskalation",
          lastName: "A",
          employeeNumber: `ESC-A-${uid}`,
          hireDate: "2026-01-01T00:00:00.000Z",
          role: "ADMIN",
          password: "test123456",
        },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
      const created = await app.prisma.user.findUnique({
        where: { email: `esc-a-${uid}@test.de` },
      });
      expect(created).toBeNull();
    });

    it("(b) the same actor may still create a default (EMPLOYEE) employee — the fix is targeted, not blanket", async () => {
      const actor = await actorWithPermissions("create-only-ok", ["employee:create:ZUGEWIESEN"]);
      const uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { authorization: actor.bearer },
        payload: {
          email: `esc-b-${uid}@test.de`,
          firstName: "Eskalation",
          lastName: "B",
          employeeNumber: `ESC-B-${uid}`,
          hireDate: "2026-01-01T00:00:00.000Z",
          password: "Test@1234567!",
        },
      });

      expect(res.statusCode, res.body.slice(0, 400)).toBe(201);
      const createdUser = await app.prisma.user.findUniqueOrThrow({
        where: { email: `esc-b-${uid}@test.de` },
      });
      expect(createdUser.role).toBe("EMPLOYEE");
    });

    it("(c) rejects only the CSV row asking for a non-EMPLOYEE role, for an actor holding only employee:import — the rest of the import still runs", async () => {
      const actor = await actorWithPermissions("import-only", ["employee:import:ZUGEWIESEN"]);
      const uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const csv =
        `email;vorname;nachname;nr;eintrittsdatum;Rolle\n` +
        `esc-c1-${uid}@test.de;Eskalation;C1;ESC-C1-${uid};01.01.2026;EMPLOYEE\n` +
        `esc-c2-${uid}@test.de;Eskalation;C2;ESC-C2-${uid};01.01.2026;ADMIN`;

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/imports/employees",
        headers: { authorization: actor.bearer },
        payload: { csv },
      });

      expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
      const body = JSON.parse(res.body) as {
        total: number;
        imported: number;
        errors: number;
        details: { row: number; status: string; email?: string; error?: string }[];
      };
      expect(body.total).toBe(2);
      expect(body.imported).toBe(1);
      expect(body.errors).toBe(1);
      expect(body.details[0]).toMatchObject({
        row: 1,
        status: "ok",
        email: `esc-c1-${uid}@test.de`,
      });
      expect(body.details[1].status).toBe("error");
      expect(body.details[1].error).toContain("role-assignment:manage");

      const rowOk = await app.prisma.user.findUnique({ where: { email: `esc-c1-${uid}@test.de` } });
      expect(rowOk).not.toBeNull();
      const rowRejected = await app.prisma.user.findUnique({
        where: { email: `esc-c2-${uid}@test.de` },
      });
      expect(rowRejected).toBeNull();
    });
  });

  describe("Fix 2 (MEDIUM, a): api-key:manage cannot mint an admin-scoped key on its own", () => {
    it("(a) blocks POST /api-keys with scope admin for an actor holding only api-key:manage", async () => {
      const actor = await actorWithPermissions("apikey-only", ["api-key:manage:ZUGEWIESEN"]);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/api-keys",
        headers: { authorization: actor.bearer },
        payload: { name: "Eskalationsschlüssel", scopes: ["admin"] },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
    });

    it("(b) the same actor may still mint a non-admin-scoped key — the fix is targeted, not blanket", async () => {
      const actor = await actorWithPermissions("apikey-only-ok", ["api-key:manage:ZUGEWIESEN"]);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/api-keys",
        headers: { authorization: actor.bearer },
        payload: { name: "Normaler Schlüssel", scopes: ["read:employees"] },
      });

      expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
      const body = JSON.parse(res.body) as { scopes: string[] };
      expect(body.scopes).toEqual(["read:employees"]);
    });
  });

  describe("Fix 2 (MEDIUM, b): role:manage cannot edit a self-held role on its own", () => {
    it("(a) blocks PATCH /roles/:id on the role the actor holds itself, for an actor holding only role:manage", async () => {
      const actor = await actorWithPermissions("rolemanage-only", ["role:manage:ZUGEWIESEN"]);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/roles/${actor.roleId}`,
        headers: { authorization: actor.bearer },
        payload: { permissions: ["role:manage:ZUGEWIESEN", "role-assignment:manage:ZUGEWIESEN"] },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toContain("role-assignment:manage");
      const row = await app.prisma.accessRole.findUniqueOrThrow({ where: { id: actor.roleId } });
      expect(row.permissions).toEqual(["role:manage:ZUGEWIESEN"]);
    });

    it("(b) the same actor may still edit a DIFFERENT customer role it does not hold — the fix is targeted, not blanket", async () => {
      const actor = await actorWithPermissions("rolemanage-only-ok", ["role:manage:ZUGEWIESEN"]);
      const otherName = `Andere-Rolle-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const otherRole = await app.prisma.accessRole.create({
        data: {
          tenantId: data.tenant.id,
          name: otherName,
          nameKey: roleNameKey(otherName),
          permissions: normalizeRolePermissions(["time-entry:read:ZUGEWIESEN"]),
        },
      });
      roleIds.push(otherRole.id);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/roles/${otherRole.id}`,
        headers: { authorization: actor.bearer },
        payload: { name: `${otherName}-geändert` },
      });

      expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
      const row = await app.prisma.accessRole.findUniqueOrThrow({ where: { id: otherRole.id } });
      expect(row.name).toBe(`${otherName}-geändert`);
    });
  });
});
