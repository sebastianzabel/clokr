/**
 * Issue #451 (D-02) — the Monatsbericht (JSON + both PDFs), the Urlaubsliste PDF and the list
 * part of the Urlaubs-PDF print the leave days the absence context PRICED (workDays-aware,
 * holiday-aware, SHIFT_BASED contract days, Berufsschultage #448, §9-netted), never the raw
 * calendar-day span of a request. The issue's own literal example: a VACATION request spanning
 * Mon 03.08.2026 – Sun 16.08.2026 on a Mo–Fr contract is 10 workdays, not 14 calendar days.
 *
 * Every leave request is created through POST /api/v1/leave/requests (+ PATCH .../review) so the
 * stored `days` is priced by the absence context exactly as production traffic prices it — this
 * file never hand-writes a `days` value.
 *
 * `generateMonthlyReportPdf`, `streamCompanyMonthlyReportPdf` and `streamLeaveListPdf` are spied
 * the same way `reports-bs-leave-448.test.ts` / `reports.test.ts` already spy their own PDF
 * generators — PDFKit Flate-compresses its content streams, so the only way to assert on the data
 * a route built is to capture the argument before it reaches PDFKit.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import * as pdfUtils from "../pdf";

vi.mock("../pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pdf")>();
  return {
    ...actual,
    generateMonthlyReportPdf: vi.fn(actual.generateMonthlyReportPdf),
    streamCompanyMonthlyReportPdf: vi.fn(actual.streamCompanyMonthlyReportPdf),
    streamLeaveListPdf: vi.fn(actual.streamLeaveListPdf),
  };
});

type FixedHours = {
  mon: number;
  tue: number;
  wed: number;
  thu: number;
  fri: number;
  sat: number;
  sun: number;
};

const TUESAT_8H: FixedHours = { mon: 0, tue: 8, wed: 8, thu: 8, fri: 8, sat: 8, sun: 0 };

async function loginAs(app: FastifyInstance, email: string, password = "test1234") {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
  const { accessToken } = JSON.parse(res.body) as { accessToken: string };
  return accessToken;
}

/** A fresh FIXED_SCHEDULE employee with its own login — mirrors
 * datev-leave-days-451.test.ts's createFixedScheduleEmployee. */
async function createFixedScheduleEmployee(
  app: FastifyInstance,
  tenantId: string,
  salonId: string,
  label: string,
  hireDate: string,
  hours: FixedHours,
): Promise<{ id: string; token: string; employeeNumber: string }> {
  const passwordHash = await bcrypt.hash("test1234", 10);
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const email = `${label}-${suffix}@test.de`;
  const user = await app.prisma.user.create({
    data: { email, passwordHash, role: "EMPLOYEE", isActive: true },
  });
  const employeeNumber = `${label}-${suffix}`;
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber,
      firstName: label,
      lastName: "Leave451",
      hireDate: new Date(`${hireDate}T00:00:00Z`),
    },
  });
  await app.prisma.workSchedule.create({
    data: {
      employeeId: employee.id,
      type: "FIXED_SCHEDULE",
      weeklyHours:
        hours.mon + hours.tue + hours.wed + hours.thu + hours.fri + hours.sat + hours.sun,
      mondayHours: hours.mon,
      tuesdayHours: hours.tue,
      wednesdayHours: hours.wed,
      thursdayHours: hours.thu,
      fridayHours: hours.fri,
      saturdayHours: hours.sat,
      sundayHours: hours.sun,
      validFrom: new Date(`${hireDate}T00:00:00Z`),
    },
  });
  await app.prisma.employeeSalonAssignment.create({
    data: {
      tenantId,
      employeeId: employee.id,
      salonId,
      kind: "HOME",
      validFrom: new Date(`${hireDate}T00:00:00Z`),
      validUntil: null,
      weekdays: [],
    },
  });
  await app.prisma.overtimeAccount.create({
    data: { employeeId: employee.id, balanceHours: 0 },
  });
  const token = await loginAs(app, email);
  return { id: employee.id, token, employeeNumber };
}

async function createLeave(
  app: FastifyInstance,
  token: string,
  type: string,
  startDate: string,
  endDate: string,
  halfDay = false,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/leave/requests",
    headers: { authorization: `Bearer ${token}` },
    payload: { type, startDate, endDate, ...(halfDay ? { halfDay: true } : {}), ...extra },
  });
  expect(res.statusCode).toBe(201);
  return (JSON.parse(res.body) as { id: string }).id;
}

async function approveLeave(app: FastifyInstance, adminToken: string, id: string): Promise<void> {
  const res = await app.inject({
    method: "PATCH",
    url: `/api/v1/leave/requests/${id}/review`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { status: "APPROVED" },
  });
  expect(res.statusCode).toBe(200);
}

describe("Issue #451 (D-02) — Monatsbericht leave counts come from the absence context's priced days", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;
  let control: Awaited<ReturnType<typeof seedTestData>>;
  let tueSat: { id: string; token: string; employeeNumber: string };

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "rpld1");
    control = await seedTestData(app, "rpld1ctrl");

    tueSat = await createFixedScheduleEmployee(
      app,
      d.tenant.id,
      d.salonId,
      "tuesat451b",
      "2024-01-01",
      TUESAT_8H,
    );
    const specialRule = await app.prisma.specialLeaveRule.create({
      data: {
        tenantId: d.tenant.id,
        name: "451-02 Sonderurlaubsanlass",
        defaultDays: 10,
        isActive: true,
      },
    });
    // Issue #451's own literal example: Mon 03.08.2026 - Sun 16.08.2026 on a Mo-Fr contract is 10
    // workdays (two full Mo-Fr weeks), not the 14 calendar days the span covers.
    await approveLeave(
      app,
      d.adminToken,
      await createLeave(app, d.empToken, "VACATION", "2026-08-03", "2026-08-16"),
    );

    // SPECIAL Sat 08.08. - Mon 10.08.2026 on a Tue-Sat contract (Monday NOT a workday): only
    // Saturday is a contracted workday in this 3-calendar-day span -> 1 priced day.
    await approveLeave(
      app,
      d.adminToken,
      await createLeave(app, tueSat.token, "SPECIAL", "2026-08-08", "2026-08-10", false, {
        specialLeaveRuleId: specialRule.id,
      }),
    );

    // Control: a 1-day VACATION and a 1-day SICK on different days, same month — the pre-fix
    // calendar-day walk and the priced-day read agree here (no multi-day span, no overlap), so
    // this employee's figures must be identical before and after the fix.
    await approveLeave(
      app,
      control.adminToken,
      await createLeave(app, control.empToken, "VACATION", "2026-08-03", "2026-08-03"),
    );
    await approveLeave(
      app,
      control.adminToken,
      await createLeave(app, control.empToken, "SICK", "2026-08-05", "2026-08-05"),
    );
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, d.tenant.id);
      await cleanupTestData(app, control.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("GET /reports/monthly: the 14-day VACATION span prices as 10 workdays, not 14 calendar days", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?employeeId=${d.employee.id}&year=2026&month=8`,
      headers: { authorization: `Bearer ${d.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const row = JSON.parse(res.body).rows.find(
      (r: { employeeId: string }) => r.employeeId === d.employee.id,
    );
    expect(row).toBeDefined();
    expect(row.vacationDays).toBe(10);
    expect(row.totalAbsenceDays).toBe(10);
  });

  it("GET /reports/monthly/pdf: the single-employee PDF payload prices the same 10 workdays", async () => {
    const spy = vi.mocked(pdfUtils.generateMonthlyReportPdf);
    spy.mockClear();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly/pdf?employeeId=${d.employee.id}&year=2026&month=8`,
      headers: { authorization: `Bearer ${d.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    const payload = spy.mock.calls[0][0];
    expect(payload.vacationDays).toBe(10);
    expect(payload.otherAbsenceDays).toBe(0);
  });

  it("GET /reports/monthly/pdf/all: the company PDF's row for this employee prices the same 10 workdays", async () => {
    const spy = vi.mocked(pdfUtils.streamCompanyMonthlyReportPdf);
    spy.mockClear();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/reports/monthly/pdf/all?year=2026&month=8",
      headers: { authorization: `Bearer ${d.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    const companyData = spy.mock.calls[0][1];
    const row = companyData.rows.find((r) => r.employeeNumber === d.employee.employeeNumber);
    expect(row).toBeDefined();
    expect(row!.vacationDays).toBe(10);
    expect(row!.totalAbsenceDays).toBe(10);
  });

  it("GET /reports/monthly: SPECIAL Sat-Mon on a Tue-Sat contract (Monday not a workday) prices as 1 day, not 3", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?employeeId=${tueSat.id}&year=2026&month=8`,
      headers: { authorization: `Bearer ${d.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const row = JSON.parse(res.body).rows.find(
      (r: { employeeId: string }) => r.employeeId === tueSat.id,
    );
    expect(row).toBeDefined();
    expect(row.specialLeaveDays).toBe(1);
    expect(row.totalAbsenceDays).toBe(1);
  });

  it("GET /reports/monthly (control): a 1-day VACATION + a 1-day SICK on different days are unaffected by the fix", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?employeeId=${control.employee.id}&year=2026&month=8`,
      headers: { authorization: `Bearer ${control.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const row = JSON.parse(res.body).rows.find(
      (r: { employeeId: string }) => r.employeeId === control.employee.id,
    );
    expect(row).toBeDefined();
    expect(row.vacationDays).toBe(1);
    expect(row.sickDaysWithoutAttest).toBe(1);
  });
});
