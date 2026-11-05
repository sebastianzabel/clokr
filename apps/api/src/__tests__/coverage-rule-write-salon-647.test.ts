/**
 * Issue #647 (AC 5, D-06 … D-09, planner-added D-13) — the write surface of coverage rules with a
 * salon. One validator (`resolveSalonInReach`), one 404 body for a foreign, unknown or inactive salon,
 * answered before any write; a NEW salon assignment must name an active salon while an UNCHANGED
 * salon of a later deactivated salon stays editable (D-06); tenant-wide rules keep today's
 * permission behaviour, a salon-scoped manager still gets 403 (D-07); the audit rows keep their
 * shape with `salonId` as one more field (D-08); the list carries the salon's display fields
 * `salonName` and `salonActive` next to the control value `salonId` (D-09). D-13: `PUT` checks a
 * changed `templateId` against the tenant exactly like `POST` (identical 404 for a foreign and an
 * unknown template).
 *
 * Fixture: tenant T (default salon, plus active salons A, B, C and an inactive salon I), a foreign
 * tenant with salon F and template FT, a template X of T, and a salon manager M (SALON_MANAGER,
 * SALONS [A], Stammsalon A). Synthetic names only.
 *
 * Mutation proof (Phase 647, 2026-11-05) — recorded here, not re-run by CI; each change was
 * reverted after confirming the observed failures:
 * M1 the POST salon check skipped (`ruleSalonId` taken from the body without the validator) → red:
 *    "POST with a foreign, an unknown and an inactive salon answers the identical 404 and writes nothing".
 * M2 the PUT condition "differs from the stored salon" removed (always validate) → red:
 *    "a rule of a later deactivated salon stays editable; a new assignment to it is the 404".
 * M3 the PUT salon check skipped → red: "PUT with a foreign, an unknown and an inactive salon is the
 *    identical 404; the row and its audit stay untouched" and "a rule of a later deactivated salon
 *    stays editable; a new assignment to it is the 404".
 * M4 the D-13 template check on PUT skipped → red: "PUT with a foreign or unknown template is the
 *    identical 404; a template of the tenant and null are accepted (D-13)".
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  auditRowsFor,
  soleAuditRow,
} from "./setup";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";

const PASSWORD = "test1234";
const SALON_NOT_FOUND = '{"error":"Salon nicht gefunden"}';
const TEMPLATE_NOT_FOUND = '{"error":"Vorlage nicht gefunden"}';

type RuleBody = {
  id: string;
  salonId: string | null;
  templateId: string | null;
  minStaff: string | number;
  salonName?: string | null;
  salonActive?: boolean | null;
};

describe("Issue #647 — coverage-rule writes validate the salon", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string; name: string };
  let salonB: { id: string; name: string };
  let salonC: { id: string; name: string };
  let salonI: { id: string };
  let salonF: { id: string };
  let templateX: { id: string };
  let templateFT: { id: string };
  let managerToken: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  function post(payload: Record<string, unknown>, token = data.adminToken) {
    return app.inject({
      method: "POST",
      url: "/api/v1/shifts/coverage-rules",
      headers: auth(token),
      payload,
    });
  }

  function put(id: string, payload: Record<string, unknown>, token = data.adminToken) {
    return app.inject({
      method: "PUT",
      url: `/api/v1/shifts/coverage-rules/${id}`,
      headers: auth(token),
      payload,
    });
  }

  /** A rule written straight to the table (tenant-wide unless `salonId` is given). */
  async function seedRule(overrides: { salonId?: string | null; templateId?: string | null } = {}) {
    return app.prisma.coverageRule.create({
      data: {
        tenantId: data.tenant.id,
        templateId: overrides.templateId ?? null,
        salonId: overrides.salonId ?? null,
        dayOfWeek: -1,
        minStaff: 2,
        requiresNonSupervised: false,
      },
    });
  }

  function ruleCount(): Promise<number> {
    return app.prisma.coverageRule.count({ where: { tenantId: data.tenant.id } });
  }

  function adminAuditCount(): Promise<number> {
    return app.prisma.auditLog.count({
      where: { entity: "CoverageRule", userId: data.adminUser.id },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "cov647w");
    foreign = await seedTestData(app, "cov647wf");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Nord" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Ost" });
    salonC = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Sued" });
    salonI = await createTestSalon(app.prisma, data.tenant.id, {
      name: "Salon Alt",
      isActive: false,
    });
    salonF = await createTestSalon(app.prisma, foreign.tenant.id, { name: "Salon Fremd" });
    templateX = await app.prisma.shiftTemplate.create({
      data: { tenantId: data.tenant.id, name: "Vorlage X", startTime: "09:00", endTime: "15:00" },
    });
    templateFT = await app.prisma.shiftTemplate.create({
      data: {
        tenantId: foreign.tenant.id,
        name: "Vorlage Fremd",
        startTime: "09:00",
        endTime: "15:00",
      },
    });

    const suffix = `mgr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `${suffix}@example.invalid`,
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        isActive: true,
      },
    });
    const manager = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: suffix.toUpperCase().slice(0, 20),
        firstName: "manager",
        lastName: "Cov647",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: manager.id,
        salonId: salonA.id,
        kind: "HOME",
        validFrom: new Date("2024-01-01T00:00:00Z"),
        validUntil: null,
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
        scopeType: "SALONS",
        salonIds: [salonA.id],
        employeeIds: [],
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: user.email, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    managerToken = (JSON.parse(login.body) as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data.tenant.id } });
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, foreign.tenant.id);
    } catch (err) {
      console.error("coverage-rule-write-salon-647 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("POST stores the salon and the CREATE audit row carries it", async () => {
    const res = await post({ dayOfWeek: -1, minStaff: 1, salonId: salonA.id });
    expect(res.statusCode, res.body).toBe(201);
    const body = JSON.parse(res.body) as RuleBody;
    expect(body.salonId).toBe(salonA.id);
    const stored = await app.prisma.coverageRule.findUniqueOrThrow({ where: { id: body.id } });
    expect(stored.salonId).toBe(salonA.id);
    const audit = await soleAuditRow(app.prisma, {
      where: { entity: "CoverageRule", entityId: body.id, action: "CREATE" },
    });
    expect((audit.newValue as { salonId: string }).salonId).toBe(salonA.id);
  });

  it("POST without the key and with salonId null is tenant-wide", async () => {
    const without = await post({ dayOfWeek: -1, minStaff: 1 });
    expect(without.statusCode, without.body).toBe(201);
    const withNull = await post({ dayOfWeek: -1, minStaff: 1, salonId: null });
    expect(withNull.statusCode, withNull.body).toBe(201);
    for (const res of [without, withNull]) {
      const stored = await app.prisma.coverageRule.findUniqueOrThrow({
        where: { id: (JSON.parse(res.body) as RuleBody).id },
      });
      expect(stored.salonId).toBeNull();
    }
  });

  it("POST with a foreign, an unknown and an inactive salon answers the identical 404 and writes nothing", async () => {
    const rulesBefore = await ruleCount();
    const auditBefore = await adminAuditCount();
    for (const salonId of [salonF.id, randomUUID(), salonI.id]) {
      const res = await post({ dayOfWeek: -1, minStaff: 1, salonId });
      expect(res.statusCode, res.body).toBe(404);
      expect(res.body).toBe(SALON_NOT_FOUND);
    }
    expect(await ruleCount()).toBe(rulesBefore);
    expect(await adminAuditCount()).toBe(auditBefore);
  });

  it("POST parses the body first: a malformed salon id is 400 and an empty body is 400", async () => {
    const bad = await post({ dayOfWeek: -1, minStaff: 1, salonId: "bad" });
    expect(bad.statusCode).toBe(400);
    const empty = await post({});
    expect(empty.statusCode).toBe(400);
    expect((JSON.parse(empty.body) as { error: string }).error).toBe("Validierungsfehler");
  });

  it("a salon-scoped manager gets 403 on every write, with and without a salon (D-07)", async () => {
    const withSalon = await post({ dayOfWeek: -1, minStaff: 1, salonId: salonA.id }, managerToken);
    expect(withSalon.statusCode).toBe(403);
    const tenantWide = await post({ dayOfWeek: -1, minStaff: 1 }, managerToken);
    expect(tenantWide.statusCode).toBe(403);
  });

  it("PUT assigns a tenant-wide rule to a salon and the UPDATE audit row shows old and new salon", async () => {
    const rule = await seedRule();
    const res = await put(rule.id, { salonId: salonA.id });
    expect(res.statusCode, res.body).toBe(200);
    expect((JSON.parse(res.body) as RuleBody).salonId).toBe(salonA.id);
    const audit = await soleAuditRow(app.prisma, {
      where: { entity: "CoverageRule", entityId: rule.id, action: "UPDATE" },
    });
    expect((audit.oldValue as { salonId: string | null }).salonId).toBeNull();
    expect((audit.newValue as { salonId: string }).salonId).toBe(salonA.id);
  });

  it("PUT with a foreign, an unknown and an inactive salon is the identical 404; the row and its audit stay untouched", async () => {
    const rule = await seedRule();
    for (const salonId of [salonF.id, randomUUID(), salonI.id]) {
      const res = await put(rule.id, { salonId });
      expect(res.statusCode, res.body).toBe(404);
      expect(res.body).toBe(SALON_NOT_FOUND);
    }
    const stored = await app.prisma.coverageRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(stored.salonId).toBeNull();
    expect(await auditRowsFor(app, "CoverageRule", rule.id, "UPDATE")).toHaveLength(0);
  });

  it("PUT with salonId null makes a rule tenant-wide; a PUT without the key keeps the salon", async () => {
    const rule = await seedRule({ salonId: salonB.id });
    const keep = await put(rule.id, { minStaff: 4 });
    expect(keep.statusCode, keep.body).toBe(200);
    expect((JSON.parse(keep.body) as RuleBody).salonId).toBe(salonB.id);
    const cleared = await put(rule.id, { salonId: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((JSON.parse(cleared.body) as RuleBody).salonId).toBeNull();
  });

  it("a rule of a later deactivated salon stays editable; a new assignment to it is the 404", async () => {
    const rule = await seedRule({ salonId: salonC.id });
    const tenantWide = await seedRule();
    await app.prisma.salon.update({
      where: { id: salonC.id },
      data: { isActive: false, deactivatedAt: new Date() },
    });
    const unchanged = await put(rule.id, { minStaff: 2, salonId: salonC.id });
    expect(unchanged.statusCode, unchanged.body).toBe(200);
    const assign = await put(tenantWide.id, { salonId: salonC.id });
    expect(assign.statusCode, assign.body).toBe(404);
    expect(assign.body).toBe(SALON_NOT_FOUND);
  });

  it("GET lists salonId with the display fields salonName and salonActive, tenant-scoped and in the old order", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/shifts/coverage-rules",
      headers: auth(data.adminToken),
    });
    expect(res.statusCode, res.body).toBe(200);
    const rows = JSON.parse(res.body) as RuleBody[];
    const tenantWide = rows.find((r) => r.salonId === null);
    expect(tenantWide).toMatchObject({ salonName: null, salonActive: null });
    const ofA = rows.find((r) => r.salonId === salonA.id);
    expect(ofA).toMatchObject({ salonName: salonA.name, salonActive: true });
    // Salon C was deactivated by the previous case and still carries a rule
    const ofC = rows.find((r) => r.salonId === salonC.id);
    expect(ofC).toMatchObject({ salonName: salonC.name, salonActive: false });
    const foreignIds = (
      await app.prisma.coverageRule.findMany({
        where: { tenantId: foreign.tenant.id },
        select: { id: true },
        orderBy: { id: "asc" },
      })
    ).map((r) => r.id);
    expect(rows.every((r) => !foreignIds.includes(r.id))).toBe(true);
    // Order unchanged: the key sequence (templateId, dayOfWeek) equals the pre-#647 orderBy
    const reference = await app.prisma.coverageRule.findMany({
      where: { tenantId: data.tenant.id },
      select: { templateId: true, dayOfWeek: true },
      orderBy: [{ templateId: "asc" }, { dayOfWeek: "asc" }],
    });
    expect(
      rows.map((r) => [r.templateId, (r as RuleBody & { dayOfWeek: number }).dayOfWeek]),
    ).toEqual(reference.map((r) => [r.templateId, r.dayOfWeek]));
  });

  it("PUT with a foreign or unknown template is the identical 404; a template of the tenant and null are accepted (D-13)", async () => {
    const rule = await seedRule();
    for (const templateId of [templateFT.id, randomUUID()]) {
      const res = await put(rule.id, { templateId });
      expect(res.statusCode, res.body).toBe(404);
      expect(res.body).toBe(TEMPLATE_NOT_FOUND);
    }
    const stored = await app.prisma.coverageRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(stored.templateId).toBeNull();
    const own = await put(rule.id, { templateId: templateX.id });
    expect(own.statusCode, own.body).toBe(200);
    expect((JSON.parse(own.body) as RuleBody).templateId).toBe(templateX.id);
    const cleared = await put(rule.id, { templateId: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((JSON.parse(cleared.body) as RuleBody).templateId).toBeNull();
  });

  it("DELETE of a salon rule is 204 and writes one DELETE audit row", async () => {
    const rule = await seedRule({ salonId: salonB.id });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/shifts/coverage-rules/${rule.id}`,
      headers: auth(data.adminToken),
    });
    expect(res.statusCode).toBe(204);
    const audit = await soleAuditRow(app.prisma, {
      where: { entity: "CoverageRule", entityId: rule.id, action: "DELETE" },
    });
    expect((audit.oldValue as { salonId: string }).salonId).toBe(salonB.id);
  });
});
