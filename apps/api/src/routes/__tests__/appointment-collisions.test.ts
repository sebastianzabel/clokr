// Phase 87 (CO-01/CO-02/CO-03) — contract test for the read-only appointment-collisions endpoint.
//
// GET /api/v1/integrations/phorest/appointment-collisions
//   ?employeeId=&from=&to=   (range shape — leave/sick/absence window)
//   ?shiftId=                (shift-removal shape — resolves shift → employee + single day)
//
// The endpoint is the DSGVO minimization boundary: it must return ONLY { total, collisions, deepLink }
// with collision objects carrying ONLY { date, count } — never any customer/service/price PII.
// This mirrors the Phase-86 ALLOWED_KEYS assertion in services/phorest/__tests__/sync-appointments.test.ts.
//
// Harness: getTestApp() + seedTestData() give real admin/emp logins; PhorestAppointment rows are
// inserted directly via prisma (NOT seedPhorestTenant, whose users have passwordHash "x" / no login).
// Run via `pnpm --filter @clokr/api test -- appointment-collisions` (pretest db-push).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";

// DSGVO contract: the response envelope and each collision object carry EXACTLY these keys — nothing else.
const ALLOWED_RESPONSE_KEYS = ["collisions", "deepLink", "total"];
const ALLOWED_COLLISION_KEYS = ["count", "date"];

const BASE = "/api/v1/integrations/phorest/appointment-collisions";

describe("GET /phorest/appointment-collisions", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let other: Awaited<ReturnType<typeof seedTestData>>;

  // Employee under test (the seeded EMPLOYEE) — appointments booked across two March days.
  const D1 = "2026-03-10"; // two appointments
  const D2 = "2026-03-11"; // one appointment
  const EMPTY_FROM = "2026-06-01"; // a window with no bookings
  const EMPTY_TO = "2026-06-30";

  // Shifts for the {shiftId} shape: one on D1 (2 appts) for the seeded employee, one in the OTHER tenant.
  let shiftOnD1Id: string;
  let otherTenantShiftId: string;

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "collide");
    other = await seedTestData(app, "collide-other");

    // Three appointments for the seeded employee: 2 on D1, 1 on D2. PII-laden columns do not exist
    // on the model (structural DSGVO minimization) — we insert only the five business columns.
    await app.prisma.phorestAppointment.createMany({
      data: [
        {
          employeeId: seed.employee.id,
          date: new Date(D1),
          startTime: "09:00",
          endTime: "10:00",
          externalId: `co-${seed.employee.id}-1`,
        },
        {
          employeeId: seed.employee.id,
          date: new Date(D1),
          startTime: "11:00",
          endTime: "11:45",
          externalId: `co-${seed.employee.id}-2`,
        },
        {
          employeeId: seed.employee.id,
          date: new Date(D2),
          startTime: "14:00",
          endTime: "15:00",
          externalId: `co-${seed.employee.id}-3`,
        },
      ],
    });

    // A dated shift on D1 (which has 2 appointments) for the seeded employee, plus one in the OTHER
    // tenant to prove cross-tenant shift resolution returns 404.
    const shiftOnD1 = await app.prisma.shift.create({
      data: {
        employeeId: seed.employee.id,
        date: new Date(D1),
        startTime: "08:00",
        endTime: "16:00",
      },
    });
    shiftOnD1Id = shiftOnD1.id;
    const otherShift = await app.prisma.shift.create({
      data: {
        employeeId: other.employee.id,
        date: new Date(D1),
        startTime: "08:00",
        endTime: "16:00",
      },
    });
    otherTenantShiftId = otherShift.id;
  });

  afterAll(async () => {
    try {
      // PhorestAppointment has onDelete: Restrict on employee — clear rows before tenant cleanup.
      await app.prisma.phorestAppointment.deleteMany({
        where: { employeeId: { in: [seed.employee.id, seed.adminEmployee.id] } },
      });
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (main):", err);
    }
    try {
      await cleanupTestData(app, other.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (other):", err);
    }
  });

  function get(query: string, token: string) {
    return app.inject({
      method: "GET",
      url: `${BASE}${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it("CO-01 range: groups appointments by date with per-date counts, total, ascending order", async () => {
    const res = await get(`?employeeId=${seed.employee.id}&from=${D1}&to=${D2}`, seed.adminToken);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.total).toBe(3);
    expect(body.deepLink).toBeNull();
    expect(body.collisions).toEqual([
      { date: D1, count: 2 },
      { date: D2, count: 1 },
    ]);
  });

  it("CO-01 zero-collision: empty window → total 0, empty collisions, deepLink null", async () => {
    const res = await get(
      `?employeeId=${seed.employee.id}&from=${EMPTY_FROM}&to=${EMPTY_TO}`,
      seed.adminToken,
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(0);
    expect(body.collisions).toEqual([]);
    expect(body.deepLink).toBeNull();
  });

  it("CO-03 PII-free: response key-set is exactly {total,collisions,deepLink}; collision keys {date,count}", async () => {
    const res = await get(`?employeeId=${seed.employee.id}&from=${D1}&to=${D2}`, seed.adminToken);
    const body = JSON.parse(res.body);

    expect(Object.keys(body).sort()).toEqual(ALLOWED_RESPONSE_KEYS);
    for (const c of body.collisions) {
      expect(Object.keys(c).sort()).toEqual(ALLOWED_COLLISION_KEYS);
    }
    // No busy-window / identity fields ever cross the boundary.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("startTime");
    expect(serialized).not.toContain("endTime");
    expect(serialized).not.toContain("externalId");
    expect(serialized).not.toContain("employeeId");
  });

  it("T-87-01 tenant gate: an employeeId from another tenant → 404 (never a cross-tenant read)", async () => {
    const res = await get(`?employeeId=${other.employee.id}&from=${D1}&to=${D2}`, seed.adminToken);
    expect(res.statusCode).toBe(404);
  });

  it("T-87-03 authz: employee pre-checking OWN employeeId → 200", async () => {
    const res = await get(`?employeeId=${seed.employee.id}&from=${D1}&to=${D2}`, seed.empToken);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).total).toBe(3);
  });

  it("T-87-03 authz: employee pre-checking a DIFFERENT employeeId → 403", async () => {
    const res = await get(
      `?employeeId=${seed.adminEmployee.id}&from=${D1}&to=${D2}`,
      seed.empToken,
    );
    expect(res.statusCode).toBe(403);
  });

  it("T-87-03 authz: admin may pre-check any employeeId → 200", async () => {
    const res = await get(`?employeeId=${seed.employee.id}&from=${D1}&to=${D2}`, seed.adminToken);
    expect(res.statusCode).toBe(200);
  });

  // ── CO-02: {shiftId} shape ───────────────────────────────────────────

  it("CO-02 shift shape: resolves shift → employee + single day, returns that day's count", async () => {
    const res = await get(`?shiftId=${shiftOnD1Id}`, seed.adminToken);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // The shift is on D1, which has exactly two appointments → single-day count 2.
    expect(body.total).toBe(2);
    expect(body.collisions).toEqual([{ date: D1, count: 2 }]);
    expect(body.deepLink).toBeNull();
  });

  it("CO-03 PII-free (shift shape): key-set exactly {total,collisions,deepLink}; collision keys {date,count}", async () => {
    const res = await get(`?shiftId=${shiftOnD1Id}`, seed.adminToken);
    const body = JSON.parse(res.body);
    expect(Object.keys(body).sort()).toEqual(ALLOWED_RESPONSE_KEYS);
    for (const c of body.collisions) {
      expect(Object.keys(c).sort()).toEqual(ALLOWED_COLLISION_KEYS);
    }
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("startTime");
    expect(serialized).not.toContain("endTime");
    expect(serialized).not.toContain("externalId");
    expect(serialized).not.toContain("employeeId");
  });

  it("T-87-01 tenant gate (shift shape): a shift in another tenant → 404", async () => {
    const res = await get(`?shiftId=${otherTenantShiftId}`, seed.adminToken);
    expect(res.statusCode).toBe(404);
  });

  it("T-87-03 authz: a non-manager sending any {shiftId} → 403 (shift removal is a manager action)", async () => {
    const res = await get(`?shiftId=${shiftOnD1Id}`, seed.empToken);
    expect(res.statusCode).toBe(403);
  });

  it("CO-03 deepLink is null AND present in the response across both shapes", async () => {
    const rangeBody = JSON.parse(
      (await get(`?employeeId=${seed.employee.id}&from=${D1}&to=${D2}`, seed.adminToken)).body,
    );
    const shiftBody = JSON.parse((await get(`?shiftId=${shiftOnD1Id}`, seed.adminToken)).body);
    expect("deepLink" in rangeBody).toBe(true);
    expect(rangeBody.deepLink).toBeNull();
    expect("deepLink" in shiftBody).toBe(true);
    expect(shiftBody.deepLink).toBeNull();
  });
});
