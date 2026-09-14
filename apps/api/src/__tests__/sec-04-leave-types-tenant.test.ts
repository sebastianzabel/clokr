/**
 * fix(sec-04): PUT /api/v1/settings/leave-types/:id loaded the target row via an
 * unfiltered `leaveType.findUnique({ where: { id } })` — any ADMIN could rewrite a
 * foreign tenant's LeaveType config (allowHalfDay, maxDaysPerYear, leadTimeDays,
 * color). Fixed with a combined `findFirst({ where: { id, tenantId } })` — LeaveType
 * carries tenantId directly, so this is the shorter equivalent to a separate
 * lookup + compare and gives the identical 404 either way.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

const GENUINELY_MISSING_LEAVE_TYPE_ID = "00000000-0000-4000-8000-000000000004";

describe("PUT /api/v1/settings/leave-types/:id — tenant isolation (sec-04)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "sec04-a");
    tenantB = await seedTestData(app, "sec04-b");
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

  it("tenantA ADMIN updating tenantB's leave type → 404, row untouched", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/leave-types/${tenantB.vacationType.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: { maxDaysPerYear: 999 },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Abwesenheitstyp nicht gefunden" });

    const victimAfter = await app.prisma.leaveType.findUnique({
      where: { id: tenantB.vacationType.id },
    });
    expect(victimAfter?.maxDaysPerYear).toBeNull();
  });

  it("the cross-tenant 404 is byte-identical to a genuine not-found 404 (no existence oracle)", async () => {
    const crossTenantRes = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/leave-types/${tenantB.vacationType.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: { maxDaysPerYear: 5 },
    });

    const notFoundRes = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/leave-types/${GENUINELY_MISSING_LEAVE_TYPE_ID}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: { maxDaysPerYear: 5 },
    });

    expect(crossTenantRes.statusCode).toBe(notFoundRes.statusCode);
    expect(JSON.parse(crossTenantRes.body)).toEqual(JSON.parse(notFoundRes.body));
  });

  it("the same call by tenantB's OWN ADMIN still succeeds exactly as before (no regression)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/leave-types/${tenantB.vacationType.id}`,
      headers: { authorization: `Bearer ${tenantB.adminToken}` },
      payload: { maxDaysPerYear: 25 },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.maxDaysPerYear).toBe(25);

    const victimAfter = await app.prisma.leaveType.findUnique({
      where: { id: tenantB.vacationType.id },
    });
    expect(victimAfter?.maxDaysPerYear).toBe(25);
  });
});
