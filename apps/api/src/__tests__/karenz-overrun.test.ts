/**
 * karenz-overrun.test.ts
 *
 * Phase 104 (R4 / R5 / D-21 / D-22 / D-23 / D-24) — the § 5 EFZG Karenztage detector.
 *
 * Test file structure:
 *  - "find-karenz-overrun-days — detector" describe: Tests 1-9 (Task 1) — pure funnel
 *    behaviour + the D-23 structural zero-import assertion.
 *  - "Monatsabschluss wiring" describe: Tests 1-7 (Task 2) — GET /close-month/status wiring,
 *    hint-only behaviour, auto-close non-interference, N+1 safety.
 *
 *  - "tenant config range" describe: Tests 1-3 (Task 3) — the settings.ts 0-3 range + legacy
 *    clamp on read.
 *
 * R5's own explicitly-named test lives in section9-invariants.test.ts, NOT here (per the plan) —
 * this file covers the detector's mechanics, that file covers the phase's legal invariants.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import {
  karenzOverrunFromRequests,
  normalizeKarenzDays,
  MAX_KARENZ_DAYS,
  type KarenzSickRow,
} from "../utils/find-karenz-overrun-days";

function sickRow(overrides: Partial<KarenzSickRow> = {}): KarenzSickRow {
  return {
    id: "sick-1",
    startDate: new Date("2026-06-01"),
    endDate: new Date("2026-06-05"),
    status: "APPROVED",
    attestPresent: false,
    attestValidFrom: null,
    attestValidTo: null,
    leaveType: { name: "Krankmeldung" },
    deletedAt: null,
    ...overrides,
  };
}

describe("find-karenz-overrun-days — detector", () => {
  it("Test 1: a 5-calendar-day sick period without an Attest and threshold 3 is an overrun", () => {
    const rows = [sickRow({ startDate: new Date("2026-06-01"), endDate: new Date("2026-06-05") })];
    const result = karenzOverrunFromRequests(rows, "Europe/Berlin", 3);
    expect(result).toHaveLength(1);
    expect(result[0].days).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
      "2026-06-04",
      "2026-06-05",
    ]);
  });

  it('Test 2: exactly 3 calendar days with threshold 3 is NOT an overrun ("länger als")', () => {
    const rows = [sickRow({ startDate: new Date("2026-06-01"), endDate: new Date("2026-06-03") })];
    const result = karenzOverrunFromRequests(rows, "Europe/Berlin", 3);
    expect(result).toHaveLength(0);
  });

  it("Test 3: counting is calendar days, not workdays — a Fri-Tue period is 5, not 3", () => {
    // 2026-06-05 is a Friday; 2026-06-09 is the following Tuesday. 5 calendar days
    // (Fri, Sat, Sun, Mon, Tue) even though the weekend is not worked.
    const rows = [sickRow({ startDate: new Date("2026-06-05"), endDate: new Date("2026-06-09") })];
    const result = karenzOverrunFromRequests(rows, "Europe/Berlin", 3);
    expect(result).toHaveLength(1);
    expect(result[0].days).toHaveLength(5);
  });

  it("Test 4: threshold 0 means every sick day needs an Attest", () => {
    const rows = [sickRow({ startDate: new Date("2026-06-01"), endDate: new Date("2026-06-01") })];
    const result = karenzOverrunFromRequests(rows, "Europe/Berlin", 0);
    expect(result).toHaveLength(1);
    expect(result[0].days).toEqual(["2026-06-01"]);
  });

  it("Test 5: a fully-attested period is never an overrun", () => {
    const rows = [
      sickRow({
        startDate: new Date("2026-06-01"),
        endDate: new Date("2026-06-05"),
        attestPresent: true,
        attestValidFrom: new Date("2026-06-01"),
        attestValidTo: new Date("2026-06-05"),
      }),
    ];
    const result = karenzOverrunFromRequests(rows, "Europe/Berlin", 3);
    expect(result).toHaveLength(0);
  });

  it("Test 6: a partial Attest narrower than the period reports only the uncovered days", () => {
    const rows = [
      sickRow({
        startDate: new Date("2026-06-01"),
        endDate: new Date("2026-06-05"),
        attestPresent: true,
        attestValidFrom: new Date("2026-06-04"),
        attestValidTo: new Date("2026-06-05"),
      }),
    ];
    const result = karenzOverrunFromRequests(rows, "Europe/Berlin", 3);
    expect(result).toHaveLength(1);
    expect(result[0].days).toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);
  });

  it("Test 7: non-sick leave types are never reported", () => {
    const rows = [
      sickRow({
        leaveType: { name: "Urlaub" },
        startDate: new Date("2026-06-01"),
        endDate: new Date("2026-06-10"),
      }),
    ];
    const result = karenzOverrunFromRequests(rows, "Europe/Berlin", 3);
    expect(result).toHaveLength(0);
  });

  it("Test 8: a legacy tenant value above 3 is clamped to 3 on read, not rejected", () => {
    expect(normalizeKarenzDays(30)).toBe(3);
    expect(normalizeKarenzDays(10)).toBe(3);
    expect(normalizeKarenzDays(3)).toBe(3);
    expect(normalizeKarenzDays(0)).toBe(0);
    expect(normalizeKarenzDays(-5)).toBe(0);
    expect(normalizeKarenzDays(null)).toBe(MAX_KARENZ_DAYS);
    expect(normalizeKarenzDays(undefined)).toBe(MAX_KARENZ_DAYS);

    // A 4-calendar-day period is an overrun under a legacy value of 30 ONLY if the module
    // clamps first — proves the clamp is actually exercised inside the detector, not just
    // in the standalone helper.
    const rows = [sickRow({ startDate: new Date("2026-06-01"), endDate: new Date("2026-06-04") })];
    const result = karenzOverrunFromRequests(rows, "Europe/Berlin", 30);
    expect(result).toHaveLength(1);
  });

  it("Test 9 (D-23 structural boundary): the module source contains no import statement", () => {
    const src = readFileSync(
      join(__dirname, "..", "utils", "find-karenz-overrun-days.ts"),
      "utf-8",
    );
    expect(/^\s*import\s/m.test(src)).toBe(false);
  });
});

// ── Task 2/3 shared fixture helpers ──────────────────────────────────────────

const JUNE_2026_START = "2026-06-01";
const JUNE_2026_END = "2026-06-30";

function monFriInRange(fromStr: string, toStr: string): string[] {
  const out: string[] = [];
  const cur = new Date(fromStr + "T00:00:00Z");
  const end = new Date(toStr + "T00:00:00Z");
  while (cur <= end) {
    const dow = cur.getUTCDay();
    if (dow >= 1 && dow <= 5) out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}
const JUNE_WORKDAYS = monFriInRange(JUNE_2026_START, JUNE_2026_END);

async function seedFullMonthEntry(app: FastifyInstance, empId: string, dateStr: string) {
  await app.prisma.timeEntry.create({
    data: {
      employeeId: empId,
      date: new Date(dateStr + "T00:00:00Z"),
      startTime: new Date(dateStr + "T07:00:00Z"),
      endTime: new Date(dateStr + "T15:30:00Z"),
      breakMinutes: 30,
      type: "WORK",
    },
  });
}

/** Isolated tenant + admin + one FIXED_SCHEDULE employee, hireDate = June 1 2026 (avoids
 * the sequential-close guard and the 00:00-02:00 today-relative flake window entirely). */
async function seedKarenzFixture(app: FastifyInstance, suffix: string) {
  const prisma = app.prisma;
  const tenant = await prisma.tenant.create({
    data: {
      name: `Karenz Test ${suffix}`,
      slug: `karenz-${suffix}`,
      federalState: "NIEDERSACHSEN",
    },
  });
  await prisma.tenantConfig.create({
    data: { tenantId: tenant.id, defaultVacationDays: 30, timezone: "Europe/Berlin" },
  });
  const adminUser = await prisma.user.create({
    data: {
      email: `karenz-admin-${suffix}@test.de`,
      passwordHash: await bcrypt.hash("test1234", 10),
      role: "ADMIN",
      isActive: true,
    },
  });
  const adminEmployee = await prisma.employee.create({
    data: {
      tenantId: tenant.id,
      userId: adminUser.id,
      employeeNumber: `KA-${suffix}`,
      firstName: "Admin",
      lastName: suffix,
      hireDate: new Date("2026-06-01T00:00:00Z"),
    },
  });

  await prisma.workSchedule.create({
    data: {
      employeeId: adminEmployee.id,
      type: "FIXED_SCHEDULE",
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      workDays: [1, 2, 3, 4, 5],
      validFrom: new Date("2026-06-01T00:00:00Z"),
    },
  });
  await prisma.overtimeAccount.create({ data: { employeeId: adminEmployee.id, balanceHours: 0 } });

  const empUser = await prisma.user.create({
    data: {
      email: `karenz-emp-${suffix}@test.de`,
      passwordHash: await bcrypt.hash("test1234", 10),
      role: "EMPLOYEE",
      isActive: true,
    },
  });
  const employee = await prisma.employee.create({
    data: {
      tenantId: tenant.id,
      userId: empUser.id,
      employeeNumber: `KE-${suffix}`,
      firstName: "Karenz",
      lastName: suffix,
      hireDate: new Date("2026-06-01T00:00:00Z"),
    },
  });
  await prisma.workSchedule.create({
    data: {
      employeeId: employee.id,
      type: "FIXED_SCHEDULE",
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      workDays: [1, 2, 3, 4, 5],
      validFrom: new Date("2026-06-01T00:00:00Z"),
    },
  });
  await prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });

  // Seed a full month of entries so the gap-detector reports "ready" (no confirmGaps needed).
  for (const d of JUNE_WORKDAYS) {
    await seedFullMonthEntry(app, employee.id, d);
  }

  const sickType = await prisma.leaveType.create({
    data: {
      tenantId: tenant.id,
      name: "Krankmeldung",
      isPaid: true,
      requiresApproval: true,
      color: "#EF4444",
    },
  });

  const loginRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: `karenz-admin-${suffix}@test.de`, password: "test1234" },
  });
  const { accessToken: adminToken } = JSON.parse(loginRes.body);

  const empLoginRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: `karenz-emp-${suffix}@test.de`, password: "test1234" },
  });
  const { accessToken: empToken } = JSON.parse(empLoginRes.body);

  return { tenant, adminEmployee, adminToken, employee, empToken, sickType };
}

async function approveSick(
  app: FastifyInstance,
  employeeId: string,
  leaveTypeId: string,
  startDate: string,
  endDate: string,
  attestPresent = false,
) {
  return app.prisma.leaveRequest.create({
    data: {
      employeeId,
      leaveTypeId,
      startDate: new Date(startDate + "T00:00:00Z"),
      endDate: new Date(endDate + "T00:00:00Z"),
      days: 1,
      status: "APPROVED",
      attestPresent,
    },
  });
}

// ── Task 2: Monatsabschluss wiring ───────────────────────────────────────────

describe("Monatsabschluss wiring", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it("Test 1: GET /close-month/status includes karenzOverrunDays per employee", async () => {
    const fx = await seedKarenzFixture(app, "t1");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: fx.tenant.id },
        data: { sickNoteRequiredAfterDays: 3 },
      });
      await approveSick(app, fx.employee.id, fx.sickType.id, "2026-06-01", "2026-06-05");

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/overtime/close-month/status?year=2026&month=6",
        headers: { authorization: `Bearer ${fx.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const empResult = body.employees.find(
        (e: { employeeId: string }) => e.employeeId === fx.employee.id,
      );
      expect(empResult).toBeDefined();
      expect(Array.isArray(empResult.karenzOverrunDays)).toBe(true);
      expect(empResult.karenzOverrunDays.length).toBeGreaterThan(0);
    } finally {
      await cleanupTestData(app, fx.tenant.id);
    }
  });

  it("Test 2: an overrun is additive — status stays as computed, not forced by the finding", async () => {
    const fx = await seedKarenzFixture(app, "t2");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: fx.tenant.id },
        data: { sickNoteRequiredAfterDays: 3 },
      });
      await approveSick(app, fx.employee.id, fx.sickType.id, "2026-06-01", "2026-06-05");

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/overtime/close-month/status?year=2026&month=6",
        headers: { authorization: `Bearer ${fx.adminToken}` },
      });
      const body = res.json();
      const empResult = body.employees.find(
        (e: { employeeId: string }) => e.employeeId === fx.employee.id,
      );
      // Full month of entries seeded → the gap-based status must remain "ready" —
      // the Karenz finding is additive, never a status change (D-21).
      expect(empResult.status).toBe("ready");
      expect(empResult.karenzOverrunDays.length).toBeGreaterThan(0);
    } finally {
      await cleanupTestData(app, fx.tenant.id);
    }
  });

  it("Test 3: a CLOSED month reports karenzOverrunDays: [] (Pitfall 1)", async () => {
    const fx = await seedKarenzFixture(app, "t3");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: fx.tenant.id },
        data: { sickNoteRequiredAfterDays: 3 },
      });
      await approveSick(app, fx.employee.id, fx.sickType.id, "2026-06-01", "2026-06-05");

      const closeRes = await app.inject({
        method: "POST",
        url: "/api/v1/overtime/close-month",
        headers: { authorization: `Bearer ${fx.adminToken}` },
        payload: { employeeId: fx.employee.id, year: 2026, month: 6 },
      });
      expect(closeRes.statusCode).toBe(201);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/overtime/close-month/status?year=2026&month=6",
        headers: { authorization: `Bearer ${fx.adminToken}` },
      });
      const body = res.json();
      const empResult = body.employees.find(
        (e: { employeeId: string }) => e.employeeId === fx.employee.id,
      );
      expect(empResult.status).toBe("closed");
      expect(empResult.karenzOverrunDays).toEqual([]);
    } finally {
      await cleanupTestData(app, fx.tenant.id);
    }
  });

  it("Test 4: POST /close-month still returns 201 with Karenz overruns present — no gate exists", async () => {
    const fx = await seedKarenzFixture(app, "t4");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: fx.tenant.id },
        data: { sickNoteRequiredAfterDays: 3 },
      });
      await approveSick(app, fx.employee.id, fx.sickType.id, "2026-06-01", "2026-06-05");

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/overtime/close-month",
        headers: { authorization: `Bearer ${fx.adminToken}` },
        payload: { employeeId: fx.employee.id, year: 2026, month: 6 },
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await cleanupTestData(app, fx.tenant.id);
    }
  });

  it("Test 5: the auto-close cron does not defer a month because of a Karenz overrun", async () => {
    const fx = await seedKarenzFixture(app, "t5");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: fx.tenant.id },
        data: { sickNoteRequiredAfterDays: 3, closeMonthWithGapsAllowed: true },
      });
      await approveSick(app, fx.employee.id, fx.sickType.id, "2026-06-01", "2026-06-05");

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-07-16T06:00:00.000Z")); // well past the retro window
      try {
        await app.tryAutoCloseMonth();
      } finally {
        vi.useRealTimers();
      }

      // Convention-robust: TZ-converted periodStart for June/Europe-Berlin lands on the
      // last UTC day of May (see overtime.ts's isPeriodStartInMonth comment) — match on
      // periodEnd instead of a brittle exact periodStart.
      const snapshot = await app.prisma.saldoSnapshot.findFirst({
        where: {
          employeeId: fx.employee.id,
          periodType: "MONTHLY",
          periodEnd: new Date("2026-06-30T00:00:00.000Z"),
          superseded: false,
        },
      });
      expect(snapshot).not.toBeNull();
      expect(snapshot?.note).not.toMatch(/karenz/i);
    } finally {
      await cleanupTestData(app, fx.tenant.id);
    }
  });

  it("Test 6: threshold 0 surfaces every certificate-less sick day", async () => {
    const fx = await seedKarenzFixture(app, "t6");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: fx.tenant.id },
        data: { sickNoteRequiredAfterDays: 0 },
      });
      await approveSick(app, fx.employee.id, fx.sickType.id, "2026-06-10", "2026-06-10");

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/overtime/close-month/status?year=2026&month=6",
        headers: { authorization: `Bearer ${fx.adminToken}` },
      });
      const body = res.json();
      const empResult = body.employees.find(
        (e: { employeeId: string }) => e.employeeId === fx.employee.id,
      );
      expect(empResult.karenzOverrunDays).toContain("2026-06-10");
    } finally {
      await cleanupTestData(app, fx.tenant.id);
    }
  });

  it("Test 7: the status endpoint responds correctly with the bulk-fetch pattern (no per-employee query)", async () => {
    const fx = await seedKarenzFixture(app, "t7");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: fx.tenant.id },
        data: { sickNoteRequiredAfterDays: 3 },
      });
      await approveSick(app, fx.employee.id, fx.sickType.id, "2026-06-01", "2026-06-05");

      // N+1-freedom is asserted structurally in the acceptance criteria (sickByEmp's
      // assignment line is below the `for (const emp of employees)` loop line) — this
      // test is the behavioural sanity check that the bulk-fetch path still works.
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/overtime/close-month/status?year=2026&month=6",
        headers: { authorization: `Bearer ${fx.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await cleanupTestData(app, fx.tenant.id);
    }
  });
});

// ── Task 3: tenant config range (settings.ts, D-22) ──────────────────────────

describe("tenant config range — sickNoteRequiredAfterDays (D-22)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it("Test 1: accepts sickNoteRequiredAfterDays 0 and 3", async () => {
    const fx = await seedKarenzFixture(app, "cfg1");
    try {
      for (const value of [0, 3]) {
        const res = await app.inject({
          method: "PUT",
          url: "/api/v1/settings/work",
          headers: { authorization: `Bearer ${fx.adminToken}` },
          payload: { sickNoteRequiredAfterDays: value },
        });
        expect(res.statusCode).toBe(200);
      }
    } finally {
      await cleanupTestData(app, fx.tenant.id);
    }
  });

  it("Test 2: rejects 4 and 30 with a 400", async () => {
    const fx = await seedKarenzFixture(app, "cfg2");
    try {
      for (const value of [4, 30]) {
        const res = await app.inject({
          method: "PUT",
          url: "/api/v1/settings/work",
          headers: { authorization: `Bearer ${fx.adminToken}` },
          payload: { sickNoteRequiredAfterDays: value },
        });
        expect(res.statusCode).toBe(400);
      }
    } finally {
      await cleanupTestData(app, fx.tenant.id);
    }
  });

  it("Test 3: a legacy value above 3 still loads unmigrated and is clamped to 3 by normalizeKarenzDays", async () => {
    const fx = await seedKarenzFixture(app, "cfg3");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: fx.tenant.id },
        data: { sickNoteRequiredAfterDays: 15 },
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/settings/work",
        headers: { authorization: `Bearer ${fx.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().sickNoteRequiredAfterDays).toBe(15); // read-side only, no forced write

      expect(normalizeKarenzDays(res.json().sickNoteRequiredAfterDays)).toBe(3);
    } finally {
      await cleanupTestData(app, fx.tenant.id);
    }
  });

  // Phase 104 code review WR-08: the field was .optional() but not .nullable(). Clokr
  // frontends send `x ? x : null` and Svelte's bind:value yields null for a cleared number
  // input, so an explicit null was reachable — and rejected the WHOLE ~40-field PUT with a
  // bare "Validierungsfehler". The column is `Int @default(3)` NOT NULL, so the null must be
  // normalized in the handler rather than passed through to Prisma (which would 500).
  it("Test 4 (WR-08): an explicit null resets to the default 3 instead of failing the whole save", async () => {
    const fx = await seedKarenzFixture(app, "cfg4");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: fx.tenant.id },
        data: { sickNoteRequiredAfterDays: 1 },
      });

      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/settings/work",
        headers: { authorization: `Bearer ${fx.adminToken}` },
        // A realistic multi-field save from the admin form, with the number input cleared.
        payload: { sickNoteRequiredAfterDays: null, vacationLeadTimeDays: 7 },
      });
      expect(res.statusCode).toBe(200);

      const cfg = await app.prisma.tenantConfig.findUniqueOrThrow({
        where: { tenantId: fx.tenant.id },
      });
      expect(cfg.sickNoteRequiredAfterDays).toBe(3);
      // The rest of the save landed — the point of the fix is that one cleared input no
      // longer discards every other setting on the page.
      expect(cfg.vacationLeadTimeDays).toBe(7);
    } finally {
      await cleanupTestData(app, fx.tenant.id);
    }
  });
});

// ── Task 1 (gap closure, plan 104-11): GET /leave/karenz-overrun — self-service Hinweis (D-21) ──

/** YYYY-MM-DD, `n` days before today (UTC). Keeps this suite free of date time bombs and away
 *  from the documented 00:00-02:00 "today"-boundary flake window. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

describe("Self-service Hinweis (D-21)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it("Test 1: an employee's own 5-day attest-less Krankmeldung is an overrun", async () => {
    const fx = await seedKarenzFixture(app, "d21-1");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: fx.tenant.id },
        data: { sickNoteRequiredAfterDays: 3 },
      });
      const sickReq = await approveSick(
        app,
        fx.employee.id,
        fx.sickType.id,
        daysAgo(10),
        daysAgo(6),
      );

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/leave/karenz-overrun",
        headers: { authorization: `Bearer ${fx.empToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.totalDays).toBe(5);
      expect(body.overruns).toHaveLength(1);
      expect(body.overruns[0].leaveRequestId).toBe(sickReq.id);
    } finally {
      await cleanupTestData(app, fx.tenant.id);
    }
  });

  it("Test 2: an Attest on the request clears the overrun entirely", async () => {
    const fx = await seedKarenzFixture(app, "d21-2");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: fx.tenant.id },
        data: { sickNoteRequiredAfterDays: 3 },
      });
      await approveSick(app, fx.employee.id, fx.sickType.id, daysAgo(10), daysAgo(6), true);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/leave/karenz-overrun",
        headers: { authorization: `Bearer ${fx.empToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.totalDays).toBe(0);
      expect(body.overruns).toEqual([]);
    } finally {
      await cleanupTestData(app, fx.tenant.id);
    }
  });

  it('Test 3: exactly 3 calendar days with threshold 3 is NOT an overrun ("länger als")', async () => {
    const fx = await seedKarenzFixture(app, "d21-3");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: fx.tenant.id },
        data: { sickNoteRequiredAfterDays: 3 },
      });
      await approveSick(app, fx.employee.id, fx.sickType.id, daysAgo(10), daysAgo(8));

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/leave/karenz-overrun",
        headers: { authorization: `Bearer ${fx.empToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.totalDays).toBe(0);
      expect(body.overruns).toEqual([]);
    } finally {
      await cleanupTestData(app, fx.tenant.id);
    }
  });

  it("Test 4 (tenant/self isolation): employee A never sees employee B's overrun days", async () => {
    const fx = await seedKarenzFixture(app, "d21-4");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: fx.tenant.id },
        data: { sickNoteRequiredAfterDays: 3 },
      });

      // Second employee, SAME tenant — the isolation must come from req.user.employeeId,
      // not from tenant scoping alone.
      const empBUser = await app.prisma.user.create({
        data: {
          email: "karenz-empb-d21-4@test.de",
          passwordHash: await bcrypt.hash("test1234", 10),
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const employeeB = await app.prisma.employee.create({
        data: {
          tenantId: fx.tenant.id,
          userId: empBUser.id,
          employeeNumber: "KE-B-d21-4",
          firstName: "KarenzB",
          lastName: "d21-4",
          hireDate: new Date("2026-06-01T00:00:00Z"),
        },
      });
      await app.prisma.overtimeAccount.create({
        data: { employeeId: employeeB.id, balanceHours: 0 },
      });

      const reqA = await approveSick(app, fx.employee.id, fx.sickType.id, daysAgo(10), daysAgo(6));
      const reqB = await approveSick(app, employeeB.id, fx.sickType.id, daysAgo(10), daysAgo(6));

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/leave/karenz-overrun",
        headers: { authorization: `Bearer ${fx.empToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const ids = body.overruns.map((o: { leaveRequestId: string }) => o.leaveRequestId);
      expect(ids).toContain(reqA.id);
      expect(ids).not.toContain(reqB.id);
    } finally {
      await cleanupTestData(app, fx.tenant.id);
    }
  });

  it("Test 5: graceDays is echoed back NORMALISED — a legacy stored 30 responds 3", async () => {
    const fx = await seedKarenzFixture(app, "d21-5");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: fx.tenant.id },
        data: { sickNoteRequiredAfterDays: 30 },
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/leave/karenz-overrun",
        headers: { authorization: `Bearer ${fx.empToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().graceDays).toBe(3);
    } finally {
      await cleanupTestData(app, fx.tenant.id);
    }
  });

  it("Test 6: a caller with no linked employee record (bare ADMIN) gets 200 with an empty result, not a 500", async () => {
    const fx = await seedKarenzFixture(app, "d21-6");
    let bareAdminUserId: string | null = null;
    try {
      const bareAdminUser = await app.prisma.user.create({
        data: {
          email: "karenz-bare-admin-d21-6@test.de",
          passwordHash: await bcrypt.hash("test1234", 10),
          role: "ADMIN",
          isActive: true,
        },
      });
      bareAdminUserId = bareAdminUser.id;

      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: bareAdminUser.email, password: "test1234" },
      });
      const { accessToken: bareToken } = JSON.parse(loginRes.body);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/leave/karenz-overrun",
        headers: { authorization: `Bearer ${bareToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.overruns).toEqual([]);
      expect(body.totalDays).toBe(0);
      expect(typeof body.graceDays).toBe("number");
    } finally {
      if (bareAdminUserId) {
        // Not tied to any tenant/employee — cleanupTestData below only sweeps fx.tenant.id.
        await app.prisma.user.delete({ where: { id: bareAdminUserId } }).catch(() => undefined);
      }
      await cleanupTestData(app, fx.tenant.id);
    }
  });

  it("Test 7 (no time bomb): fixtures are seeded relative to today, so the 12-month window never expires the suite", async () => {
    const fx = await seedKarenzFixture(app, "d21-7");
    try {
      await app.prisma.tenantConfig.update({
        where: { tenantId: fx.tenant.id },
        data: { sickNoteRequiredAfterDays: 3 },
      });
      const start = daysAgo(10);
      const end = daysAgo(6);
      await approveSick(app, fx.employee.id, fx.sickType.id, start, end);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/leave/karenz-overrun",
        headers: { authorization: `Bearer ${fx.empToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.totalDays).toBe(5);
      const days: string[] = body.overruns[0].days;
      expect(days[0]).toBe(start);
      expect(days[days.length - 1]).toBe(end);
    } finally {
      await cleanupTestData(app, fx.tenant.id);
    }
  });
});
