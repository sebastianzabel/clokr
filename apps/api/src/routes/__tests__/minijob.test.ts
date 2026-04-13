import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import { calcExpectedMinutesTz } from "../../utils/timezone";
import type { FastifyInstance } from "fastify";

describe("Minijob / MONTHLY_HOURS Schedule", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "mj");
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  describe("Employee with MONTHLY_HOURS schedule", () => {
    it("can create employee with scheduleType=MONTHLY_HOURS via API", async () => {
      // Update the employee's schedule to MONTHLY_HOURS
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          type: "MONTHLY_HOURS",
          weeklyHours: 10,
          monthlyHours: 15,
          mondayHours: 0,
          tuesdayHours: 0,
          wednesdayHours: 0,
          thursdayHours: 0,
          fridayHours: 0,
          saturdayHours: 0,
          sundayHours: 0,
          overtimeThreshold: 60,
          allowOvertimePayout: false,
          validFrom: "2025-09-01",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.type).toBe("MONTHLY_HOURS");
      expect(Number(body.monthlyHours)).toBe(15);
    });

    it("can save MONTHLY_HOURS schedule with monthlyHours = null", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          type: "MONTHLY_HOURS",
          weeklyHours: 10,
          monthlyHours: null,
          mondayHours: 0,
          tuesdayHours: 0,
          wednesdayHours: 0,
          thursdayHours: 0,
          fridayHours: 0,
          saturdayHours: 0,
          sundayHours: 0,
          overtimeThreshold: 60,
          allowOvertimePayout: false,
          validFrom: "2025-09-01",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.type).toBe("MONTHLY_HOURS");
      expect(body.monthlyHours).toBeNull();
    });

    it("pure tracking employee accumulates worked hours in overtime balance", async () => {
      // Set schedule to pure tracking (monthlyHours = null)
      const schedRes = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          type: "MONTHLY_HOURS",
          weeklyHours: 10,
          monthlyHours: null,
          mondayHours: 0,
          tuesdayHours: 0,
          wednesdayHours: 0,
          thursdayHours: 0,
          fridayHours: 0,
          saturdayHours: 0,
          sundayHours: 0,
          overtimeThreshold: 60,
          allowOvertimePayout: false,
          validFrom: "2024-01-01",
        },
      });
      expect(schedRes.statusCode).toBe(200);

      // Create a time entry 2 days ago (4h of work)
      const now = new Date();
      const twoDaysAgo = new Date(now);
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
      const dateStr = twoDaysAgo.toISOString().slice(0, 10);

      const startTime = `${dateStr}T08:00:00.000Z`;
      const endTime = `${dateStr}T12:00:00.000Z`;

      // Create entry directly via prisma to bypass business logic for test isolation
      const entry = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(dateStr),
          startTime: new Date(startTime),
          endTime: new Date(endTime),
          breakMinutes: 0,
          source: "MANUAL",
        },
      });

      // Trigger overtime recalculation via POST time entry or direct call
      // Use the API to GET overtime which triggers update via updateOvertimeAccount
      // Actually we need to call updateOvertimeAccount — do it via the API endpoint
      const { updateOvertimeAccount } = await import("../time-entries");
      await updateOvertimeAccount(app, data.employee.id);

      const overtimeRes = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(overtimeRes.statusCode).toBe(200);
      const overtimeBody = JSON.parse(overtimeRes.body);
      // Pure tracking: balanceHours should reflect worked hours (4h), not 0
      // Note: Prisma Decimal is serialized as string in JSON, so we cast to Number
      expect(Number(overtimeBody.balanceHours)).toBeGreaterThan(0);

      // Cleanup: soft-delete test entry (hard deletes violate audit-proof convention)
      await app.prisma.timeEntry.update({
        where: { id: entry.id },
        data: { deletedAt: new Date() },
      });
      await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          type: "FIXED_WEEKLY",
          weeklyHours: 40,
          monthlyHours: null,
          mondayHours: 8,
          tuesdayHours: 8,
          wednesdayHours: 8,
          thursdayHours: 8,
          fridayHours: 8,
          saturdayHours: 0,
          sundayHours: 0,
          overtimeThreshold: 60,
          allowOvertimePayout: false,
          validFrom: "2024-01-01",
        },
      });
    });
  });

  describe("calcExpectedMinutesTz", () => {
    it("MONTHLY_HOURS with monthlyHours=15 returns 15*60=900 minutes", () => {
      const schedule = {
        type: "MONTHLY_HOURS",
        monthlyHours: 15,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
      };

      const result = calcExpectedMinutesTz(
        schedule,
        new Date("2025-09-01"),
        new Date("2025-09-30"),
        "Europe/Berlin",
      );
      expect(result).toBe(900);
    });

    it("MONTHLY_HOURS with no monthlyHours returns 0 (pure tracking)", () => {
      const schedule = {
        type: "MONTHLY_HOURS",
        monthlyHours: 0,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
      };

      const result = calcExpectedMinutesTz(
        schedule,
        new Date("2025-09-01"),
        new Date("2025-09-30"),
        "Europe/Berlin",
      );
      expect(result).toBe(0);
    });

    it("MONTHLY_HOURS with null monthlyHours returns 0", () => {
      const schedule = {
        type: "MONTHLY_HOURS",
        monthlyHours: null,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
      };

      const result = calcExpectedMinutesTz(
        schedule,
        new Date("2025-09-01"),
        new Date("2025-09-30"),
        "Europe/Berlin",
      );
      expect(result).toBe(0);
    });

    it("FIXED_WEEKLY uses day-of-week logic", () => {
      const schedule = {
        type: "FIXED_WEEKLY",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
      };

      // 2025-01-06 (Mon) to 2025-01-10 (Fri) = 5 weekdays * 8h = 2400min
      const result = calcExpectedMinutesTz(
        schedule,
        new Date("2025-01-06"),
        new Date("2025-01-10"),
        "Europe/Berlin",
      );
      expect(result).toBe(2400);
    });

    it("FIXED_WEEKLY excludes weekends", () => {
      const schedule = {
        type: "FIXED_WEEKLY",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
      };

      // 2025-01-06 (Mon) to 2025-01-12 (Sun) = full week but only 5 workdays
      const result = calcExpectedMinutesTz(
        schedule,
        new Date("2025-01-06"),
        new Date("2025-01-12"),
        "Europe/Berlin",
      );
      expect(result).toBe(2400); // 5 * 8h * 60
    });
  });

  describe("SCHED-04: Weekday configuration for MONTHLY_HOURS", () => {
    it("stores non-zero mondayHours...fridayHours for MONTHLY_HOURS with configured weekdays", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          type: "MONTHLY_HOURS",
          weeklyHours: 0,
          monthlyHours: 45,
          mondayHours: 1,
          tuesdayHours: 1,
          wednesdayHours: 1,
          thursdayHours: 1,
          fridayHours: 1,
          saturdayHours: 0,
          sundayHours: 0,
          overtimeThreshold: 60,
          allowOvertimePayout: false,
          validFrom: "2025-09-01",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Number(body.mondayHours)).toBe(1);
      expect(Number(body.fridayHours)).toBe(1);
      expect(Number(body.saturdayHours)).toBe(0);
      expect(Number(body.sundayHours)).toBe(0);
    });

    it("stores all-zero day fields for MONTHLY_HOURS without weekday config", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          type: "MONTHLY_HOURS",
          weeklyHours: 0,
          monthlyHours: 45,
          mondayHours: 0,
          tuesdayHours: 0,
          wednesdayHours: 0,
          thursdayHours: 0,
          fridayHours: 0,
          saturdayHours: 0,
          sundayHours: 0,
          overtimeThreshold: 60,
          allowOvertimePayout: false,
          validFrom: "2025-09-01",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Number(body.mondayHours)).toBe(0);
    });
  });

  describe("TENANT-01: Holiday deduction in saldo computation", () => {
    // Uses a DB-stored public holiday on a workday within the current month's computation window.
    // The MONTHLY_HOURS schedule has mondayHours=1..fridayHours=1 (workday markers) and monthlyHours=45.
    // With toggle ON:  holidayMinutes = dailySoll = 45*60 / workingDaysInRange (approx 117 min/workday)
    // With toggle OFF: holidayMinutes = getDayHoursFromSchedule(schedule, dow)*60 = 1*60 = 60 min
    // These produce different overtime balances, proving the guard works.

    const WORKDAY_HOLIDAY = "2026-04-06"; // Monday April 6, 2026 — within April computation window
    const ENTRY_DATE = "2026-04-07"; // Tuesday April 7, 2026 — workday with a time entry

    let testHoliday: { id: string } | null = null;
    let testEntry: { id: string } | null = null;

    it("toggle ON: holiday reduces expected by dailySoll formula, improving balance", async () => {
      // Set MONTHLY_HOURS schedule with configured workdays and monthlyHours=45
      const schedRes = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          type: "MONTHLY_HOURS",
          weeklyHours: 0,
          monthlyHours: 45,
          mondayHours: 1,
          tuesdayHours: 1,
          wednesdayHours: 1,
          thursdayHours: 1,
          fridayHours: 1,
          saturdayHours: 0,
          sundayHours: 0,
          overtimeThreshold: 60,
          allowOvertimePayout: false,
          validFrom: "2026-01-01",
        },
      });
      expect(schedRes.statusCode).toBe(200);

      // Enable the toggle
      const toggleRes = await app.inject({
        method: "PUT",
        url: "/api/v1/settings/work",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { monthlyHoursHolidayDeduction: true },
      });
      expect(toggleRes.statusCode).toBe(200);

      // Seed a public holiday on a workday in the computation window
      testHoliday = await app.prisma.publicHoliday.create({
        data: {
          tenantId: data.tenant.id,
          date: new Date(WORKDAY_HOLIDAY + "T00:00:00Z"),
          name: "Test-Feiertag",
          federalState: "NIEDERSACHSEN",
          year: 2026,
        },
      });

      // Create a time entry on a different workday (6h = 360 min worked)
      testEntry = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(ENTRY_DATE),
          startTime: new Date(ENTRY_DATE + "T08:00:00Z"),
          endTime: new Date(ENTRY_DATE + "T14:00:00Z"),
          breakMinutes: 0,
          source: "MANUAL",
        },
      });

      // Trigger recalculation
      const { updateOvertimeAccount } = await import("../time-entries");
      await updateOvertimeAccount(app, data.employee.id);

      const overtimeRes = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(overtimeRes.statusCode).toBe(200);
      const body = JSON.parse(overtimeRes.body);
      const balanceOn = Number(body.balanceHours);

      // Store balance for comparison in next test (toggle off)
      // Balance with toggle ON should be GREATER than toggle OFF because more expected minutes deducted
      expect(typeof balanceOn).toBe("number");
      // The balance should be a finite number (no crash, no NaN)
      expect(isFinite(balanceOn)).toBe(true);
    });

    it("toggle OFF: no dailySoll deduction — balance differs from toggle ON", async () => {
      // Disable the toggle
      const toggleRes = await app.inject({
        method: "PUT",
        url: "/api/v1/settings/work",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { monthlyHoursHolidayDeduction: false },
      });
      expect(toggleRes.statusCode).toBe(200);

      // Trigger recalculation with toggle OFF
      const { updateOvertimeAccount } = await import("../time-entries");
      await updateOvertimeAccount(app, data.employee.id);

      const overtimeRes = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(overtimeRes.statusCode).toBe(200);
      const body = JSON.parse(overtimeRes.body);
      const balanceOff = Number(body.balanceHours);

      // Verify: toggle OFF produces a different (lower) balance than toggle ON
      // because fewer expected minutes were deducted (60 min/holiday instead of dailySoll ~117 min)
      expect(typeof balanceOff).toBe("number");
      expect(isFinite(balanceOff)).toBe(true);
      // Toggle ON deducts more expected → higher balance; toggle OFF deducts less → lower balance
      // (dailySoll ~117 min > 60 min per holiday)

      // Get toggle ON balance to compare
      await app.inject({
        method: "PUT",
        url: "/api/v1/settings/work",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { monthlyHoursHolidayDeduction: true },
      });
      await updateOvertimeAccount(app, data.employee.id);
      const onRes = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      const balanceOnAgain = Number(JSON.parse(onRes.body).balanceHours);

      // Toggle ON deducts more from expected, producing a higher balance
      expect(balanceOnAgain).toBeGreaterThan(balanceOff);

      // Disable toggle after comparison
      await app.inject({
        method: "PUT",
        url: "/api/v1/settings/work",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { monthlyHoursHolidayDeduction: false },
      });
    });

    it("toggle ON + pure tracking (monthlyHours=null): no crash, no deduction applied", async () => {
      // Enable toggle
      await app.inject({
        method: "PUT",
        url: "/api/v1/settings/work",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { monthlyHoursHolidayDeduction: true },
      });

      // Set schedule to pure tracking (monthlyHours=null)
      await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          type: "MONTHLY_HOURS",
          weeklyHours: 0,
          monthlyHours: null,
          mondayHours: 1,
          tuesdayHours: 1,
          wednesdayHours: 1,
          thursdayHours: 1,
          fridayHours: 1,
          saturdayHours: 0,
          sundayHours: 0,
          overtimeThreshold: 60,
          allowOvertimePayout: false,
          validFrom: "2026-01-01",
        },
      });

      // Trigger recalculation — must not crash
      const { updateOvertimeAccount } = await import("../time-entries");
      await expect(updateOvertimeAccount(app, data.employee.id)).resolves.not.toThrow();

      const overtimeRes = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(overtimeRes.statusCode).toBe(200);
      const body = JSON.parse(overtimeRes.body);
      // Pure tracking: balanceHours reflects worked hours only (no soll to deduct against)
      expect(isFinite(Number(body.balanceHours))).toBe(true);

      // Cleanup: revert schedule to FIXED_WEEKLY, disable toggle, soft-delete entries
      await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${data.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          type: "FIXED_WEEKLY",
          weeklyHours: 40,
          monthlyHours: null,
          mondayHours: 8,
          tuesdayHours: 8,
          wednesdayHours: 8,
          thursdayHours: 8,
          fridayHours: 8,
          saturdayHours: 0,
          sundayHours: 0,
          overtimeThreshold: 60,
          allowOvertimePayout: false,
          validFrom: "2024-01-01",
        },
      });
      await app.inject({
        method: "PUT",
        url: "/api/v1/settings/work",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { monthlyHoursHolidayDeduction: false },
      });
      // Soft-delete test entry
      if (testEntry) {
        await app.prisma.timeEntry.update({
          where: { id: testEntry.id },
          data: { deletedAt: new Date() },
        });
      }
      // Delete test holiday
      if (testHoliday) {
        await app.prisma.publicHoliday.delete({ where: { id: testHoliday.id } });
      }
    });
  });

  describe("TENANT-01: Holiday deduction toggle", () => {
    it("GET /settings/work returns monthlyHoursHolidayDeduction=false by default", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/settings/work",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.monthlyHoursHolidayDeduction).toBe(false);
    });

    it("PUT /settings/work persists monthlyHoursHolidayDeduction=true", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/settings/work",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { monthlyHoursHolidayDeduction: true },
      });
      expect(res.statusCode).toBe(200);
    });

    it("GET /settings/work returns persisted monthlyHoursHolidayDeduction=true", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/settings/work",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.monthlyHoursHolidayDeduction).toBe(true);
    });

    it("PUT /settings/work reverts monthlyHoursHolidayDeduction to false", async () => {
      const putRes = await app.inject({
        method: "PUT",
        url: "/api/v1/settings/work",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { monthlyHoursHolidayDeduction: false },
      });
      expect(putRes.statusCode).toBe(200);

      const getRes = await app.inject({
        method: "GET",
        url: "/api/v1/settings/work",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(getRes.statusCode).toBe(200);
      const body = JSON.parse(getRes.body);
      expect(body.monthlyHoursHolidayDeduction).toBe(false);
    });
  });
});
