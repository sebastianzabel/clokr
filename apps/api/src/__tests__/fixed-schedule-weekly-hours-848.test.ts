/**
 * Issue #848 — a FIXED_SCHEDULE contract's weeklyHours and its {day}Hours never diverge on write.
 *
 * Before the fix, `POST /employees` with `weeklyHours: 32, workDays: [2,3,4,5]` stored weekly 32 h
 * but day hours Mo–Fr 8 h (the column defaults), so the month view (which reads weeklyHours) and
 * the saldo chain / reports (which read the day hours) showed the same person two Soll values.
 *
 * Fixture month: October 2026 (Thu 1st). Tue–Fri days: 1, 2 + four full weeks = 18 → 144 h.
 * The two statutory holidays that touch October in any Bundesland (3rd, 31st) are Saturdays, so
 * the month has no weekday holiday. With the old Mo–Fr 8 h day hours the Soll was 22 × 8 = 176 h.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { earliestBulkEffectiveFromStr, todayStr } from "./test-dates";
import {
  deriveFixedScheduleDayHours,
  fixedScheduleCreateHours,
  fixedScheduleHoursMismatch,
} from "../contexts/platform/fixed-schedule-hours";

const OCTOBER_TUE_FRI_DAYS = 18;

describe("Issue #848 — derivation and guard (pure)", () => {
  it("splits 32 h over Di–Fr into 8 h each, Mo 0", () => {
    expect(deriveFixedScheduleDayHours(32, [2, 3, 4, 5])).toEqual({
      mondayHours: 0,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
    });
  });

  it("puts the rounding remainder on the last workday so the sum is exact", () => {
    const h = deriveFixedScheduleDayHours(32, [1, 3, 5]);
    expect([h.mondayHours, h.wednesdayHours, h.fridayHours]).toEqual([10.66, 10.66, 10.68]);
    // Sunday counts as the last day of the working week.
    const s = deriveFixedScheduleDayHours(10, [0, 6, 1]);
    expect([s.mondayHours, s.saturdayHours, s.sundayHours]).toEqual([3.33, 3.33, 3.34]);
  });

  it("an omitted weekly value keeps the old 8 h per workday, now consistently", () => {
    expect(fixedScheduleCreateHours(0, [1, 2, 3, 4, 5]).weeklyHours).toBe(40);
    expect(fixedScheduleCreateHours(null, [2, 3, 4]).weeklyHours).toBe(24);
  });

  it("refuses only an inconsistent FIXED_SCHEDULE", () => {
    const moFr8 = deriveFixedScheduleDayHours(40, [1, 2, 3, 4, 5]);
    expect(fixedScheduleHoursMismatch("FIXED_SCHEDULE", 40, moFr8)).toBeNull();
    expect(fixedScheduleHoursMismatch("FIXED_SCHEDULE", "40.00", moFr8)).toBeNull();
    expect(fixedScheduleHoursMismatch("FIXED_SCHEDULE", 32, moFr8)).toMatch(
      /Wochenstunden \(32 h\).*Summe der Tagesstunden \(40 h\)/,
    );
    // Other types: day hours are placeholders, never compared.
    expect(fixedScheduleHoursMismatch("FLEXTIME", 32, moFr8)).toBeNull();
    expect(fixedScheduleHoursMismatch("SHIFT_BASED", 32, moFr8)).toBeNull();
  });
});

describe("Issue #848 — the write paths and the Soll parity", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let employeeId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "fsw848");
    const uid = Date.now().toString(36);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        email: `fsw848-${uid}@test.de`,
        firstName: "Teil",
        lastName: "Zeit",
        employeeNumber: `FSW848-${uid}`,
        hireDate: new Date("2026-10-01T00:00:00Z").toISOString(),
        role: "EMPLOYEE",
        scheduleType: "FIXED_SCHEDULE",
        weeklyHours: 32,
        workDays: [2, 3, 4, 5],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    employeeId = (JSON.parse(res.body) as { id: string }).id;
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  it("POST /employees stores Di–Fr 8 h, Mo 0 h and weeklyHours 32", async () => {
    const ws = await app.prisma.workSchedule.findFirstOrThrow({ where: { employeeId } });
    expect(Number(ws.weeklyHours)).toBe(32);
    expect(
      [
        ws.mondayHours,
        ws.tuesdayHours,
        ws.wednesdayHours,
        ws.thursdayHours,
        ws.fridayHours,
        ws.saturdayHours,
        ws.sundayHours,
      ].map(Number),
    ).toEqual([0, 8, 8, 8, 8, 0, 0]);
    expect(ws.workDays).toEqual([2, 3, 4, 5]);
  });

  it("month view, /overtime/month-saldo, /reports/monthly and /overtime/:id name the same Soll", async () => {
    const auth = { authorization: `Bearer ${data.adminToken}` };
    const expectedMinutes = OCTOBER_TUE_FRI_DAYS * 8 * 60;

    // The month view derives the daily Soll from GET /settings/work (weeklyHours / workDays).
    const work = await app.inject({
      method: "GET",
      url: `/api/v1/settings/work/${employeeId}`,
      headers: auth,
    });
    expect(work.statusCode, work.body).toBe(200);
    const sched = JSON.parse(work.body) as { weeklyHours: string | number; workDays: number[] };
    const monthViewMinutes =
      ((Number(sched.weeklyHours) * 60) / sched.workDays.length) * OCTOBER_TUE_FRI_DAYS;
    expect(monthViewMinutes).toBe(expectedMinutes);

    const monthSaldo = async (year: number, month: number) => {
      const r = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/month-saldo/${employeeId}?year=${year}&month=${month}`,
        headers: auth,
      });
      expect(r.statusCode, r.body).toBe(200);
      return JSON.parse(r.body) as { expectedMinutes: number; balanceMinutes: number };
    };
    const october = await monthSaldo(2026, 10);
    expect(october.expectedMinutes).toBe(expectedMinutes);

    const report = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?employeeId=${employeeId}&year=2026&month=10`,
      headers: auth,
    });
    expect(report.statusCode, report.body).toBe(200);
    const row = (
      JSON.parse(report.body) as { rows: Array<{ employeeId: string; shouldHours: number }> }
    ).rows.find((r) => r.employeeId === employeeId);
    expect(row?.shouldHours).toBe(expectedMinutes / 60);

    // The live saldo (no time recorded) is minus the Soll of every month since hire, to date.
    let sollSinceHire = 0;
    const [ty, tm] = todayStr().split("-").map(Number);
    for (let y = 2026, m = 10; y < ty || (y === ty && m <= tm); m === 12 ? ((m = 1), y++) : m++) {
      sollSinceHire += (await monthSaldo(y, m)).expectedMinutes;
    }
    const live = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${employeeId}`,
      headers: auth,
    });
    expect(live.statusCode, live.body).toBe(200);
    const liveMinutes = Math.round(
      Number((JSON.parse(live.body) as { balanceHours: number }).balanceHours) * 60,
    );
    expect(liveMinutes).toBe(-sollSinceHire);
  });

  it("the CSV import writes day hours that add up to the imported weekly hours", async () => {
    const uid = Date.now().toString(36);
    const csv = `email;vorname;nachname;nr;eintrittsdatum;rolle;wochenstunden;passwort
imp848-${uid}@test.de;Import;Teilzeit;IMP848-${uid};01.10.2026;EMPLOYEE;38.5;test1234`;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports/employees",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { csv },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((JSON.parse(res.body) as { imported: number }).imported).toBe(1);
    const ws = await app.prisma.workSchedule.findFirstOrThrow({
      where: { employee: { employeeNumber: `IMP848-${uid}` } },
    });
    expect(Number(ws.weeklyHours)).toBe(38.5);
    expect(
      [ws.mondayHours, ws.tuesdayHours, ws.wednesdayHours, ws.thursdayHours, ws.fridayHours].map(
        Number,
      ),
    ).toEqual([7.7, 7.7, 7.7, 7.7, 7.7]);
    expect([ws.saturdayHours, ws.sundayHours].map(Number)).toEqual([0, 0]);
  });

  it("PUT /settings/work/:id refuses weeklyHours ≠ Σ day hours with a German 400", async () => {
    const before = await app.prisma.workSchedule.count({ where: { employeeId } });
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${employeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "FIXED_SCHEDULE",
        weeklyHours: 32,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: "2026-12-01",
      },
    });
    expect(res.statusCode, res.body).toBe(400);
    const body = JSON.parse(res.body) as { error: string; code: string };
    expect(body.code).toBe("WEEKLY_HOURS_MISMATCH");
    expect(body.error).toContain("stimmen nicht mit der Summe der Tagesstunden");
    expect(await app.prisma.workSchedule.count({ where: { employeeId } })).toBe(before);
  });

  it("PUT /settings/work/:id without weeklyHours takes the day sum (no 400)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${employeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "FIXED_SCHEDULE",
        mondayHours: 0,
        tuesdayHours: 6,
        wednesdayHours: 6,
        thursdayHours: 6,
        fridayHours: 6,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: "2026-12-01",
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(Number((JSON.parse(res.body) as { weeklyHours: string }).weeklyHours)).toBe(24);
  });

  it("the bulk apply (preview and apply) refuses inconsistent defaults before any write", async () => {
    const auth = { authorization: `Bearer ${data.adminToken}` };
    const inconsistent = {
      defaultWeeklyHours: 32,
      defaultMondayHours: 8,
      defaultTuesdayHours: 8,
      defaultWednesdayHours: 8,
      defaultThursdayHours: 8,
      defaultFridayHours: 8,
      defaultSaturdayHours: 0,
      defaultSundayHours: 0,
    };
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/settings/work/apply-defaults/preview",
      headers: auth,
      payload: inconsistent,
    });
    expect(preview.statusCode, preview.body).toBe(400);
    expect((JSON.parse(preview.body) as { code: string }).code).toBe("WEEKLY_HOURS_MISMATCH");

    const configBefore = await app.prisma.tenantConfig.findUnique({
      where: { tenantId: data.tenant.id },
    });
    const schedulesBefore = await app.prisma.workSchedule.count({ where: { employeeId } });
    const apply = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: auth,
      payload: {
        ...inconsistent,
        applyToExisting: true,
        applyEmployeeIds: [employeeId],
        previewFingerprint: "0".repeat(64),
        effectiveFrom: earliestBulkEffectiveFromStr(),
      },
    });
    expect(apply.statusCode, apply.body).toBe(400);
    const body = JSON.parse(apply.body) as { error: string; code: string };
    expect(body.code).toBe("WEEKLY_HOURS_MISMATCH");
    expect(body.error).toContain("stimmen nicht mit der Summe der Tagesstunden");
    const configAfter = await app.prisma.tenantConfig.findUnique({
      where: { tenantId: data.tenant.id },
    });
    expect(configAfter?.defaultWeeklyHours?.toString()).toBe(
      configBefore?.defaultWeeklyHours?.toString(),
    );
    expect(await app.prisma.workSchedule.count({ where: { employeeId } })).toBe(schedulesBefore);
  });
});
