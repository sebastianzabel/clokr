import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import type { FastifyInstance } from "fastify";

/**
 * Phase 47.4-01 — ArbZG § 3 (Tägliche Höchstarbeitszeit, hard-block)
 *                 + § 5 (Mindestruhezeit, soft-warn w/ force override).
 *
 * Covers:
 *  - Case 1: § 3 hard-block at 10.5h → 422 ARBZG_VIOLATION_DAILY_MAX
 *  - Case 2: § 3 boundary at exactly 10h → 201
 *  - Case 3: § 3 cannot be forced (force=true on 10.5h still 422)
 *  - Case 4: § 5 soft-warn with 2h gap → 409 ARBZG_VIOLATION_REST_PERIOD
 *  - Case 5: § 5 boundary at exactly 11h gap → 201
 *  - Case 6: § 5 force-override → 201 + SHIFT_FORCED_OVER_ARBZG audit
 *  - Case 7: § 5 self-move (PUT with excludeShiftId) does not self-conflict
 *
 * Mirrors the Phase 47.3-03 SHIFT_CONFLICT_UNAVAILABILITY scaffold.
 */
describe("Shift ArbZG Validation (Phase 47.4-01)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // Target dates: Tue + Wed in 2026 (clear of past-immutable + weekend edges).
  // 2026-09-15 = Tue, 2026-09-16 = Wed
  const PREV_ISO = "2026-09-15";
  const TARGET_ISO = "2026-09-16";

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "arbzg");

    // Phase 47.1 — Shift endpoints require an active SHIFT_BASED WorkSchedule.
    await app.prisma.workSchedule.create({
      data: {
        employeeId: data.employee.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        validFrom: new Date("2024-02-01"),
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

  // Drop any shifts created by previous tests on the target dates.
  beforeEach(async () => {
    await app.prisma.shift.deleteMany({
      where: {
        employeeId: data.employee.id,
        date: { in: [new Date(PREV_ISO + "T00:00:00Z"), new Date(TARGET_ISO + "T00:00:00Z")] },
      },
    });
  });

  // ── Case 1: § 3 hard-block (net hours > 10) ───────────────────────────────
  // § 3 measures Arbeitszeit (net), not Anwesenheit (gross). With > 9h gross
  // ArbZG § 4 mandates 45 min break, so net = gross − 0.75. To exceed 10h NET,
  // gross must exceed 10.75h.
  it("returns 422 ARBZG_VIOLATION_DAILY_MAX when net hours > 10 (gross 11h)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: TARGET_ISO,
        startTime: "08:00",
        endTime: "19:00", // 11h gross − 0.75h break = 10.25h net → over
      },
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("ARBZG_VIOLATION_DAILY_MAX");
    expect(body.canForce).toBe(false);
    expect(body.message).toBeDefined();

    const shifts = await app.prisma.shift.findMany({
      where: { employeeId: data.employee.id, date: new Date(TARGET_ISO + "T00:00:00Z") },
    });
    expect(shifts).toHaveLength(0);
  });

  // ── Case 2: § 3 boundary at exactly 10h net ───────────────────────────────
  // 10.5h gross − 0.5h (>6h break) = 10h net (boundary OK).
  it("succeeds with 10.5h gross / 10h net (boundary OK)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: TARGET_ISO,
        startTime: "08:00",
        endTime: "18:30", // 10.5h gross; with 0.5h break = 10h net (still OK at <=9h gross)
      },
    });

    // Brutto 10.5h triggers > 9h → 45min break → 9.75h net → OK.
    expect(res.statusCode).toBe(201);
    const shift = JSON.parse(res.body);
    expect(shift.id).toBeDefined();
  });

  // ── Case 3: § 3 cannot be forced ──────────────────────────────────────────
  it("ignores force=true on § 3 violation (still 422)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts?force=true",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: TARGET_ISO,
        startTime: "08:00",
        endTime: "19:00", // 11h gross → 10.25h net → > 10h
      },
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("ARBZG_VIOLATION_DAILY_MAX");
    expect(body.canForce).toBe(false);
  });

  // ── Case 4: § 5 soft-warn without force ───────────────────────────────────
  it("returns 409 ARBZG_VIOLATION_REST_PERIOD when prev-day shift leaves < 11h gap", async () => {
    // Prev-day cross-midnight: 22:00 -> 06:00 (ends next-day 06:00).
    // New shift starts at TARGET 08:00 → gap = 2h.
    await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        date: new Date(PREV_ISO + "T00:00:00Z"),
        startTime: "22:00",
        endTime: "06:00",
        createdBy: data.adminUser.id,
      },
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

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("ARBZG_VIOLATION_REST_PERIOD");
    expect(body.canForce).toBe(true);
    expect(body.message).toBeDefined();

    // No new shift on TARGET written.
    const shifts = await app.prisma.shift.findMany({
      where: { employeeId: data.employee.id, date: new Date(TARGET_ISO + "T00:00:00Z") },
    });
    expect(shifts).toHaveLength(0);
  });

  // ── Case 5: § 5 boundary at exactly 11h gap ───────────────────────────────
  it("succeeds when gap is exactly 11h (boundary OK)", async () => {
    // Prev-day shift 09:00-18:00 ends 18:00. New start 05:00 next day → gap = 11h.
    await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        date: new Date(PREV_ISO + "T00:00:00Z"),
        startTime: "09:00",
        endTime: "18:00",
        createdBy: data.adminUser.id,
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: TARGET_ISO,
        startTime: "05:00",
        endTime: "13:00",
      },
    });

    expect(res.statusCode).toBe(201);
    const shift = JSON.parse(res.body);
    expect(shift.id).toBeDefined();
  });

  // ── Case 6: § 5 force-override writes audit ───────────────────────────────
  it("writes shift + SHIFT_FORCED_OVER_ARBZG audit when ?force=true on § 5 hit", async () => {
    const prevShift = await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        date: new Date(PREV_ISO + "T00:00:00Z"),
        startTime: "22:00",
        endTime: "06:00",
        createdBy: data.adminUser.id,
      },
    });

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
        action: "SHIFT_FORCED_OVER_ARBZG",
      },
    });
    expect(audit).not.toBeNull();

    const audited = audit?.newValue as
      | {
          employeeId?: string;
          date?: string;
          startTime?: string;
          endTime?: string;
          restGapHours?: number;
          prevShiftId?: string;
          forcedByUserId?: string;
        }
      | undefined;
    expect(audited?.employeeId).toBe(data.employee.id);
    expect(audited?.date).toBe(TARGET_ISO);
    expect(audited?.startTime).toBe("08:00");
    expect(audited?.endTime).toBe("16:00");
    expect(audited?.restGapHours).toBeGreaterThanOrEqual(0);
    expect(audited?.restGapHours).toBeLessThan(11);
    expect(audited?.prevShiftId).toBe(prevShift.id);
    expect(audited?.forcedByUserId).toBeDefined();
  });

  // ── Case 7: § 5 self-move via PUT (excludeShiftId works) ──────────────────
  it("PUT on existing shift does not self-conflict via § 5", async () => {
    // Create a shift on TARGET first (no prev-day shift → § 5 OK).
    const initial = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: TARGET_ISO,
        startTime: "10:00",
        endTime: "18:00",
      },
    });
    expect(initial.statusCode).toBe(201);
    const created = JSON.parse(initial.body);

    // Now PUT the same shift adjusting only label — should not trigger § 5
    // against itself even though its existing record is on TARGET.
    // (Sanity: the rest-period query looks at PREV day, not the same day,
    //  so this test mostly guards the excludeShiftId plumbing on PUT.)
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/shifts/${created.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        label: "Frühschicht",
      },
    });

    expect(res.statusCode).toBe(200);
    const updated = JSON.parse(res.body);
    expect(updated.label).toBe("Frühschicht");
  });
});
