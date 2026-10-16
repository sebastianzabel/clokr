/**
 * Issue #539 (Release A), D-10/D-11 — the role the employee screen shows and the form's "unchanged"
 * check come from the STORED role assignments, never from the `User.role` column:
 *
 * - `formRolesByUserId` derives the role (`deriveCompatRole`) and answers `null` for a person who
 *   holds no well-formed assignment in the tenant;
 * - the five employee responses serve that value under the existing `user.role` key (list, single
 *   view, the 201 of the creation incl. its post-commit fallback branch, the reactivate reply);
 * - `PATCH /employees/:id` with the derived role writes nothing, with another role it replaces and
 *   audits, and for a person without a role it assigns one (created and audited).
 *
 * The column is deliberately made stale in several cases (it says MANAGER while the stored row says
 * Mitarbeiter, or while no row exists): that is the input that distinguishes the new behaviour from
 * the old column read. No person names (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import type { Prisma, Role } from "@clokr/db";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  grantSystemRole,
  auditRowsFor,
} from "./setup";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";
import { formRolesByUserId } from "../contexts/platform/compat-role";

const PASSWORD = "test1234";
const POLICY_PASSWORD = "Test@1234567!";

describe("Issue #539 - the employee form role is derived from stored assignments", () => {
  let app: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;

  async function createPerson(
    label: string,
    column: Role,
    stored?: "ADMIN" | "MANAGER" | "EMPLOYEE",
  ) {
    const s = `${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
    const user = await app.prisma.user.create({
      data: {
        email: `form539-${s}@test.de`,
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        role: column,
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: tenant.tenant.id,
        userId: user.id,
        employeeNumber: `F5-${s}`.slice(0, 20),
        firstName: label,
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
      },
    });
    if (stored !== undefined) {
      await grantSystemRole(app.prisma, {
        tenantId: tenant.tenant.id,
        userId: user.id,
        role: stored,
      });
    }
    return { user, employee };
  }

  function get(url: string) {
    return app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${tenant.adminToken}` },
    });
  }

  function patch(employeeId: string, payload: object) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${employeeId}`,
      headers: { authorization: `Bearer ${tenant.adminToken}` },
      payload,
    });
  }

  async function listedRole(employeeId: string): Promise<unknown> {
    const res = await get("/api/v1/employees");
    expect(res.statusCode).toBe(200);
    const row = (JSON.parse(res.body) as { id: string; user: { role: unknown } }[]).find(
      (e) => e.id === employeeId,
    );
    expect(row).toBeDefined();
    return row!.user.role;
  }

  function storedRows(userId: string) {
    return app.prisma.roleAssignment.findMany({
      where: { tenantId: tenant.tenant.id, userId },
      orderBy: { createdAt: "asc" },
    });
  }

  function assignmentAudits(userId: string) {
    return app.prisma.auditLog.findMany({
      where: {
        entity: "RoleAssignment",
        OR: [
          { newValue: { path: ["userId"], equals: userId } },
          { oldValue: { path: ["userId"], equals: userId } },
        ],
      },
      orderBy: { createdAt: "asc" },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    tenant = await seedTestData(app, "form539");
    foreign = await seedTestData(app, "form539-foreign");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenant.tenant.id);
      await cleanupTestData(app, foreign.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("formRolesByUserId", () => {
    it("derives ADMIN / MANAGER / EMPLOYEE from stored TENANT rows, EMPLOYEE for a SALONS-only row, null without a well-formed row - in ONE query", async () => {
      const admin = await createPerson("Rolle Admin", "EMPLOYEE", "ADMIN");
      const manager = await createPerson("Rolle Manager", "EMPLOYEE", "MANAGER");
      const staff = await createPerson("Rolle Mitarbeiter", "ADMIN", "EMPLOYEE");
      const salonOnly = await createPerson("Rolle Salon", "MANAGER");
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: tenant.tenant.id,
          userId: salonOnly.user.id,
          accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
          scopeType: "SALONS",
          salonIds: [tenant.salonId],
          employeeIds: [],
        },
      });
      const none = await createPerson("Rolle Keine", "ADMIN");
      const malformed = await createPerson("Rolle Defekt", "ADMIN");
      // A TENANT row must carry no ids - a row with ids is malformed and counts as no role.
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: tenant.tenant.id,
          userId: malformed.user.id,
          accessRoleId: SYSTEM_ROLE_IDS.ADMIN,
          scopeType: "TENANT",
          salonIds: [tenant.salonId],
          employeeIds: [],
        },
      });
      const foreignRole = await createPerson("Rolle Fremd", "ADMIN");
      const alien = await app.prisma.accessRole.create({
        data: {
          tenantId: foreign.tenant.id,
          name: `Fremd ${crypto.randomBytes(3).toString("hex")}`,
          nameKey: `fremd-${crypto.randomBytes(3).toString("hex")}`,
          permissions: [],
        },
      });
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: tenant.tenant.id,
          userId: foreignRole.user.id,
          accessRoleId: alien.id,
          scopeType: "TENANT",
          salonIds: [],
          employeeIds: [],
        },
      });

      let queries = 0;
      const counting = {
        roleAssignment: {
          findMany: (args: Prisma.RoleAssignmentFindManyArgs) => {
            queries += 1;
            return app.prisma.roleAssignment.findMany(args);
          },
        },
      } as unknown as Prisma.TransactionClient;
      const people = [admin, manager, staff, salonOnly, none, malformed, foreignRole];
      const roles = await formRolesByUserId(
        counting,
        tenant.tenant.id,
        people.map((p) => p.user.id),
      );

      expect(queries).toBe(1);
      expect([...roles.entries()]).toEqual([
        [admin.user.id, "ADMIN"],
        [manager.user.id, "MANAGER"],
        [staff.user.id, "EMPLOYEE"],
        [salonOnly.user.id, "EMPLOYEE"],
        [none.user.id, null],
        [malformed.user.id, null],
        [foreignRole.user.id, null],
      ]);
      expect(await formRolesByUserId(app.prisma, tenant.tenant.id, [])).toEqual(new Map());
    });
  });

  describe("the employee responses serve the derived role under user.role", () => {
    it("GET /employees and GET /employees/:id: null without a row, the stored role over a stale column", async () => {
      const unassigned = await createPerson("Antwort Ohne", "MANAGER");
      const stale = await createPerson("Antwort Veraltet", "MANAGER", "EMPLOYEE");
      const admin = await createPerson("Antwort Admin", "EMPLOYEE", "ADMIN");

      expect(await listedRole(unassigned.employee.id)).toBeNull();
      expect(await listedRole(stale.employee.id)).toBe("EMPLOYEE");
      expect(await listedRole(admin.employee.id)).toBe("ADMIN");

      for (const [person, expected] of [
        [unassigned, null],
        [stale, "EMPLOYEE"],
        [admin, "ADMIN"],
      ] as const) {
        const res = await get(`/api/v1/employees/${person.employee.id}`);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { user: Record<string, unknown> };
        expect(body.user.role).toBe(expected);
        // Same fields as before, the column is only no longer their source.
        expect(Object.keys(body.user)).toEqual(["email", "role", "isActive"]);
      }
    });

    it("the 201 of POST /employees serves the role the creation stored, also through the post-commit fallback branch (#379)", async () => {
      const make = async (spy: boolean) => {
        const uid = crypto.randomBytes(4).toString("hex");
        if (spy) {
          vi.spyOn(app.prisma.employee, "findUniqueOrThrow").mockRejectedValueOnce(
            new Error("transient read failure (test)"),
          );
        }
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/employees",
          headers: { authorization: `Bearer ${tenant.adminToken}` },
          payload: {
            usualWorkDays: [1, 2, 3, 4, 5],
            email: `form539-post-${uid}@test.de`,
            firstName: "Anlage",
            lastName: "Manager",
            employeeNumber: `F5P-${uid}`,
            hireDate: "2026-01-01T00:00:00.000Z",
            role: "MANAGER",
            password: POLICY_PASSWORD,
          },
        });
        vi.restoreAllMocks();
        return res;
      };

      const normal = await make(false);
      expect(normal.statusCode).toBe(201);
      expect(JSON.parse(normal.body).user.role).toBe("MANAGER");

      const fallback = await make(true);
      expect(fallback.statusCode).toBe(201);
      const body = JSON.parse(fallback.body) as { user: { role: unknown }; id: string };
      expect(body.user.role).toBe("MANAGER");
      // Non-vacuity: the fallback branch really ran (it carries the transaction's flat balance).
      expect(JSON.parse(fallback.body).overtimeAccount).toEqual({ balanceHours: 0 });
    });

    it("the reactivate reply serves the derived role", async () => {
      const person = await createPerson("Antwort Reaktiviert", "ADMIN", "MANAGER");
      await app.prisma.employee.update({
        where: { id: person.employee.id },
        data: { exitDate: new Date("2025-01-01") },
      });
      await app.prisma.user.update({ where: { id: person.user.id }, data: { isActive: false } });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/employees/${person.employee.id}/reactivate`,
        headers: { authorization: `Bearer ${tenant.adminToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).user.role).toBe("MANAGER");
    });
  });

  describe("PATCH /employees/:id compares with the derived role (D-11)", () => {
    it("the derived role echoed back writes nothing - even when the column says otherwise", async () => {
      const person = await createPerson("Form Gleich", "MANAGER", "EMPLOYEE");
      const rowsBefore = await storedRows(person.user.id);
      const auditsBefore = await assignmentAudits(person.user.id);

      const res = await patch(person.employee.id, { role: "EMPLOYEE", firstName: "Form Gleich 2" });
      expect(res.statusCode).toBe(200);

      expect(await storedRows(person.user.id)).toEqual(rowsBefore);
      expect(await assignmentAudits(person.user.id)).toEqual(auditsBefore);
      expect(
        (await app.prisma.employee.findUniqueOrThrow({ where: { id: person.employee.id } }))
          .firstName,
      ).toBe("Form Gleich 2");
    });

    it("the stale column value is NOT unchanged: requesting it is a role change (stored Mitarbeiter -> Manager), audited", async () => {
      const person = await createPerson("Form Veraltet", "MANAGER", "EMPLOYEE");

      const res = await patch(person.employee.id, { role: "MANAGER" });
      expect(res.statusCode).toBe(200);

      const rows = await storedRows(person.user.id);
      expect(rows.map((row) => row.accessRoleId)).toEqual([SYSTEM_ROLE_IDS.MANAGER]);
      const audits = await assignmentAudits(person.user.id);
      expect(audits.map((row) => row.action).sort()).toEqual(["CREATE", "DELETE"]);
    });

    it("a person without any role gets exactly the requested one through the form: one Manager row, audited, nothing implicit", async () => {
      const person = await createPerson("Form Ohne Rolle", "MANAGER");
      expect(await storedRows(person.user.id)).toEqual([]);

      // The form shows "no role" for this person, so the column's MANAGER is no "unchanged".
      expect(await listedRole(person.employee.id)).toBeNull();
      const res = await patch(person.employee.id, { role: "MANAGER" });
      expect(res.statusCode).toBe(200);

      const rows = await storedRows(person.user.id);
      expect(rows.map((row) => [row.accessRoleId, row.scopeType])).toEqual([
        [SYSTEM_ROLE_IDS.MANAGER, "TENANT"],
      ]);
      const audits = await assignmentAudits(person.user.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: "CREATE",
        entityId: rows[0].id,
        userId: tenant.adminUser.id,
        newValue: { accessRoleId: SYSTEM_ROLE_IDS.MANAGER, roleName: "Manager" },
      });
      expect(await listedRole(person.employee.id)).toBe("MANAGER");
      expect(await auditRowsFor(app, "RoleAssignment", rows[0].id)).toHaveLength(1);
    });
  });
});
