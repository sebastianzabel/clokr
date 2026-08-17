/**
 * Regression tests for month-detail-shows-next-month-snapshot.
 *
 * Root cause: fetchCloseMonthData()'s Q1 snapshot pre-fetch (close-month-data.ts)
 * uses `periodStart: { gte: start, lte: end }`, which is one day too wide at the
 * upper bound under the TZ-converted periodStart convention (see
 * utils/snapshot-period.ts): month N+1's snapshot has `periodStart` equal to the
 * LAST UTC day of month N (e.g. for Europe/Berlin, July 2026's snapshot carries
 * periodStart = 2026-06-30, since 2026-07-01T00:00 Berlin = 2026-06-30T22:00Z).
 * A query for JUNE (start=2026-05-31T22:00Z, end=2026-06-30T22:00Z) therefore also
 * returns JULY's snapshot.
 *
 * `GET /overtime/close-month/status` used to pick `[0]` of that pre-fetch
 * unfiltered, so an employee with NO active June snapshot but an active July
 * snapshot was reported as "closed" for June. `GET /overtime/close-month/year-status`
 * already guarded against this via isPeriodStartInMonth() — this fix brings
 * `/status` in line.
 *
 * Case 1 (the bug): employee has ONLY a July snapshot → June must NOT be "closed".
 * Case 2 (regression guard): employee has a genuine June snapshot → June status
 * must still be "closed", carrying that snapshot's own data.
 */

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { monthRangeUtc } from "../utils/timezone";
import bcrypt from "bcryptjs";

const TZ = "Europe/Berlin";

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

// June 2026: fully past as of "today" in this repo's test fixtures (see close-month-gate.test.ts)
const JUNE_WORKDAYS = monFriInRange("2026-06-01", "2026-06-30");

async function seedEntry(app: FastifyInstance, empId: string, dateStr: string) {
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

describe("close-month/status — snapshot month attribution (month-detail-shows-next-month-snapshot)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;

  let bugEmpId: string; // Case 1: only a July snapshot, June fully worked, no June snapshot
  let closedEmpId: string; // Case 2: genuine June snapshot

  beforeAll(async () => {
    app = await getTestApp();
    const s = `snapattr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const prisma = app.prisma;

    const tenant = await prisma.tenant.create({
      data: { name: `SnapAttr ${s}`, slug: `snapattr-${s}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId, defaultVacationDays: 30, timezone: TZ },
    });

    const adminUser = await prisma.user.create({
      data: {
        email: `admin-snapattr-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "ADMIN",
        isActive: true,
      },
    });
    const adminEmp = await prisma.employee.create({
      data: {
        tenantId,
        userId: adminUser.id,
        employeeNumber: `ADM-${s}`,
        firstName: "Admin",
        lastName: "SnapAttr",
        hireDate: new Date("2024-01-01T00:00:00Z"),
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
        validFrom: new Date("2024-01-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: adminEmp.id, balanceHours: 0 } });

    // ── Case 1 employee: fully worked June, but NO June snapshot — only a July one ──
    const bugUser = await prisma.user.create({
      data: {
        email: `bug-snapattr-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const bugEmp = await prisma.employee.create({
      data: {
        tenantId,
        userId: bugUser.id,
        employeeNumber: `BUG-${s}`,
        firstName: "Naechster",
        lastName: "Monat",
        hireDate: new Date("2026-06-01T00:00:00Z"),
      },
    });
    bugEmpId = bugEmp.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: bugEmpId,
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
    await prisma.overtimeAccount.create({ data: { employeeId: bugEmpId, balanceHours: 0 } });
    for (const d of JUNE_WORKDAYS) {
      await seedEntry(app, bugEmpId, d);
    }
    // Only a JULY snapshot exists (superseded=false). Under the TZ-converted convention,
    // its periodStart is the last UTC day of June — squarely inside a naive June range query.
    const julyRange = monthRangeUtc(2026, 7, TZ);
    await prisma.saldoSnapshot.create({
      data: {
        employeeId: bugEmpId,
        periodType: "MONTHLY",
        periodStart: julyRange.start,
        periodEnd: julyRange.end,
        workedMinutes: 8 * 60 * 22,
        expectedMinutes: 8 * 60 * 22,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
        closedBy: null,
      },
    });

    // ── Case 2 employee: genuine June snapshot (regression guard) ──
    const closedUser = await prisma.user.create({
      data: {
        email: `closed-snapattr-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const closedEmp = await prisma.employee.create({
      data: {
        tenantId,
        userId: closedUser.id,
        employeeNumber: `CLOSED-${s}`,
        firstName: "Echt",
        lastName: "Geschlossen",
        hireDate: new Date("2026-06-01T00:00:00Z"),
      },
    });
    closedEmpId = closedEmp.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: closedEmpId,
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
    await prisma.overtimeAccount.create({ data: { employeeId: closedEmpId, balanceHours: 0 } });
    const juneRange = monthRangeUtc(2026, 6, TZ);
    await prisma.saldoSnapshot.create({
      data: {
        employeeId: closedEmpId,
        periodType: "MONTHLY",
        periodStart: juneRange.start,
        periodEnd: juneRange.end,
        workedMinutes: 8 * 60 * 22,
        expectedMinutes: 8 * 60 * 22,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
        closedBy: null,
      },
    });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `admin-snapattr-${s}@test.de`, password: "test1234" },
    });
    adminToken = JSON.parse(loginRes.body).accessToken;
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("close-month-status-snapshot-attribution cleanup:", err);
    }
    vi.useRealTimers();
  });

  it("Case 1: an employee with only a JULY snapshot must NOT be reported as June-closed", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/overtime/close-month/status",
      headers: { authorization: `Bearer ${adminToken}` },
      query: { year: "2026", month: "6" },
    });
    expect(res.statusCode, `status ${res.statusCode} — body: ${res.body}`).toBe(200);

    const body = JSON.parse(res.body) as {
      employees: Array<{ employeeId: string; status: string }>;
    };
    const row = body.employees.find((e) => e.employeeId === bugEmpId);
    expect(row, "bug employee must appear in the June status list").toBeDefined();
    expect(
      row!.status,
      `June must not be reported as closed via July's snapshot — got status=${row!.status}`,
    ).not.toBe("closed");
  });

  it("Case 2 (regression guard): an employee with a genuine June snapshot IS reported closed", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/overtime/close-month/status",
      headers: { authorization: `Bearer ${adminToken}` },
      query: { year: "2026", month: "6" },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as {
      employees: Array<{ employeeId: string; status: string }>;
    };
    const row = body.employees.find((e) => e.employeeId === closedEmpId);
    expect(row, "closed employee must appear in the June status list").toBeDefined();
    expect(row!.status, "a genuine June snapshot must still mark the month closed").toBe("closed");
  });
});
