/**
 * Phase 71b (issue #71), D-01/AC-1 — tracer: a new salon without an explicit `federalState`
 * inherits the tenant's CURRENT state; an explicit state is stored as given; an invalid state is
 * rejected; the CREATE audit row's `newValue` carries the stored state; `GET /api/v1/salons`
 * lists `federalState` for every salon; `seedTestData`'s own default salon (NI tenant) has
 * `federalState === "NIEDERSACHSEN"`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";

describe("Phase 71b — Salon.federalState (D-01, AC-1)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "71b-fedstate");
    await app.prisma.tenant.update({
      where: { id: data.tenant.id },
      data: { federalState: "BAYERN" },
    });
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
  });

  it("seedTestData's default salon (NI tenant, created before the BAYERN update) has federalState NIEDERSACHSEN", async () => {
    const salon = await app.prisma.salon.findUniqueOrThrow({ where: { id: data.salonId! } });
    expect(salon.federalState).toBe("NIEDERSACHSEN");
  });

  it("POST /api/v1/salons without federalState stores the tenant's CURRENT federalState (BAYERN)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/salons",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        name: "71b tracer salon (default state)",
        openingHours: [
          { day: 0, open: "08:00", close: "20:00" },
          { day: 1, open: "08:00", close: "20:00" },
          { day: 2, open: "08:00", close: "20:00" },
          { day: 3, open: "08:00", close: "20:00" },
          { day: 4, open: "08:00", close: "20:00" },
          { day: 5, open: "08:00", close: "20:00" },
          { day: 6, open: "08:00", close: "20:00", closed: true },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.federalState).toBe("BAYERN");

    const auditRow = await app.prisma.auditLog.findFirst({
      where: { entity: "Salon", entityId: body.id, action: "CREATE" },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRow).not.toBeNull();
    expect((auditRow!.newValue as Record<string, unknown>).federalState).toBe("BAYERN");
  });

  it("POST /api/v1/salons with an explicit federalState stores that state, not the tenant's", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/salons",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        name: "71b tracer salon (explicit HAMBURG)",
        federalState: "HAMBURG",
        openingHours: [
          { day: 0, open: "08:00", close: "20:00" },
          { day: 1, open: "08:00", close: "20:00" },
          { day: 2, open: "08:00", close: "20:00" },
          { day: 3, open: "08:00", close: "20:00" },
          { day: 4, open: "08:00", close: "20:00" },
          { day: 5, open: "08:00", close: "20:00" },
          { day: 6, open: "08:00", close: "20:00", closed: true },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.federalState).toBe("HAMBURG");
  });

  it("POST /api/v1/salons with an invalid federalState is rejected with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/salons",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        name: "71b tracer salon (invalid state)",
        federalState: "ATLANTIS",
        openingHours: [
          { day: 0, open: "08:00", close: "20:00" },
          { day: 1, open: "08:00", close: "20:00" },
          { day: 2, open: "08:00", close: "20:00" },
          { day: 3, open: "08:00", close: "20:00" },
          { day: 4, open: "08:00", close: "20:00" },
          { day: 5, open: "08:00", close: "20:00" },
          { day: 6, open: "08:00", close: "20:00", closed: true },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/v1/salons lists federalState for every salon", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/salons?includeInactive=true",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as { salons: Array<{ id: string; federalState: string }> };
    expect(body.salons.length).toBeGreaterThan(0);
    for (const salon of body.salons) {
      expect(typeof salon.federalState).toBe("string");
      expect(salon.federalState.length).toBeGreaterThan(0);
    }
  });
});
