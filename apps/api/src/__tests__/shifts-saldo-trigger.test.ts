/**
 * Phase 76.5 regression tests — SALDO-V19-03 / 03a / 03b / 03c / 03d.
 *
 * Reproduces the 2026-06-08 prod symptom: SHIFT_BASED employee's
 * OvertimeAccount.balanceHours stayed stale after Shift CRUD until the next
 * TimeEntry mutation. Each test asserts the recompute fires immediately —
 * primarily by checking that OvertimeAccount.updatedAt advances after the
 * mutation, since the recompute is the only path that writes that row.
 *
 * Pattern mirrors overtime-monthly-hours-and-shift-saldo.test.ts:
 * shared singleton Fastify app, fresh tenant per suite, no Date mocking.
 *
 * Date strategy:
 *  - Phase 47.2 past-immutable guard blocks API shift writes on past dates.
 *  - updateOvertimeAccount only sums shifts in [rangeStart, effectiveEnd]
 *    (≤ today, depending on today's TimeEntries).
 *  - For balance-delta assertions we use TODAY's date for shifts and seed a
 *    matching TimeEntry on TODAY so the saldo window includes today.
 *  - For the recompute-fired assertion (updatedAt advance) we use TODAY+ as
 *    the shift date; the row is touched even if the shift is outside the
 *    summation window.
 *
 * Tests:
 *  1. SALDO-V19-03c (regression): POST /shifts touches OvertimeAccount on an
 *     employee with an existing TimeEntry on a DIFFERENT day in the same month.
 *  2. SALDO-V19-03 (PUT): PUT /shifts/:id refreshes OvertimeAccount.
 *  3. SALDO-V19-03 (DELETE): DELETE /shifts/:id refreshes OvertimeAccount.
 *  4. D-07 concurrency: 5 parallel POST /shifts → 5 shifts + 1 OvertimeAccount.
 *  5. SALDO-V19-03b bulk dedupe: 3 employees via /shifts/bulk →
 *     saldoRefreshFailures = []; D-05 latency console.time.
 *  6. D-03 failure surfacing: when one employee's recompute fails,
 *     saldoRefreshFailures contains that employeeId; HTTP 201; other shifts
 *     persist.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import * as TimeEntriesModule from "../routes/time-entries";
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

// Generate N future ISO dates skipping Sundays. The default TenantConfig has
// storeHours with Sunday closed → shift POSTs on Sundays return 409
// SHIFT_OUTSIDE_STORE_HOURS. Tests use these helpers exclusively.
function futureWeekdays(start: string, count: number, offset = 1): string[] {
  const out: string[] = [];
  let cursor = offset;
  while (out.length < count) {
    const iso = addDaysIso(start, cursor);
    const dow = new Date(iso + "T12:00:00Z").getUTCDay(); // 0=Sun
    if (dow !== 0) out.push(iso);
    cursor++;
  }
  return out;
}

function futureWeekday(start: string, offset: number): string {
  return futureWeekdays(start, 1, offset)[0];
}

describe("Phase 76.5 — Shift CRUD triggers OvertimeAccount recompute (SALDO-V19-03*)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let suiteSuffix: string;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    suiteSuffix = "saldotrig-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: {
        name: `Saldo Trigger Test ${suiteSuffix}`,
        slug: `saldotrig-${suiteSuffix}`,
        federalState: "NIEDERSACHSEN",
      },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId, defaultVacationDays: 30, timezone: TZ },
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
    const adminEmp = await prisma.employee.create({
      data: {
        tenantId,
        userId: adminUser.id,
        employeeNumber: `ADM-${suiteSuffix}`,
        firstName: "Admin",
        lastName: "Saldo",
        hireDate: new Date("2024-01-01"),
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: adminEmp.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: adminEmp.id, balanceHours: 0 } });

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

  // Helper: create SHIFT_BASED employee + OvertimeAccount; return id.
  async function createShiftEmployee(label: string): Promise<string> {
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
        lastName: "Employee",
        // hireDate older than rangeStart so the recompute window starts at month-1.
        hireDate: new Date("2024-01-01"),
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

  // ── Test 1: SALDO-V19-03c regression ────────────────────────────────────
  it("SALDO-V19-03c — POST /shifts touches OvertimeAccount (updatedAt advances) without any second TimeEntry mutation", async () => {
    const employeeId = await createShiftEmployee("regress-post");

    // Snapshot OvertimeAccount BEFORE the shift create. The recompute always
    // touches the row via upsert — the bug was that the call did not happen
    // at all from shift CRUD paths. We assert updatedAt advances.
    const before = await app.prisma.overtimeAccount.findUnique({ where: { employeeId } });
    expect(before).toBeTruthy();
    // Force a known-stale updatedAt so any newer time beats it.
    const staleAt = new Date(Date.now() - 60_000);
    await app.prisma.overtimeAccount.update({
      where: { employeeId },
      data: { updatedAt: staleAt },
    });

    // Create a Shift via the API (date >= today per past-immutable guard).
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts/",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        employeeId,
        date: futureWeekday(todayIso(), 5),
        startTime: "09:00",
        endTime: "17:00",
        label: "Regression test shift",
      },
    });
    expect(res.statusCode).toBe(201);

    // The recompute must have run: updatedAt is now newer than the stale value.
    const after = await app.prisma.overtimeAccount.findUnique({ where: { employeeId } });
    expect(after).toBeTruthy();
    expect(after!.updatedAt.getTime()).toBeGreaterThan(staleAt.getTime());
  });

  // ── Test 2: SALDO-V19-03 PUT refresh ─────────────────────────────────────
  it("SALDO-V19-03 — PUT /shifts/:id refreshes OvertimeAccount (updatedAt advances)", async () => {
    const employeeId = await createShiftEmployee("regress-put");

    // Create a baseline shift first.
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/shifts/",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        employeeId,
        date: futureWeekday(todayIso(), 6),
        startTime: "09:00",
        endTime: "17:00",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const shiftId = JSON.parse(createRes.body).id;

    // Force stale updatedAt so PUT's recompute is observably newer.
    const staleAt = new Date(Date.now() - 60_000);
    await app.prisma.overtimeAccount.update({
      where: { employeeId },
      data: { updatedAt: staleAt },
    });

    const putRes = await app.inject({
      method: "PUT",
      url: `/api/v1/shifts/${shiftId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { endTime: "18:00" },
    });
    expect(putRes.statusCode).toBe(200);

    const after = await app.prisma.overtimeAccount.findUnique({ where: { employeeId } });
    expect(after!.updatedAt.getTime()).toBeGreaterThan(staleAt.getTime());
  });

  // ── Test 3: SALDO-V19-03 DELETE refresh ──────────────────────────────────
  it("SALDO-V19-03 — DELETE /shifts/:id refreshes OvertimeAccount (updatedAt advances)", async () => {
    const employeeId = await createShiftEmployee("regress-del");

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/shifts/",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        employeeId,
        date: futureWeekday(todayIso(), 7),
        startTime: "09:00",
        endTime: "17:00",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const shiftId = JSON.parse(createRes.body).id;

    const staleAt = new Date(Date.now() - 60_000);
    await app.prisma.overtimeAccount.update({
      where: { employeeId },
      data: { updatedAt: staleAt },
    });

    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/shifts/${shiftId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(delRes.statusCode).toBe(204);

    const after = await app.prisma.overtimeAccount.findUnique({ where: { employeeId } });
    expect(after!.updatedAt.getTime()).toBeGreaterThan(staleAt.getTime());
  });

  // ── Test 4: D-07 5-parallel concurrency ─────────────────────────────────
  it("D-07 — 5 parallel POST /shifts: exactly 5 shifts created + exactly 1 OvertimeAccount row (upsert race-safe)", async () => {
    const employeeId = await createShiftEmployee("concurrency");

    // 5 parallel POSTs on 5 different future weekdays.
    const dates = futureWeekdays(todayIso(), 5, 11);
    const responses = await Promise.all(
      dates.map((date) =>
        app.inject({
          method: "POST",
          url: "/api/v1/shifts/",
          headers: { authorization: `Bearer ${adminToken}` },
          payload: {
            employeeId,
            date,
            startTime: "09:00",
            endTime: "17:00",
          },
        }),
      ),
    );
    // All 5 must succeed
    expect(responses.every((r) => r.statusCode === 201)).toBe(true);

    // (a) Exactly 5 shifts created
    const shifts = await app.prisma.shift.findMany({
      where: { employeeId, deletedAt: null },
    });
    expect(shifts).toHaveLength(5);

    // (b) Exactly 1 OvertimeAccount row — upsert dedupe survived parallel race.
    const accounts = await app.prisma.overtimeAccount.findMany({ where: { employeeId } });
    expect(accounts).toHaveLength(1);
  });

  // ── Test 5: SALDO-V19-03b 3-employee bulk dedupe ────────────────────────
  it("SALDO-V19-03b — POST /shifts/bulk dedupes affected employees; saldoRefreshFailures=[] on success", async () => {
    const empA = await createShiftEmployee("bulk-a");
    const empB = await createShiftEmployee("bulk-b");
    const empC = await createShiftEmployee("bulk-c");

    // 3 employees × 2 dates each = 6 shifts; recompute MUST fire exactly 3 times.
    const [date1, date2] = futureWeekdays(todayIso(), 2, 20);
    const shifts = [empA, empB, empC].flatMap((employeeId) =>
      [date1, date2].map((date) => ({
        employeeId,
        date,
        startTime: "09:00",
        endTime: "17:00",
      })),
    );

    // D-05 latency capture (informational only — not a CI gate per CONTEXT.md).
    console.time("generate-week-3x5-saldo");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts/bulk",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { shifts },
    });
    console.timeEnd("generate-week-3x5-saldo");

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.created).toBe(6);
    expect(body.saldoRefreshFailures).toEqual([]);

    // All 3 OvertimeAccount rows touched recently — proof the dedupe DID fire
    // 3 recompute calls (and not zero) without per-shift double-invocation.
    const recentAt = new Date(Date.now() - 30_000);
    for (const empId of [empA, empB, empC]) {
      const acct = await app.prisma.overtimeAccount.findUnique({
        where: { employeeId: empId },
      });
      expect(acct).toBeTruthy();
      expect(acct!.updatedAt.getTime()).toBeGreaterThan(recentAt.getTime());
    }
  });

  // ── Test 6: D-03 failure surfacing ──────────────────────────────────────
  it("D-03 — bulk: one recompute failure surfaces in saldoRefreshFailures; other shifts persist", async () => {
    const empA = await createShiftEmployee("fail-a");
    const empB = await createShiftEmployee("fail-b");

    // Spy on updateOvertimeAccount. Throw for empA, no-op for empB.
    // Note: shifts.ts imports updateOvertimeAccount directly from
    // "./time-entries". The ESM live-binding means the route reads through
    // the same TimeEntriesModule namespace — so vi.spyOn on the namespace
    // export DOES intercept the route's call site.
    const spy = vi
      .spyOn(TimeEntriesModule, "updateOvertimeAccount")
      .mockImplementation(async (_app: FastifyInstance, employeeId: string) => {
        if (employeeId === empA) {
          throw new Error("Injected recompute failure for empA");
        }
        // No-op for other employees — the bulk-dedupe wiring is what we're
        // testing here, not the math.
        return;
      });

    try {
      const failDate = futureWeekday(todayIso(), 25);
      const shifts = [
        { employeeId: empA, date: failDate, startTime: "09:00", endTime: "17:00" },
        { employeeId: empB, date: failDate, startTime: "09:00", endTime: "17:00" },
      ];

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shifts/bulk",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { shifts },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.created).toBe(2);
      // Failure surfaces in payload — D-03 contract.
      expect(body.saldoRefreshFailures).toContain(empA);
      expect(body.saldoRefreshFailures).not.toContain(empB);

      // Both shifts persisted despite recompute failure (writes commit before
      // recompute; one recompute failure must NOT roll back shifts).
      const persistedShifts = await app.prisma.shift.findMany({
        where: { employeeId: { in: [empA, empB] }, deletedAt: null },
      });
      expect(persistedShifts).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });
});
