/**
 * Issue #451 (D-01) — the DATEV LODAS export stops counting leave days itself and instead reads
 * the leave-day share the absence context already prices per calendar date (workDays, holidays,
 * half days, SHIFT_BASED contract days, Berufsschultage #448), clipped to the payroll month.
 *
 * RED-first regression tests for the issue's own literal examples (half day, Saturday on a
 * Tue–Sat contract, a 4-day contract's full week, 24.–31.12. with real holidays, a cross-month
 * request) plus — added on top for every other non-sick Lohnart (Task 2) — Sonderurlaub,
 * Bildungsurlaub and unbezahlter Urlaub on the same mechanism.
 *
 * Every leave request is created through POST /api/v1/leave/requests (+ PATCH .../review) so the
 * stored `days` is priced by the absence context exactly as production traffic prices it — this
 * file never hand-writes a `days` value.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import iconv from "iconv-lite";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData, configureDatevKanzlei } from "./setup";
import { getHolidayMap } from "../contexts/absence";

// Issue #256 (Befund 1): a Bewegungsdaten row is the Satz-ID followed by the 12 values declared
// in [Satzbeschreibung] — named offsets, mirroring datev-export.test.ts's own convention.
const F_PNR = 1;
const F_LOHNART = 5;
const F_TAGE = 7;

type FixedHours = {
  mon: number;
  tue: number;
  wed: number;
  thu: number;
  fri: number;
  sat: number;
  sun: number;
};

const MOFR_8H: FixedHours = { mon: 8, tue: 8, wed: 8, thu: 8, fri: 8, sat: 0, sun: 0 };
const TUESAT_8H: FixedHours = { mon: 0, tue: 8, wed: 8, thu: 8, fri: 8, sat: 8, sun: 0 };
const MONTHU_10H: FixedHours = { mon: 10, tue: 10, wed: 10, thu: 10, fri: 0, sat: 0, sun: 0 };

async function loginAs(app: FastifyInstance, email: string, password = "test1234") {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
  const { accessToken } = JSON.parse(res.body) as { accessToken: string };
  return accessToken;
}

/** A fresh FIXED_SCHEDULE employee with its own login, for a per-day-hours shape this file's
 * default seedTestData employee (Mo–Fr 8h) cannot exercise. Mirrors
 * monthly-hours-soll-parity-433.test.ts's createFixedEmployee, widened to take arbitrary hours. */
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
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/leave/requests",
    headers: { authorization: `Bearer ${token}` },
    payload: { type, startDate, endDate, ...(halfDay ? { halfDay: true } : {}) },
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

function datevRows(rawPayload: Buffer): string[] {
  const body = iconv.decode(rawPayload, "win1252");
  return body
    .split("[Bewegungsdaten]")[1]
    .split("\r\n")
    .filter((l) => l.trim().length > 0);
}

function tageFor(rows: string[], employeeNumber: string, lohnart: string): string | undefined {
  const row = rows.find(
    (r) => r.split(";")[F_PNR] === employeeNumber && r.split(";")[F_LOHNART] === lohnart,
  );
  return row?.split(";")[F_TAGE];
}

describe("Issue #451 (D-01) — DATEV VACATION day-count equals the absence context's priced days", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;
  let empTueSat: { id: string; token: string; employeeNumber: string };
  let empMonThu: { id: string; token: string; employeeNumber: string };
  let empDec: { id: string; token: string; employeeNumber: string };
  let empCrossMonth: { id: string; token: string; employeeNumber: string };

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "451dlq");
    await configureDatevKanzlei(app, d.tenant.id);

    empTueSat = await createFixedScheduleEmployee(
      app,
      d.tenant.id,
      d.salonId,
      "tuesat451",
      "2024-01-01",
      TUESAT_8H,
    );
    empMonThu = await createFixedScheduleEmployee(
      app,
      d.tenant.id,
      d.salonId,
      "monthu451",
      "2024-01-01",
      MONTHU_10H,
    );
    empDec = await createFixedScheduleEmployee(
      app,
      d.tenant.id,
      d.salonId,
      "dec451",
      "2024-01-01",
      MOFR_8H,
    );
    empCrossMonth = await createFixedScheduleEmployee(
      app,
      d.tenant.id,
      d.salonId,
      "crossm451",
      "2024-01-01",
      MOFR_8H,
    );

    // (a) half day on a Wednesday, Mo–Fr 8h contract (d.employee, seedTestData's default).
    await approveLeave(
      app,
      d.adminToken,
      await createLeave(app, d.empToken, "VACATION", "2026-07-08", "2026-07-08", true),
    );

    // (b) a Saturday on a Tue–Sat contract.
    await approveLeave(
      app,
      d.adminToken,
      await createLeave(app, empTueSat.token, "VACATION", "2026-07-11", "2026-07-11"),
    );

    // (c) a full Mon-Fri week on a Mon-Thu (4-day) contract.
    await approveLeave(
      app,
      d.adminToken,
      await createLeave(app, empMonThu.token, "VACATION", "2026-07-13", "2026-07-17"),
    );

    // (d) 24.-31.12.2026 on a Mo-Fr contract — real tenant holidays (Christmas) excluded.
    await approveLeave(
      app,
      d.adminToken,
      await createLeave(app, empDec.token, "VACATION", "2026-12-24", "2026-12-31"),
    );

    // (e) one request crossing the year/month boundary, Mo-Fr contract.
    await approveLeave(
      app,
      d.adminToken,
      await createLeave(app, empCrossMonth.token, "VACATION", "2026-12-28", "2027-01-08"),
    );
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, d.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("(a) a half-day VACATION on a Mo-Fr contract is exported as tage 0,5 — not 1,0 — per-employee and company-wide", async () => {
    const empRes = await app.inject({
      method: "GET",
      url: `/api/v1/reports/datev/employee?employeeId=${d.employee.id}&year=2026&month=7`,
      headers: { authorization: `Bearer ${d.adminToken}` },
    });
    expect(empRes.statusCode).toBe(200);
    expect(tageFor(datevRows(empRes.rawPayload), d.employee.employeeNumber, "300")).toBe("0,5");

    const companyRes = await app.inject({
      method: "GET",
      url: "/api/v1/reports/datev?year=2026&month=7",
      headers: { authorization: `Bearer ${d.adminToken}` },
    });
    expect(companyRes.statusCode).toBe(200);
    expect(tageFor(datevRows(companyRes.rawPayload), d.employee.employeeNumber, "300")).toBe("0,5");
  });

  it("(b) a Saturday VACATION day on a Tue-Sat contract is exported as tage 1,0 — the line exists at all", async () => {
    const empRes = await app.inject({
      method: "GET",
      url: `/api/v1/reports/datev/employee?employeeId=${empTueSat.id}&year=2026&month=7`,
      headers: { authorization: `Bearer ${d.adminToken}` },
    });
    expect(empRes.statusCode).toBe(200);
    expect(tageFor(datevRows(empRes.rawPayload), empTueSat.employeeNumber, "300")).toBe("1,0");

    const companyRes = await app.inject({
      method: "GET",
      url: "/api/v1/reports/datev?year=2026&month=7",
      headers: { authorization: `Bearer ${d.adminToken}` },
    });
    expect(companyRes.statusCode).toBe(200);
    expect(tageFor(datevRows(companyRes.rawPayload), empTueSat.employeeNumber, "300")).toBe("1,0");
  });

  it("(c) a full Mon-Fri VACATION week on a 4-day (Mon-Thu) contract is exported as tage 4,0 — not 5,0", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/datev/employee?employeeId=${empMonThu.id}&year=2026&month=7`,
      headers: { authorization: `Bearer ${d.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(tageFor(datevRows(res.rawPayload), empMonThu.employeeNumber, "300")).toBe("4,0");
  });

  it("(d) 24.-31.12.2026 on a Mo-Fr contract reflects the tenant's real holiday set — tage 5,0, not 6,0", async () => {
    // OQ2: establish the REAL holiday set first — never force the expected tage value.
    const holidayMap = await getHolidayMap(
      app.prisma,
      d.tenant.id,
      empDec.id,
      new Date("2026-12-24T00:00:00.000Z"),
      new Date("2026-12-31T00:00:00.000Z"),
    );
    expect(holidayMap.has("2026-12-25")).toBe(true);
    expect(holidayMap.has("2026-12-26")).toBe(true);
    expect(holidayMap.has("2026-12-24")).toBe(false);
    expect(holidayMap.has("2026-12-31")).toBe(false);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/datev/employee?employeeId=${empDec.id}&year=2026&month=12`,
      headers: { authorization: `Bearer ${d.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    // Thu 24 counted; Fri 25 (holiday) + Sat 26 (holiday, also weekend) + Sun 27 (weekend)
    // excluded; Mon 28 - Thu 31 counted -> 24, 28, 29, 30, 31 = 5 workdays.
    expect(tageFor(datevRows(res.rawPayload), empDec.employeeNumber, "300")).toBe("5,0");
  });

  it("(e) a request crossing the month/year boundary is apportioned per month — December 4,0, January 5,0 (not 6,0)", async () => {
    const decRes = await app.inject({
      method: "GET",
      url: `/api/v1/reports/datev/employee?employeeId=${empCrossMonth.id}&year=2026&month=12`,
      headers: { authorization: `Bearer ${d.adminToken}` },
    });
    expect(decRes.statusCode).toBe(200);
    expect(tageFor(datevRows(decRes.rawPayload), empCrossMonth.employeeNumber, "300")).toBe("4,0");

    const janRes = await app.inject({
      method: "GET",
      url: `/api/v1/reports/datev/employee?employeeId=${empCrossMonth.id}&year=2027&month=1`,
      headers: { authorization: `Bearer ${d.adminToken}` },
    });
    expect(janRes.statusCode).toBe(200);
    expect(tageFor(datevRows(janRes.rawPayload), empCrossMonth.employeeNumber, "300")).toBe("5,0");
  });
});
