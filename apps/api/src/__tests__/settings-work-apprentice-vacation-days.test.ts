/**
 * settings-work-apprentice-vacation-days.test.ts
 *
 * Issue #435 (D-03) — `TenantConfig.defaultApprenticeVacationDays` (already added to the Prisma
 * schema by plan 01/02, DB default 20) gets its first API surface: Zod validation on
 * `PUT /api/v1/settings/work`, a `GET /settings/work` fallback for a tenant with no row yet, and
 * the generic TenantConfig UPDATE audit (unchanged handler — `newValue: { ...body, appliedCount }`
 * already carries whatever the Zod schema parses).
 *
 * Bounds mirror `defaultVacationDays`'s own `decimalFromApi` pattern (steps of 0.5, string
 * round-trip accepted), except the floor is 20 (not 0.5) — § 3 BUrlG's statutory minimum at a
 * 5-day week, so a tenant default below the legal floor is rejected at the source, not just at
 * the per-person guards (plan 03, D-11).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("Issue #435 (D-03) — defaultApprenticeVacationDays on PUT/GET /settings/work", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "swavd");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
  });

  it("GET /settings/work returns the DB default (20) for a freshly seeded tenant", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Number(body.defaultApprenticeVacationDays)).toBe(20);
  });

  it("PUT { defaultApprenticeVacationDays: 22 } -> 200; GET -> 22; audited", async () => {
    // TenantConfig.id is its own UUID PK (NOT tenantId) — the TenantConfig UPDATE audit row's
    // entityId is config.id, so a GET first to learn it, mirroring how the handler itself audits.
    const beforeConfig = await app.prisma.tenantConfig.findUnique({
      where: { tenantId: data.tenant.id },
    });
    const before = beforeConfig
      ? await app.prisma.auditLog.findMany({
          where: { entity: "TenantConfig", action: "UPDATE", entityId: beforeConfig.id },
          select: { id: true },
        })
      : [];
    const knownIds = new Set(before.map((l) => l.id));

    const putRes = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { defaultApprenticeVacationDays: 22 },
    });
    expect(putRes.statusCode).toBe(200);
    expect(Number(JSON.parse(putRes.body).defaultApprenticeVacationDays)).toBe(22);

    const getRes = await app.inject({
      method: "GET",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(Number(JSON.parse(getRes.body).defaultApprenticeVacationDays)).toBe(22);

    const afterConfig = await app.prisma.tenantConfig.findUniqueOrThrow({
      where: { tenantId: data.tenant.id },
    });
    const after = await app.prisma.auditLog.findMany({
      where: { entity: "TenantConfig", action: "UPDATE", entityId: afterConfig.id },
      orderBy: { createdAt: "desc" },
    });
    const fresh = after.filter((l) => !knownIds.has(l.id));
    expect(fresh.length).toBeGreaterThan(0);
    const newest = fresh[0];
    const newValue = newest.newValue as Record<string, unknown>;
    expect(Number(newValue.defaultApprenticeVacationDays)).toBe(22);
  });

  it("PUT 19.5 -> 400 (below the 20-day statutory floor)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { defaultApprenticeVacationDays: 19.5 },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("Validierungsfehler");
  });

  it("PUT 20.25 -> 400 (not a multiple of 0.5)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { defaultApprenticeVacationDays: 20.25 },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("Validierungsfehler");
  });

  it('PUT "21.5" (string, Decimal round-trip shape) -> 200 via decimalFromApi', async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { defaultApprenticeVacationDays: "21.5" },
    });
    expect(res.statusCode).toBe(200);
    expect(Number(JSON.parse(res.body).defaultApprenticeVacationDays)).toBe(21.5);
  });
});
