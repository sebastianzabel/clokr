import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import type { FastifyInstance } from "fastify";

/**
 * Phase 47.3 — Verfügbarkeits-System Feature-Toggle
 *
 * Covers:
 *  - Toggle ON (default): UNAVAILABLE rows surface in /shifts/week response.
 *  - Toggle OFF: same UNAVAILABLE rows are hidden (response shows "available").
 *  - Toggle OFF: generate-week skip array contains NO `availability-unavailable` entries.
 *  - Toggle OFF: CRUD endpoints return 410 Gone with code AVAILABILITY_FEATURE_DISABLED.
 *
 * Data is preserved across toggles — EmployeeAvailability rows remain in the DB and
 * reappear in the response when the toggle is flipped back to true.
 */
describe("Verfügbarkeits-System Feature-Toggle (Phase 47.3)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // ISO Monday of an arbitrary future test week (Mo=2026-06-15..So=2026-06-21)
  // The Wednesday of that week is 2026-06-17. We seed an UNAVAILABLE row for
  // dayOfWeek=2 (Mi, where 0=Mo..6=So matches the rest of shifts.ts).
  const TEST_WEEK_START = "2026-06-15";
  const TEST_WEEK_WEDNESDAY = "2026-06-17";

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "av-toggle");

    // Phase 47.1 — shift endpoints require an active SHIFT_BASED schedule.
    // Layer SHIFT_BASED on top of the default FIXED_SCHEDULE row with a newer validFrom.
    await app.prisma.workSchedule.create({
      data: {
        employeeId: data.employee.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        validFrom: new Date("2024-02-01"),
      },
    });

    // Seed one recurring UNAVAILABLE row for Wednesday (dayOfWeek=2, Mo=0..So=6)
    await app.prisma.employeeAvailability.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 2,
        status: "UNAVAILABLE",
        validFrom: new Date("2024-01-01"),
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── Test 1: Toggle ON (default) — UNAVAILABLE surfaces ─────────────────────
  it("toggle ON: GET /shifts/week shows UNAVAILABLE entry on Mi", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { availabilityEnabled: true },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${TEST_WEEK_START}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as {
      availability: Array<{ employeeId: string; date: string; availability: string }>;
    };
    const miEntry = body.availability.find(
      (a) => a.employeeId === data.employee.id && a.date === TEST_WEEK_WEDNESDAY,
    );
    expect(miEntry).toBeDefined();
    expect(miEntry?.availability).toBe("unavailable");
  });

  // ── Test 2: Toggle OFF — UNAVAILABLE hidden, defaults to "available" ───────
  it("toggle OFF: GET /shifts/week reports `available` on Mi (row preserved in DB)", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { availabilityEnabled: false },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${TEST_WEEK_START}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as {
      availability: Array<{ employeeId: string; date: string; availability: string }>;
    };
    const miEntry = body.availability.find(
      (a) => a.employeeId === data.employee.id && a.date === TEST_WEEK_WEDNESDAY,
    );
    expect(miEntry).toBeDefined();
    expect(miEntry?.availability).toBe("available");

    // Audit-proof: the row itself is preserved in the DB.
    const rows = await app.prisma.employeeAvailability.findMany({
      where: { employeeId: data.employee.id, status: "UNAVAILABLE" },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  // ── Test 3: Toggle OFF — generate-week skip has no `availability-unavailable` ─
  it("toggle OFF: POST /shifts/generate-week skip array contains no availability-unavailable", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { availabilityEnabled: false },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts/generate-week",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { weekStart: TEST_WEEK_START, commit: false },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as {
      skip: Array<{ employeeId: string; date: string; reason: string }>;
    };
    const availSkips = body.skip.filter((s) => s.reason === "availability-unavailable");
    expect(availSkips).toHaveLength(0);
  });

  // ── Test 4: Toggle OFF — GET + PUT availability return 410 Gone ────────────
  describe("toggle OFF: availability CRUD returns 410 Gone", () => {
    beforeEach(async () => {
      await app.prisma.tenantConfig.update({
        where: { tenantId: data.tenant.id },
        data: { availabilityEnabled: false },
      });
    });

    it("GET /employees/:id/availability → 410 + AVAILABILITY_FEATURE_DISABLED", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${data.employee.id}/availability`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(410);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("AVAILABILITY_FEATURE_DISABLED");
      expect(body.error).toBeDefined();
    });

    it("PUT /employees/:id/availability → 410 + AVAILABILITY_FEATURE_DISABLED", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/employees/${data.employee.id}/availability`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          entries: [
            {
              dayOfWeek: 3,
              status: "PREFERRED",
              validFrom: "2026-01-01",
            },
          ],
        },
      });
      expect(res.statusCode).toBe(410);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("AVAILABILITY_FEATURE_DISABLED");
    });
  });
});
