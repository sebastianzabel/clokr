/**
 * Regression tests for GH #143.
 *
 * Root cause: `GET /close-month/status`'s handler read `const schedule =
 * emp.workSchedules[0]` and then immediately called `String(schedule.type)`
 * BEFORE the `!schedule` guard that the following comment promises ("No
 * schedule or MONTHLY_HOURS → ready"). For an employee with zero
 * `WorkSchedule` rows, `workSchedules[0]` is `undefined`, so `schedule.type`
 * throws a `TypeError` and the whole tenant's status request 500s — the
 * guard the comment describes can never fire.
 *
 * The trigger is NOT a schedule filtered out by `validFrom` (the issue's own
 * guess): both employee queries in `overtime.ts` load `workSchedules` with
 * no `where` clause, so a schedule whose `validFrom` postdates the queried
 * month is still returned and still picked by `[0]`. The array is empty
 * only when the employee has genuinely zero `WorkSchedule` rows — a state
 * the schema permits even though the normal employee-creation path always
 * writes one. This fixture seeds exactly that: an employee with no
 * `prisma.workSchedule.create` call at all.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

const TZ = "Europe/Berlin";

describe("close-month/status & year-status — employee with no WorkSchedule row (GH #143)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let noScheduleEmpId: string;

  beforeAll(async () => {
    app = await getTestApp();
    const s = `noschedule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const prisma = app.prisma;

    const tenant = await prisma.tenant.create({
      data: { name: `NoSchedule ${s}`, slug: `noschedule-${s}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId, defaultVacationDays: 30, timezone: TZ },
    });

    // ── Admin (with a normal FIXED_SCHEDULE) — calls the endpoint and also
    //    proves the endpoint still serves ordinary employees in the same response. ──
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-noschedule-${s}@test.de`,
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
        lastName: "NoSchedule",
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

    // ── Subject: an employee with ZERO WorkSchedule rows — no
    //    prisma.workSchedule.create call at all. isTimeTrackingExempt stays at
    //    its default (false) — EXCLUDE_EXEMPT_EMPLOYEE_FILTER would otherwise
    //    filter this employee out of the loop and the test would pass vacuously. ──
    const noScheduleUser = await prisma.user.create({
      data: {
        email: `subject-noschedule-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const noScheduleEmp = await prisma.employee.create({
      data: {
        tenantId,
        userId: noScheduleUser.id,
        employeeNumber: `NOSCH-${s}`,
        firstName: "Ohne",
        lastName: "Arbeitszeitmodell",
        hireDate: new Date("2024-01-01T00:00:00Z"),
      },
    });
    noScheduleEmpId = noScheduleEmp.id;
    await prisma.overtimeAccount.create({
      data: { employeeId: noScheduleEmpId, balanceHours: 0 },
    });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `admin-noschedule-${s}@test.de`, password: "test1234" },
    });
    adminToken = JSON.parse(loginRes.body).accessToken;
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("close-month-status-no-schedule cleanup:", err);
    }
  });

  it("GET /close-month/status returns 200 and reports the schedule-less employee as 'ready'", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/overtime/close-month/status",
      headers: { authorization: `Bearer ${adminToken}` },
      query: { year: "2026", month: "6" },
    });
    expect(res.statusCode, `status ${res.statusCode} — body: ${res.body}`).toBe(200);

    const body = JSON.parse(res.body) as {
      employees: Array<{
        employeeId: string;
        status: string;
        missingDates?: string[];
        unconfirmedBreakDays?: string[];
        karenzOverrunDays?: string[];
      }>;
    };
    const row = body.employees.find((e) => e.employeeId === noScheduleEmpId);
    expect(row, "schedule-less employee must appear in the June status list").toBeDefined();
    expect(row!.status).toBe("ready");
    expect(row!.missingDates ?? []).toEqual([]);
    expect(row!.unconfirmedBreakDays).toEqual([]);
    expect(row!.karenzOverrunDays).toEqual([]);
  });

  it("GET /close-month/year-status returns 200 for the same tenant", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/overtime/close-month/year-status",
      headers: { authorization: `Bearer ${adminToken}` },
      query: { year: "2026" },
    });
    expect(res.statusCode, `status ${res.statusCode} — body: ${res.body}`).toBe(200);
  });
});
