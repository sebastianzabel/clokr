import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
} from "../../../../__tests__/setup";
import { calcExpectedMinutesTz } from "../../../working-time-account/timezone";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

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
      // Set schedule to pure tracking (monthlyHours = null).
      // validFrom must be a month-1st date that does NOT collide with an existing row of a
      // different type (Phase 76.24 model-switch-same-month guard). The seed creates a
      // FIXED_SCHEDULE row at 2024-01-01, so we use a distinct month-1st date here.
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
          validFrom: "2025-01-01",
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
          salonId: data.salonId, // Phase 68b (issue #68)
        },
      });

      // Trigger overtime recalculation via POST time entry or direct call
      // Use the API to GET overtime which triggers update via updateOvertimeAccount
      // Actually we need to call updateOvertimeAccount — do it via the API endpoint
      const { updateOvertimeAccount } = await import("../../../time-tracking/api/time-entries");
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
          type: "FIXED_SCHEDULE",
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

    it("FIXED_SCHEDULE uses day-of-week logic", () => {
      const schedule = {
        type: "FIXED_SCHEDULE",
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

    it("FIXED_SCHEDULE excludes weekends", () => {
      const schedule = {
        type: "FIXED_SCHEDULE",
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
    // Issue #433 (D-03, plan 02): the retired tenant switch (see the separate "Holiday
    // deduction toggle" describe below for its GET/PUT persistence, plan 04's territory)
    // has no effect any more — a holiday on a contractual workday ALWAYS reduces the Soll.
    // The former ON-vs-OFF comparison this block used to run is void; it is rewritten to assert
    // the D-03 rule over HTTP directly, without ever touching the switch.
    //
    // Two dedicated MONTHLY_HOURS employees, hire 2026-04-01, monthlyHours=45 (2700 min),
    // {day}Hours all 0 (prod shape, D-05 — workDays carries the contract), one 6h (360 min)
    // entry on Tue 2026-04-07:
    //   - employeeMoFri: workDays=[1,2,3,4,5]
    //   - employeeTueThu: workDays=[2,3,4]
    //
    // Fake clock pinned to 2026-04-15T10:00Z (unchanged from before this plan): the live
    // saldo window is 01.-14.04. (yesterday rule, #438), April 2026 starts Wednesday with 22
    // Mo-Fr / 14 Tue-Thu days (full month, D-06 denominator).
    const ENTRY_DATE = "2026-04-07"; // Tuesday — a workday for BOTH workday sets
    const HIRE_DATE = new Date("2026-04-01T00:00:00Z");

    let employeeMoFriId: string;
    let employeeTueThuId: string;

    beforeAll(async () => {
      vi.useFakeTimers({ now: new Date("2026-04-15T10:00:00.000Z"), toFake: ["Date"] });

      const s = `mj433-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

      async function createMonthlyHoursEmployee(
        label: string,
        workDays: number[],
      ): Promise<string> {
        const user = await app.prisma.user.create({
          data: {
            email: `${label}-${s}@test.de`,
            passwordHash: await bcrypt.hash("test1234", 10),
            role: "EMPLOYEE",
            isActive: true,
          },
        });
        const employee = await app.prisma.employee.create({
          data: {
            tenantId: data.tenant.id,
            userId: user.id,
            employeeNumber: `${label}-${s}`,
            firstName: "Mini",
            lastName: label,
            hireDate: HIRE_DATE,
          },
        });
        await app.prisma.workSchedule.create({
          data: {
            employeeId: employee.id,
            type: "MONTHLY_HOURS",
            weeklyHours: 0,
            monthlyHours: 45,
            // Prod shape (D-05): {day}Hours are placeholders, workDays carries the contract.
            mondayHours: 0,
            tuesdayHours: 0,
            wednesdayHours: 0,
            thursdayHours: 0,
            fridayHours: 0,
            saturdayHours: 0,
            sundayHours: 0,
            workDays,
            validFrom: HIRE_DATE,
          },
        });
        await app.prisma.overtimeAccount.create({
          data: { employeeId: employee.id, balanceHours: 0 },
        });
        await app.prisma.timeEntry.create({
          data: {
            employeeId: employee.id,
            date: new Date(ENTRY_DATE),
            startTime: new Date(ENTRY_DATE + "T08:00:00Z"),
            endTime: new Date(ENTRY_DATE + "T14:00:00Z"),
            breakMinutes: 0,
            source: "MANUAL",
            salonId: data.salonId, // Phase 68b (issue #68)
          },
        });
        return employee.id;
      }

      employeeMoFriId = await createMonthlyHoursEmployee("mofri", [1, 2, 3, 4, 5]);
      employeeTueThuId = await createMonthlyHoursEmployee("tuethu", [2, 3, 4]);
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    it("D-03: Mo-Fr contract — Karfreitag + Ostermontag (both Mo-Fr) reduce the Soll", async () => {
      // Window 01.-14.04: 10 Mo-Fr workdays; April 2026 (full month) has 22 Mo-Fr days.
      // E = round(2700*10/22) = 1227. Karfreitag (03.04., Fri) + Ostermontag (06.04., Mon)
      // are both Mo-Fr workdays -> holiday = round(2700*2/22) = 245. Worked = 360 (one 6h
      // entry on 07.04.). balance = 360 - (1227 - 245) = -622 min = -622/60 h.
      const { updateOvertimeAccount } = await import("../../../time-tracking/api/time-entries");
      await updateOvertimeAccount(app, employeeMoFriId);

      const overtimeRes = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${employeeMoFriId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(overtimeRes.statusCode).toBe(200);
      const body = JSON.parse(overtimeRes.body);
      expect(Number(body.balanceHours)).toBeCloseTo(-622 / 60, 2);
    });

    it("D-03/D-05: Tue-Thu contract — the SAME holidays are non-workdays, nothing is deducted", async () => {
      // Window 01.-14.04: 6 Tue-Thu days (01,02,07,08,09,14); April 2026 (full month) has 14
      // Tue-Thu days. E = round(2700*6/14) = 1157. Karfreitag (Fri) and Ostermontag (Mon) are
      // NOT in the Tue-Thu workday set -> holiday deduction = 0 (D-03: no causality on a
      // non-workday). Worked = 360. balance = 360 - 1157 = -797 min = -797/60 h.
      const { updateOvertimeAccount } = await import("../../../time-tracking/api/time-entries");
      await updateOvertimeAccount(app, employeeTueThuId);

      const overtimeRes = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${employeeTueThuId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(overtimeRes.statusCode).toBe(200);
      const body = JSON.parse(overtimeRes.body);
      expect(Number(body.balanceHours)).toBeCloseTo(-797 / 60, 2);
    });

    it("pure tracking (monthlyHours=null) — no crash, no deduction applied", async () => {
      const s = `mj433-null-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const user = await app.prisma.user.create({
        data: {
          email: `null-${s}@test.de`,
          passwordHash: await bcrypt.hash("test1234", 10),
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const employee = await app.prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: user.id,
          employeeNumber: `NULL-${s}`,
          firstName: "Mini",
          lastName: "Null",
          hireDate: HIRE_DATE,
        },
      });
      await app.prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
          type: "MONTHLY_HOURS",
          weeklyHours: 0,
          monthlyHours: null,
          mondayHours: 0,
          tuesdayHours: 0,
          wednesdayHours: 0,
          thursdayHours: 0,
          fridayHours: 0,
          saturdayHours: 0,
          sundayHours: 0,
          workDays: [1, 2, 3, 4, 5],
          validFrom: HIRE_DATE,
        },
      });
      await app.prisma.overtimeAccount.create({
        data: { employeeId: employee.id, balanceHours: 0 },
      });

      const { updateOvertimeAccount } = await import("../../../time-tracking/api/time-entries");
      await expect(updateOvertimeAccount(app, employee.id)).resolves.not.toThrow();

      const overtimeRes = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(overtimeRes.statusCode).toBe(200);
      const body = JSON.parse(overtimeRes.body);
      // Pure tracking: balanceHours reflects worked hours only (no soll to deduct against).
      expect(isFinite(Number(body.balanceHours))).toBe(true);
    });
  });

  describe("Issue #433 — retired MONTHLY_HOURS holiday switch (D-04)", () => {
    it("GET /settings/work no longer returns the retired holiday-deduction switch", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/settings/work",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).not.toHaveProperty("monthlyHoursHolidayDeduction");
    });

    it("PUT /settings/work with the legacy key is accepted (200), the key is stripped from the response, and the retired column is never written", async () => {
      const putRes = await app.inject({
        method: "PUT",
        url: "/api/v1/settings/work",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { monthlyHoursHolidayDeduction: true },
      });
      expect(putRes.statusCode).toBe(200);
      const putBody = JSON.parse(putRes.body);
      expect(putBody).not.toHaveProperty("monthlyHoursHolidayDeduction");

      // Issue #433 (D-04): the ONE sanctioned direct-DB read of the retired column in this
      // codebase outside the omit constant in settings.ts itself — proves the legacy PUT above
      // never wrote it. The column stays for image-rollback safety until the follow-up release
      // (GitHub #470) drops it.
      const stored = await app.prisma.tenantConfig.findUnique({
        where: { tenantId: data.tenant.id },
      });
      expect(stored?.monthlyHoursHolidayDeduction).toBe(false);
    });
  });
});
