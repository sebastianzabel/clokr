/**
 * Issue #836 (D-836-02/13/14/22, AC-1, AC-10) - the rule routes under /api/v1/leave/limits.
 *
 * Fixture: tenant one with its default salon S and a second salon S2; tenant two with its own salon and
 * a customer role. Actors are built from custom roles (never from what the seeded admin holds): a
 * whole-tenant manager, a manager scoped to S, an approver scoped to S, and a caller with an unrelated
 * key. No person names.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  tokenWithoutSignIn,
  soleAuditRow,
} from "./setup";
import { roleNameKey, normalizeRolePermissions } from "../contexts/platform/access-role";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";

const MANAGE = "leave-limit:manage:ZUGEWIESEN";
const APPROVE = "leave-request:approve:ZUGEWIESEN";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000001";

type Dto = {
  id: string;
  salonId: string | null;
  salonName: string | null;
  groupKind: string;
  accessRoleId: string | null;
  accessRoleName: string | null;
  maxPersons: number;
  validFrom: string | null;
  validUntil: string | null;
  name: string | null;
  canManage: boolean;
};

describe("Issue #836 - /api/v1/leave/limits", () => {
  let app: FastifyInstance;
  let one: Awaited<ReturnType<typeof seedTestData>>;
  let two: Awaited<ReturnType<typeof seedTestData>>;
  let salonS2: string;
  let foreignRoleId: string;
  let tenantManager: string;
  let salonManager: string;
  let salonApprover: string;
  let outsider: string;

  async function actor(
    label: string,
    permissions: string[],
    scope: { scopeType: "TENANT" | "SALONS"; salonIds?: string[] },
  ): Promise<string> {
    const email = `${label}-${crypto.randomBytes(3).toString("hex")}@example.invalid`;
    const user = await app.prisma.user.create({
      data: { email, passwordHash: await bcrypt.hash("test1234", 4), isActive: true },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: one.tenant.id,
        userId: user.id,
        employeeNumber: `L${crypto.randomBytes(4).toString("hex")}`,
        firstName: "L",
        lastName: "Actor836",
        hireDate: new Date("2024-01-01"),
      },
    });
    const name = `Limits836 ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: one.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(permissions),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: one.tenant.id,
        userId: user.id,
        accessRoleId: role.id,
        scopeType: scope.scopeType,
        salonIds: scope.salonIds ?? [],
        employeeIds: [],
      },
    });
    return tokenWithoutSignIn(app, email);
  }

  function call(
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    token: string,
    payload?: object,
  ) {
    return app.inject({
      method,
      url: `/api/v1/leave/limits${url}`,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });
  }

  const body = (over: Record<string, unknown> = {}) => ({
    salonId: one.salonId,
    groupKind: "ALL",
    maxPersons: 1,
    ...over,
  });

  beforeAll(async () => {
    app = await getTestApp();
    one = await seedTestData(app, "llr836a");
    two = await seedTestData(app, "llr836b");
    salonS2 = (await createTestSalon(app.prisma, one.tenant.id, { name: "Limits836 S2" })).id;
    const foreignName = `Foreign836 ${crypto.randomBytes(3).toString("hex")}`;
    foreignRoleId = (
      await app.prisma.accessRole.create({
        data: {
          tenantId: two.tenant.id,
          name: foreignName,
          nameKey: roleNameKey(foreignName),
          permissions: [],
        },
      })
    ).id;
    tenantManager = await actor("tm", [MANAGE], { scopeType: "TENANT" });
    salonManager = await actor("sm", [MANAGE], { scopeType: "SALONS", salonIds: [one.salonId] });
    salonApprover = await actor("sa", [APPROVE], { scopeType: "SALONS", salonIds: [one.salonId] });
    outsider = await actor("os", ["leave-request:read:ZUGEWIESEN"], { scopeType: "TENANT" });
  });

  afterEach(async () => {
    await app.prisma.leaveLimitRule.deleteMany({
      where: { tenantId: { in: [one.tenant.id, two.tenant.id] } },
    });
    await app.prisma.auditLog.deleteMany({ where: { entity: "LeaveLimitRule" } });
  });

  afterAll(async () => {
    await app.prisma.accessRole.deleteMany({ where: { id: foreignRoleId } });
    await cleanupTestData(app, one.tenant.id);
    await cleanupTestData(app, two.tenant.id);
    await closeTestApp();
  });

  describe("POST /", () => {
    it("creates a rule for a salon and audits it (CREATE, entity LeaveLimitRule)", async () => {
      const res = await call("POST", "/", tenantManager, body({ name: "Sommer" }));
      expect(res.statusCode).toBe(201);
      const dto = JSON.parse(res.body) as Dto;
      expect(dto).toMatchObject({
        salonId: one.salonId,
        groupKind: "ALL",
        maxPersons: 1,
        name: "Sommer",
        canManage: true,
      });
      const audit = await soleAuditRow(app.prisma, {
        where: { entity: "LeaveLimitRule", action: "CREATE", entityId: dto.id },
      });
      expect(audit.newValue).toMatchObject({
        salonId: one.salonId,
        maxPersons: 1,
        groupKind: "ALL",
      });
      const stored = await app.prisma.leaveLimitRule.findUniqueOrThrow({ where: { id: dto.id } });
      expect(stored.createdByUserId).not.toBeNull();
    });

    it("stores a blackout for one salon and for all salons (AC-10)", async () => {
      const window = {
        validFrom: "2027-12-01",
        validUntil: "2027-12-24",
        name: "Weihnachtsgeschäft",
      };
      const oneSalon = await call("POST", "/", tenantManager, body({ maxPersons: 0, ...window }));
      expect(oneSalon.statusCode).toBe(201);
      expect(JSON.parse(oneSalon.body)).toMatchObject({ maxPersons: 0, validFrom: "2027-12-01" });
      const allSalons = await call(
        "POST",
        "/",
        tenantManager,
        body({ salonId: null, maxPersons: 0, ...window }),
      );
      expect(allSalons.statusCode).toBe(201);
      expect(JSON.parse(allSalons.body)).toMatchObject({
        salonId: null,
        salonName: null,
        maxPersons: 0,
        validUntil: "2027-12-24",
      });
    });

    it("a salon-scoped holder writes for its salon, not for all salons, and sees one 404 elsewhere", async () => {
      expect((await call("POST", "/", salonManager, body())).statusCode).toBe(201);
      expect((await call("POST", "/", salonManager, body({ salonId: null }))).statusCode).toBe(403);

      const outside = await call("POST", "/", salonManager, body({ salonId: salonS2 }));
      const foreign = await call("POST", "/", salonManager, body({ salonId: two.salonId }));
      const unknown = await call("POST", "/", salonManager, body({ salonId: UNKNOWN_ID }));
      expect(outside.statusCode).toBe(404);
      expect(JSON.parse(outside.body)).toEqual({ error: "Salon nicht gefunden" });
      expect(foreign.body).toBe(outside.body);
      expect(unknown.body).toBe(outside.body);
      expect(await app.prisma.leaveLimitRule.count({ where: { tenantId: one.tenant.id } })).toBe(1);
    });

    it("an inactive salon gets the same 404 body", async () => {
      const inactive = await createTestSalon(app.prisma, one.tenant.id, {
        name: "Limits836 off",
        isActive: false,
      });
      const res = await call("POST", "/", tenantManager, body({ salonId: inactive.id }));
      const unknown = await call("POST", "/", tenantManager, body({ salonId: UNKNOWN_ID }));
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(unknown.body);
    });

    it("admits a system role and a tenant role; a foreign tenant's role looks like an unknown id", async () => {
      const system = await call(
        "POST",
        "/",
        tenantManager,
        body({ groupKind: "ACCESS_ROLE", accessRoleId: SYSTEM_ROLE_IDS.MANAGER }),
      );
      expect(system.statusCode).toBe(201);
      expect(JSON.parse(system.body)).toMatchObject({
        accessRoleId: SYSTEM_ROLE_IDS.MANAGER,
        accessRoleName: expect.any(String),
      });
      const foreign = await call(
        "POST",
        "/",
        tenantManager,
        body({ groupKind: "ACCESS_ROLE", accessRoleId: foreignRoleId }),
      );
      const unknown = await call(
        "POST",
        "/",
        tenantManager,
        body({ groupKind: "ACCESS_ROLE", accessRoleId: UNKNOWN_ID }),
      );
      expect(foreign.statusCode).toBe(404);
      expect(JSON.parse(foreign.body)).toEqual({ error: "Rolle nicht gefunden" });
      expect(unknown.body).toBe(foreign.body);
    });

    it.each([
      ["CLASSIFICATION without a classification", { groupKind: "CLASSIFICATION" }],
      ["ALL with a role", { accessRoleId: SYSTEM_ROLE_IDS.MANAGER }],
      ["a negative limit", { maxPersons: -1 }],
      ["an inverted window", { validFrom: "2027-02-02", validUntil: "2027-02-01" }],
      ["a non-calendar day", { validFrom: "2027-02-30" }],
    ])("rejects %s with 400 Validierungsfehler", async (_label, over) => {
      const res = await call("POST", "/", tenantManager, body(over));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("Validierungsfehler");
    });

    it("refuses a caller without the key", async () => {
      expect((await call("POST", "/", outsider, body())).statusCode).toBe(403);
      expect((await call("POST", "/", salonApprover, body())).statusCode).toBe(403);
    });
  });

  describe("GET /", () => {
    async function seedRules() {
      const mk = (salonId: string | null, name: string) =>
        app.prisma.leaveLimitRule.create({
          data: { tenantId: one.tenant.id, salonId, groupKind: "ALL", maxPersons: 1, name },
        });
      return {
        s: await mk(one.salonId, "in S"),
        s2: await mk(salonS2, "in S2"),
        all: await mk(null, "all"),
      };
    }

    it("an approver of S gets the S rules plus the all-salons rules, read-only, no role choices", async () => {
      const rules = await seedRules();
      const res = await call("GET", `/?salonId=${one.salonId}`, salonApprover);
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body) as { rules: Dto[]; roleChoices: unknown[] };
      expect(json.rules.map((r) => r.id).sort()).toEqual([rules.s.id, rules.all.id].sort());
      expect(json.rules.every((r) => r.canManage === false)).toBe(true);
      expect(json.roleChoices).toEqual([]);
    });

    it("answers the one 404 for a salon outside the reach, foreign or unknown; 403 without either key", async () => {
      await seedRules();
      const outside = await call("GET", `/?salonId=${salonS2}`, salonApprover);
      expect(outside.statusCode).toBe(404);
      expect(JSON.parse(outside.body)).toEqual({ error: "Salon nicht gefunden" });
      expect((await call("GET", `/?salonId=${two.salonId}`, salonApprover)).body).toBe(
        outside.body,
      );
      expect((await call("GET", `/?salonId=${UNKNOWN_ID}`, salonApprover)).body).toBe(outside.body);
      expect((await call("GET", "/", outsider)).statusCode).toBe(403);
    });

    it("a whole-tenant manager lists every rule with salon names, may manage all salons, gets role choices", async () => {
      const rules = await seedRules();
      const res = await call("GET", "/", tenantManager);
      const json = JSON.parse(res.body) as {
        rules: Dto[];
        canManageAllSalons: boolean;
        roleChoices: Array<{ id: string; isSystem: boolean }>;
      };
      expect(json.rules.map((r) => r.id).sort()).toEqual(
        [rules.s.id, rules.s2.id, rules.all.id].sort(),
      );
      expect(json.rules.find((r) => r.id === rules.s2.id)?.salonName).toBe("Limits836 S2");
      expect(json.rules.every((r) => r.canManage)).toBe(true);
      expect(json.canManageAllSalons).toBe(true);
      expect(json.roleChoices.some((r) => r.id === SYSTEM_ROLE_IDS.ADMIN && r.isSystem)).toBe(true);
    });

    it("a salon-scoped manager lists its salon and the all-salons rules, manages only its salon", async () => {
      const rules = await seedRules();
      const json = JSON.parse((await call("GET", "/", salonManager)).body) as {
        rules: Dto[];
        canManageAllSalons: boolean;
      };
      expect(json.rules.map((r) => r.id).sort()).toEqual([rules.s.id, rules.all.id].sort());
      expect(json.rules.find((r) => r.id === rules.s.id)?.canManage).toBe(true);
      expect(json.rules.find((r) => r.id === rules.all.id)?.canManage).toBe(false);
      expect(json.canManageAllSalons).toBe(false);
    });

    it("never lists a soft-deleted rule", async () => {
      const rules = await seedRules();
      await app.prisma.leaveLimitRule.update({
        where: { id: rules.s.id },
        data: { deletedAt: new Date() },
      });
      const json = JSON.parse((await call("GET", "/", tenantManager)).body) as { rules: Dto[] };
      expect(json.rules.map((r) => r.id)).not.toContain(rules.s.id);
    });
  });
});
