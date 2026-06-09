/**
 * Phase 76.10 regression tests — ARBZG-V19-02.
 *
 * Verifies that `assertArbZGDailyMax` in apps/api/src/routes/shifts.ts
 * consults Employee.breakOver6hOverride / breakOver9hOverride via the
 * shared `getEffectiveBreakDuration` utility instead of the previous
 * hardcoded 30/45-minute floor.
 *
 * Pattern mirrors shifts-saldo-trigger.test.ts (Phase 76.5 sibling):
 *  - Shared singleton Fastify app via getTestApp()
 *  - Fresh tenant per suite, ADMIN user for POST/PUT writes
 *  - Future weekdays only (Sunday closed in default storeHours)
 *
 * Tests:
 *  A. POST /shifts — 11h shift with breakOver9hOverride=60 → 201 created
 *     (net = 11h − 1h = 10.0h, exactly the boundary, legal).
 *  B. POST /shifts — 11h shift with no override + TenantConfig default 45 →
 *     422 ARBZG_VIOLATION_DAILY_MAX (net = 11h − 0.75h = 10.25h > 10h).
 *  C. PUT /shifts/:id — extend 8h shift to 11h with breakOver9hOverride=60 →
 *     200 updated (same boundary as A).
 *  D. POST /shifts — 12h shift with breakOver9hOverride=60 → 422 (net = 11h),
 *     proves the validator still rejects truly illegal cases.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";

const TZ = "Europe/Berlin";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Skip Sundays (Sunday is closed in default storeHours → 409 SHIFT_OUTSIDE_STORE_HOURS).
function futureWeekday(start: string, offset: number): string {
  let cursor = offset;
  for (;;) {
    const iso = addDaysIso(start, cursor);
    const dow = new Date(iso + "T12:00:00Z").getUTCDay(); // 0 = Sunday
    if (dow !== 0) return iso;
    cursor++;
  }
}

describe("Phase 76.10 — ArbZG § 3 daily-max honors employee break override (ARBZG-V19-02)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let suiteSuffix: string;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    suiteSuffix = "arbzg-bo-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: {
        name: `ArbZG Break Override Test ${suiteSuffix}`,
        slug: `arbzg-bo-${suiteSuffix}`,
        federalState: "NIEDERSACHSEN",
      },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: {
        tenantId,
        defaultVacationDays: 30,
        timezone: TZ,
        // schema defaults: defaultBreakOver6h=30, defaultBreakOver9h=45 — leave as-is
      },
    });

    // Admin user — required for ADMIN-only shift CRUD writes.
    const adminPasswordHash = await bcrypt.hash("test1234", 10);
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${suiteSuffix}@test.de`,
        passwordHash: adminPasswordHash,
        role: "ADMIN",
        isActive: true,
      },
    });
    await prisma.employee.create({
      data: {
        tenantId,
        userId: adminUser.id,
        employeeNumber: `ADM-${suiteSuffix}`,
        firstName: "Admin",
        lastName: "BreakOverride",
        hireDate: new Date("2024-01-01"),
      },
    });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: adminUser.email, password: "test1234" },
    });
    adminToken = JSON.parse(loginRes.body).accessToken;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  /**
   * Helper: create a SHIFT_BASED employee with optional break overrides.
   */
  async function createShiftEmployee(
    label: string,
    overrides: { breakOver6hOverride?: number | null; breakOver9hOverride?: number | null } = {},
  ): Promise<string> {
    const prisma = app.prisma;
    const empUser = await prisma.user.create({
      data: {
        email: `emp-${label}-${suiteSuffix}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: empUser.id,
        employeeNumber: `SH-${label}-${suiteSuffix}`,
        firstName: `Shift${label}`,
        lastName: "BreakOverride",
        hireDate: new Date("2024-01-01"),
        breakOver6hOverride: overrides.breakOver6hOverride ?? null,
        breakOver9hOverride: overrides.breakOver9hOverride ?? null,
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        monthlyHours: null,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    return emp.id;
  }

  // ── Test A: POST + 60min override accepts 11h shift (10.0h net = boundary OK) ──
  it("ARBZG-V19-02 A — POST /shifts: 11h shift with breakOver9hOverride=60 accepted (net 10.0h)", async () => {
    const employeeId = await createShiftEmployee("post-override", { breakOver9hOverride: 60 });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts/",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        employeeId,
        date: futureWeekday(todayIso(), 1),
        startTime: "08:00",
        endTime: "19:00", // 11h gross
        label: "ArbZG override boundary",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBeTruthy();

    // Confirm the Shift row exists (deletedAt:null per CLAUDE.md soft-delete rule).
    const shift = await app.prisma.shift.findFirst({
      where: { id: body.id, deletedAt: null },
    });
    expect(shift).toBeTruthy();
    expect(shift!.startTime).toBe("08:00");
    expect(shift!.endTime).toBe("19:00");
  });

  // ── Test B: POST + no override → tenant default 45min → 11h shift rejected (10.25h net) ──
  it("ARBZG-V19-02 B — POST /shifts: 11h shift with no override (TenantConfig=45min) rejected (net 10.25h)", async () => {
    const employeeId = await createShiftEmployee("post-no-override", {
      breakOver9hOverride: null,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts/",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        employeeId,
        date: futureWeekday(todayIso(), 2),
        startTime: "08:00",
        endTime: "19:00", // 11h gross → 10.25h net (> 10h)
        label: "ArbZG default-floor reject",
      },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("ARBZG_VIOLATION_DAILY_MAX");
    expect(body.canForce).toBe(false);

    // Defence in depth: no Shift row was created.
    const shiftCount = await app.prisma.shift.count({
      where: { employeeId, deletedAt: null },
    });
    expect(shiftCount).toBe(0);
  });

  // ── Test C: PUT + 60min override extends 8h shift to 11h (10.0h net = boundary OK) ──
  it("ARBZG-V19-02 C — PUT /shifts/:id: extend 8h → 11h with breakOver9hOverride=60 accepted", async () => {
    const employeeId = await createShiftEmployee("put-override", { breakOver9hOverride: 60 });

    // Seed an 8h shift (legal even with no override: 8h gross < 9h threshold).
    const date = futureWeekday(todayIso(), 3);
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/shifts/",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        employeeId,
        date,
        startTime: "08:00",
        endTime: "16:00", // 8h gross — legal
      },
    });
    expect(createRes.statusCode).toBe(201);
    const shiftId = JSON.parse(createRes.body).id;

    // PUT to extend to 11h gross — only legal because employee override = 60min.
    const putRes = await app.inject({
      method: "PUT",
      url: `/api/v1/shifts/${shiftId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { endTime: "19:00" },
    });
    expect(putRes.statusCode).toBe(200);
    const updated = JSON.parse(putRes.body);
    expect(updated.endTime).toBe("19:00");

    const fresh = await app.prisma.shift.findFirst({
      where: { id: shiftId, deletedAt: null },
    });
    expect(fresh!.endTime).toBe("19:00");
  });

  // ── Test D: POST + 60min override still rejects 12h shift (11.0h net > 10h) ──
  it("ARBZG-V19-02 D — POST /shifts: 12h shift with breakOver9hOverride=60 still rejected (net 11.0h)", async () => {
    const employeeId = await createShiftEmployee("post-illegal", { breakOver9hOverride: 60 });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts/",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        employeeId,
        date: futureWeekday(todayIso(), 4),
        startTime: "08:00",
        endTime: "20:00", // 12h gross → 11h net (> 10h even with 60min override)
        label: "ArbZG override-but-still-illegal",
      },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("ARBZG_VIOLATION_DAILY_MAX");

    const shiftCount = await app.prisma.shift.count({
      where: { employeeId, deletedAt: null },
    });
    expect(shiftCount).toBe(0);
  });
});
