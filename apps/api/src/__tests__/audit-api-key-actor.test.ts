/**
 * Issue #333 — an API-key caller's `apikey:<id>` subject must never reach `AuditLog.userId` (a
 * foreign key onto `User`). Before the fix in `contexts/platform/plugins/audit.ts`, every one of
 * these writes answered 500 because the audit insert inside the route's write violated that FK —
 * on the CROSS_TENANT_ACCESS_DENIED audit specifically, that turned an otherwise-identical 404
 * into a 500, a tenant-membership oracle (T-100-09).
 *
 * One writing route per business context (CLAUDE.md's four contexts + the Unterbau), plus the
 * hard-delete in `employees.ts` the Phase 74b review named explicitly. Each proves:
 *  - the request no longer 500s,
 *  - the resulting AuditLog row has `userId: null` (never the raw `apikey:<id>` subject),
 *  - the row still identifies WHICH API key acted, via `newValue.actor` (Revisionssicherheit) —
 *    the same convention `services/clock/audit-actor.ts` and
 *    `contexts/platform/request-audit-fields.ts` already use.
 *
 * Mutation proof (recorded here, not re-run by CI): reverting `plugins/audit.ts` to write
 * `userId: params.userId` unconditionally makes every "no 500" assertion below fail with
 * `expect(res.statusCode).not.toBe(500)` — actual 500 — and the two CROSS_TENANT_ACCESS_DENIED
 * cases regress to a distinguishable 500 vs. 404 (the T-100-09 oracle).
 */
import { randomBytes, createHash } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";

function uniqueSuffix(label: string): string {
  return `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("Issue #333 — API-key audit actor", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let dataB: Awaited<ReturnType<typeof seedTestData>>;
  let apiKeyId: string;
  let apiKeyToken: string;

  async function createApiKey(tenantId: string, createdBy: string, scopes: string[]) {
    const raw = `clk_${randomBytes(24).toString("hex")}`;
    const row = await app.prisma.apiKey.create({
      data: {
        tenantId,
        name: `audit-333-${uniqueSuffix("k")}`,
        keyHash: createHash("sha256").update(raw).digest("hex"),
        keyPrefix: raw.slice(0, 8),
        scopes,
        createdBy,
      },
    });
    return { raw, id: row.id };
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "aud333-a");
    dataB = await seedTestData(app, "aud333-b");
    const key = await createApiKey(data.tenant.id, data.adminUser.id, ["admin"]);
    apiKeyId = key.id;
    apiKeyToken = key.raw;
  });

  afterAll(async () => {
    try {
      await app.prisma.apiKey.deleteMany({ where: { tenantId: data.tenant.id } });
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, dataB.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
    await closeTestApp();
  });

  /** Reads back the freshly-written audit row and asserts the Issue #333 invariants common to
   * every case below: `userId` is never the raw subject, and the API key is still identified. */
  async function assertApiKeyActorAudit(entity: string, entityId: string, action: string) {
    const log = await app.prisma.auditLog.findFirst({
      where: { entity, entityId, action },
      orderBy: { createdAt: "desc" },
    });
    expect(log).not.toBeNull();
    expect(log!.userId).toBeNull();
    expect(log!.userId).not.toBe(`apikey:${apiKeyId}`);
    const newValue = log!.newValue as { actor?: { type: string; apiKeyId: string } } | null;
    expect(newValue?.actor).toEqual({ type: "API_KEY", apiKeyId });
    return log!;
  }

  it("Unterbau (platform) — DELETE /employees/:id/hard-delete via API key succeeds and audits the actor (Phase 74b review)", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { dataRetentionYears: 6 },
    });
    const uid = uniqueSuffix("hd");
    const exitDate = new Date();
    exitDate.setFullYear(exitDate.getFullYear() - 7);
    const user = await app.prisma.user.create({
      data: {
        email: `deleted-${uid}@anonymized.local`,
        passwordHash: "ANONYMIZED",
        role: "EMPLOYEE",
        isActive: false,
      },
    });
    const emp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        firstName: "Gelöscht",
        lastName: `GELÖSCHT-${uid}`,
        employeeNumber: `GELÖSCHT-${uid}`,
        hireDate: exitDate,
        exitDate,
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });

    try {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${emp.id}/hard-delete`,
        headers: { authorization: `Bearer ${apiKeyToken}` },
      });

      expect(res.statusCode).not.toBe(500);
      expect(res.statusCode).toBe(204);
      const found = await app.prisma.employee.findUnique({ where: { id: emp.id } });
      expect(found).toBeNull();

      await assertApiKeyActorAudit("Employee", emp.id, "HARD_DELETE");
    } finally {
      await app.prisma.tenantConfig.update({
        where: { tenantId: data.tenant.id },
        data: { dataRetentionYears: 10 },
      });
      await app.prisma.overtimeAccount.deleteMany({ where: { employeeId: emp.id } });
      await app.prisma.employee.deleteMany({ where: { id: emp.id } });
      await app.prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  it("Zeiterfassung (time-tracking) — POST /admin/presence-sources via API key succeeds and audits the actor (previously a direct auditLog.create bypassing app.audit())", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/presence-sources",
      headers: { authorization: `Bearer ${apiKeyToken}`, "content-type": "application/json" },
      payload: { name: `Audit333 Quelle ${uniqueSuffix("ps")}` },
    });

    expect(res.statusCode).not.toBe(500);
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: string };

    await assertApiKeyActorAudit("PresenceSource", body.id, "CREATE");

    await app.prisma.presenceSource.deleteMany({ where: { id: body.id } });
  });

  it("Abwesenheiten (absence) — POST /company-shutdowns via API key succeeds and audits the actor", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/company-shutdowns",
      headers: { authorization: `Bearer ${apiKeyToken}`, "content-type": "application/json" },
      payload: {
        name: `Audit333 Betriebsurlaub ${uniqueSuffix("cs")}`,
        startDate: "2026-12-24",
        endDate: "2026-12-26",
      },
    });

    expect(res.statusCode).not.toBe(500);
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: string };

    await assertApiKeyActorAudit("CompanyShutdown", body.id, "CREATE");

    await app.prisma.companyShutdown.deleteMany({ where: { id: body.id } });
  });

  it("Schichtplanung (scheduling) — POST /shifts/coverage-rules via API key succeeds and audits the actor", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts/coverage-rules",
      headers: { authorization: `Bearer ${apiKeyToken}`, "content-type": "application/json" },
      payload: { dayOfWeek: 2, minStaff: 1 },
    });

    expect(res.statusCode).not.toBe(500);
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: string };

    await assertApiKeyActorAudit("CoverageRule", body.id, "CREATE");

    await app.prisma.coverageRule.deleteMany({ where: { id: body.id } });
  });

  it("Arbeitszeitkonto (working-time-account) — POST /overtime/plans via API key succeeds and audits the actor", async () => {
    const deadline = new Date();
    deadline.setFullYear(deadline.getFullYear() + 1);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/plans",
      headers: { authorization: `Bearer ${apiKeyToken}`, "content-type": "application/json" },
      payload: {
        employeeId: data.employee.id,
        hoursToReduce: 1,
        deadline: deadline.toISOString(),
        note: "Audit333",
      },
    });

    expect(res.statusCode).not.toBe(500);
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: string };

    await assertApiKeyActorAudit("OvertimePlan", body.id, "CREATE");

    await app.prisma.overtimePlan.deleteMany({ where: { id: body.id } });
  });

  it("T-100-09: a foreign tenant's employee via API key answers the SAME 404 as an unknown id, not a 500 (CROSS_TENANT_ACCESS_DENIED audit no longer FK-violates)", async () => {
    const deadline = new Date();
    deadline.setFullYear(deadline.getFullYear() + 1);

    const foreignRes = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/plans",
      headers: { authorization: `Bearer ${apiKeyToken}`, "content-type": "application/json" },
      payload: {
        employeeId: dataB.employee.id,
        hoursToReduce: 1,
        deadline: deadline.toISOString(),
      },
    });
    const unknownRes = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/plans",
      headers: { authorization: `Bearer ${apiKeyToken}`, "content-type": "application/json" },
      payload: {
        employeeId: "00000000-0000-4000-8000-000000000001",
        hoursToReduce: 1,
        deadline: deadline.toISOString(),
      },
    });

    expect(foreignRes.statusCode).not.toBe(500);
    expect(foreignRes.statusCode).toBe(404);
    expect(unknownRes.statusCode).toBe(404);
    expect(foreignRes.body).toBe(unknownRes.body);

    await assertApiKeyActorAudit("Employee", dataB.employee.id, "CROSS_TENANT_ACCESS_DENIED");
  });
});
