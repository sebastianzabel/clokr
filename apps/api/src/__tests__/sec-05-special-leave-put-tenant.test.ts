/**
 * fix(sec-05): PUT /api/v1/special-leave/rules/:id loaded the target row via an
 * unfiltered `specialLeaveRule.findUnique({ where: { id } })` — any ADMIN could
 * rewrite a foreign tenant's SpecialLeaveRule. Fixed with a combined
 * `findFirst({ where: { id, tenantId } })`, mirroring the sibling GET /rules/:id
 * in this same file, which already had the correct guard.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

const GENUINELY_MISSING_RULE_ID = "00000000-0000-4000-8000-000000000005";

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

describe("PUT /api/v1/special-leave/rules/:id — tenant isolation (sec-05)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  let victimRuleId: string;

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "sec05-a");
    tenantB = await seedTestData(app, "sec05-b");
    victimRuleId = await createCustomRule(app, tenantB.adminToken, "Sec05 Victim Rule");
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

  it("tenantA ADMIN updating tenantB's rule → 404, row untouched", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/special-leave/rules/${victimRuleId}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: { defaultDays: 30 },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Regel nicht gefunden" });

    const victimAfter = await app.prisma.specialLeaveRule.findUnique({
      where: { id: victimRuleId },
    });
    expect(Number(victimAfter?.defaultDays)).toBe(1);
  });

  it("the cross-tenant 404 is byte-identical to a genuine not-found 404 (no existence oracle)", async () => {
    const crossTenantRes = await app.inject({
      method: "PUT",
      url: `/api/v1/special-leave/rules/${victimRuleId}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: { defaultDays: 2 },
    });

    const notFoundRes = await app.inject({
      method: "PUT",
      url: `/api/v1/special-leave/rules/${GENUINELY_MISSING_RULE_ID}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: { defaultDays: 2 },
    });

    expect(crossTenantRes.statusCode).toBe(notFoundRes.statusCode);
    expect(JSON.parse(crossTenantRes.body)).toEqual(JSON.parse(notFoundRes.body));
  });

  it("the same call by tenantB's OWN ADMIN still succeeds exactly as before (no regression)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/special-leave/rules/${victimRuleId}`,
      headers: { authorization: `Bearer ${tenantB.adminToken}` },
      payload: { defaultDays: 3 },
    });

    expect(res.statusCode).toBe(200);
    expect(Number(JSON.parse(res.body).defaultDays)).toBe(3);

    const victimAfter = await app.prisma.specialLeaveRule.findUnique({
      where: { id: victimRuleId },
    });
    expect(Number(victimAfter?.defaultDays)).toBe(3);
  });
});
