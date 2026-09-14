/**
 * fix(sec-06): DELETE /api/v1/special-leave/rules/:id loaded the target row via an
 * unfiltered `specialLeaveRule.findUnique({ where: { id } })` — any ADMIN could
 * hard-delete a foreign tenant's custom SpecialLeaveRule. Fixed with a combined
 * `findFirst({ where: { id, tenantId } })`, same rationale as the PUT handler
 * (sec-05) in this same file.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

const GENUINELY_MISSING_RULE_ID = "00000000-0000-4000-8000-000000000006";

async function createCustomRule(
  app: FastifyInstance,
  adminToken: string,
  name: string,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/special-leave/rules",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { name, defaultDays: 1, requiresProof: false },
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body).id as string;
}

describe("DELETE /api/v1/special-leave/rules/:id — tenant isolation (sec-06)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  let victimRuleId: string;

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "sec06-a");
    tenantB = await seedTestData(app, "sec06-b");
    victimRuleId = await createCustomRule(app, tenantB.adminToken, "Sec06 Victim Rule");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantA failed:", err);
    }
    try {
      await cleanupTestData(app, tenantB.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantB failed:", err);
    }
  });

  it("tenantA ADMIN deleting tenantB's rule → 404, row untouched", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/special-leave/rules/${victimRuleId}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Regel nicht gefunden" });

    const victimAfter = await app.prisma.specialLeaveRule.findUnique({
      where: { id: victimRuleId },
    });
    expect(victimAfter).not.toBeNull();
  });

  it("the cross-tenant 404 is byte-identical to a genuine not-found 404 (no existence oracle)", async () => {
    const crossTenantRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/special-leave/rules/${victimRuleId}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    const notFoundRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/special-leave/rules/${GENUINELY_MISSING_RULE_ID}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    expect(crossTenantRes.statusCode).toBe(notFoundRes.statusCode);
    expect(JSON.parse(crossTenantRes.body)).toEqual(JSON.parse(notFoundRes.body));
  });

  it("the same call by tenantB's OWN ADMIN still succeeds exactly as before (no regression)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/special-leave/rules/${victimRuleId}`,
      headers: { authorization: `Bearer ${tenantB.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });

    const victimAfter = await app.prisma.specialLeaveRule.findUnique({
      where: { id: victimRuleId },
    });
    expect(victimAfter).toBeNull();
  });
});
