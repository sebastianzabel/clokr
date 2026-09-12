import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import type { FastifyInstance } from "fastify";
import { dowOf, futureDateStr, nextWeekdayStr, todayStr } from "../../__tests__/test-dates";

/**
 * Phase 47.3-03 — Soft-Enforcement Override (SHIFT_CONFLICT_UNAVAILABILITY)
 *
 * Covers:
 *  - Test 1: UNAVAILABLE row blocks POST /shifts without force → 409 SHIFT_CONFLICT_UNAVAILABILITY
 *  - Test 2: ?force=true writes the shift AND emits SHIFT_FORCED_OVER_UNAVAILABILITY audit
 *  - Test 3: With TenantConfig.availabilityEnabled = false, an UNAVAILABLE row does NOT block
 *
 * Mirrors the Phase 43-03 SHIFT_CONFLICT_LEAVE pattern.
 */
describe("Shift Unavailability Soft-Enforcement (Phase 47.3-03)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // A future weekday, derived rather than written (GH #136/#167). A literal stops meaning
  // "future" once the calendar passes it, and the Phase 47.2 past-immutable gate then answers
  // 422 before the soft-enforcement rule under test is reached.
  // The date is load-bearing TWICE: it must be in the future AND its weekday must match the
  // seeded availability row — so TARGET_DOW is derived FROM the date and cannot drift apart
  // from it. dowOf() is JS-style (0=Sun..6=Sat); this project's dayOfWeek is Mo=0..Su=6.
  const TARGET_ISO = nextWeekdayStr(futureDateStr(7));
  const TARGET_DOW = (dowOf(TARGET_ISO) + 6) % 7;

  // GH #136/#167 — the anchor must stay in the FUTURE and TARGET_DOW must keep matching it,
  // or the Phase 47.2 gate answers 422 before the soft-enforcement rule under test is reached.
  // CLOKR_TEST_FAKE_CLOCK cannot show this (it shifts the time of day, never the date), so the
  // property is asserted here and re-proved on every run.
  it("anchor date stays in the future and TARGET_DOW matches it (guards against date expiry)", () => {
    expect(TARGET_ISO > todayStr()).toBe(true);
    expect(TARGET_DOW).toBe((dowOf(TARGET_ISO) + 6) % 7);
    expect([1, 2, 3, 4, 5]).toContain(dowOf(TARGET_ISO));
  });

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "sus");

    // Phase 47.1 — Shift endpoints require an active SHIFT_BASED WorkSchedule.
    await app.prisma.workSchedule.create({
      data: {
        employeeId: data.employee.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        validFrom: new Date("2024-02-01"),
      },
    });

    // Seed a recurring UNAVAILABLE marker for Wednesday (dayOfWeek=2).
    await app.prisma.employeeAvailability.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: TARGET_DOW,
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

  // Reset toggle to default ON + drop any shifts created by previous tests.
  beforeEach(async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { availabilityEnabled: true },
    });
    await app.prisma.shift.deleteMany({
      where: { employeeId: data.employee.id, date: new Date(TARGET_ISO + "T00:00:00Z") },
    });
  });

  // ── Test 1: UNAVAILABLE blocks without force ─────────────────────────────
  it("returns 409 SHIFT_CONFLICT_UNAVAILABILITY when UNAVAILABLE row applies and no force", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: TARGET_ISO,
        startTime: "08:00",
        endTime: "16:00",
      },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("SHIFT_CONFLICT_UNAVAILABILITY");
    expect(body.canForce).toBe(true);
    expect(body.error).toBeDefined();
    expect(body.message).toBeDefined();

    // No shift row written.
    const shifts = await app.prisma.shift.findMany({
      where: { employeeId: data.employee.id, date: new Date(TARGET_ISO + "T00:00:00Z") },
    });
    expect(shifts).toHaveLength(0);
  });

  // ── Test 2: force=true writes + audit ────────────────────────────────────
  it("writes shift + SHIFT_FORCED_OVER_UNAVAILABILITY audit when ?force=true", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts?force=true",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: TARGET_ISO,
        startTime: "08:00",
        endTime: "16:00",
      },
    });

    expect(res.statusCode).toBe(201);
    const shift = JSON.parse(res.body);
    expect(shift.id).toBeDefined();

    const audit = await app.prisma.auditLog.findFirst({
      where: {
        entity: "Shift",
        entityId: shift.id,
        action: "SHIFT_FORCED_OVER_UNAVAILABILITY",
      },
    });
    expect(audit).not.toBeNull();

    const audited = audit?.newValue as
      | {
          employeeId?: string;
          date?: string;
          availabilityId?: string;
          forcedByUserId?: string;
        }
      | undefined;
    expect(audited?.employeeId).toBe(data.employee.id);
    expect(audited?.date).toBe(TARGET_ISO);
    expect(audited?.availabilityId).toBeDefined();
    expect(audited?.forcedByUserId).toBeDefined();
  });

  // ── Test 3: Feature off bypasses entirely ────────────────────────────────
  it("availabilityEnabled=false: POST /shifts succeeds without force on UNAVAILABLE day", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { availabilityEnabled: false },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: TARGET_ISO,
        startTime: "08:00",
        endTime: "16:00",
      },
    });

    expect(res.statusCode).toBe(201);
    const shift = JSON.parse(res.body);
    expect(shift.id).toBeDefined();

    // No SHIFT_FORCED_OVER_UNAVAILABILITY audit fired (force was not needed).
    const audit = await app.prisma.auditLog.findFirst({
      where: {
        entity: "Shift",
        entityId: shift.id,
        action: "SHIFT_FORCED_OVER_UNAVAILABILITY",
      },
    });
    expect(audit).toBeNull();
  });
});
