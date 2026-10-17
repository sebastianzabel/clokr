/**
 * Issue #617 (D-617-5, P-06) - the day list of the Stundennachweis (`GET /reports/monthly/pdf`).
 * PDF bytes are Flate-compressed, so the generator is spied and the payload handed to it is
 * asserted (the idiom of report-identity-451.test.ts).
 *
 * Task 2: entries of one day are listed in start-time order.
 * Task 3 (below): the periods of effective leave / imposed absences and the holidays at the work
 * location appear as labelled rows.
 *
 * The month under test (September 2026) lies in the past of any real run, so no clock is faked.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import * as pdfUtils from "../composition/pdf";

vi.mock("../composition/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../composition/pdf")>();
  return {
    ...actual,
    generateMonthlyReportPdf: vi.fn(actual.generateMonthlyReportPdf),
  };
});

describe("Stundennachweis day list (Issue #617)", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;

  async function payloadFor(employeeId: string, token: string, year: number, month: number) {
    const spy = vi.mocked(pdfUtils.generateMonthlyReportPdf);
    spy.mockClear();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly/pdf?employeeId=${employeeId}&year=${year}&month=${month}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    return spy.mock.calls[0][0];
  }

  async function entry(employeeId: string, day: string, start: string, end: string) {
    await app.prisma.timeEntry.create({
      data: {
        employeeId,
        date: new Date(`${day}T00:00:00Z`),
        startTime: new Date(`${day}T${start}:00Z`),
        endTime: new Date(`${day}T${end}:00Z`),
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
        salonId: d.salonId,
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "sn617");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, d.tenant.id);
    } catch (err) {
      console.error("stundennachweis-day-rows-617 cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("entry order (#70: several entries per day)", () => {
    it("two entries of one day, created in reverse start order, are listed by start time", async () => {
      // The later block is created FIRST, so insertion order / id order is the wrong order.
      await entry(d.employee.id, "2026-09-02", "12:00", "14:00");
      await entry(d.employee.id, "2026-09-02", "06:00", "10:00");
      await entry(d.employee.id, "2026-09-01", "07:00", "09:00");

      const payload = await payloadFor(d.employee.id, d.adminToken, 2026, 9);
      expect(payload.entries.map((e) => `${e.date} ${e.start}`)).toEqual([
        // Tenant time zone is Europe/Berlin (CEST, UTC+2).
        "01.09.2026 09:00",
        "02.09.2026 08:00",
        "02.09.2026 14:00",
      ]);
    });
  });

  describe("absence and holiday rows (D-617-5, P-06)", () => {
    let sickTypeId = "";

    async function leave(
      employeeId: string,
      leaveTypeId: string,
      from: string,
      to: string,
      extra: {
        status?: "APPROVED" | "PENDING" | "CANCELLATION_REQUESTED";
        halfDay?: boolean;
        deletedAt?: Date;
        days?: number;
      } = {},
    ) {
      await app.prisma.leaveRequest.create({
        data: {
          employeeId,
          leaveTypeId,
          startDate: new Date(`${from}T00:00:00Z`),
          endDate: new Date(`${to}T00:00:00Z`),
          days: extra.days ?? 1,
          halfDay: extra.halfDay ?? false,
          status: extra.status ?? "APPROVED",
          deletedAt: extra.deletedAt ?? null,
        },
      });
    }

    beforeAll(async () => {
      // A tenant can rename its vacation type: the row label must still be the display text of the
      // CODE, never the stored name.
      await app.prisma.leaveType.update({
        where: { id: d.vacationType.id },
        data: { name: "Erholung" },
      });
      const sick = await app.prisma.leaveType.create({
        data: { tenantId: d.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
      });
      sickTypeId = sick.id;

      const emp = d.employee.id;
      // Mon-Wed, renamed type.
      await leave(emp, d.vacationType.id, "2026-09-07", "2026-09-09", { days: 3 });
      // Sick Mon-Tue (rows of sickness stay: payroll relevant, EFZG).
      await leave(emp, sickTypeId, "2026-09-14", "2026-09-15", { days: 2 });
      // A half day.
      await leave(emp, d.vacationType.id, "2026-09-17", "2026-09-17", {
        halfDay: true,
        days: 0.5,
      });
      // Not effective: PENDING, soft-deleted.
      await leave(emp, d.vacationType.id, "2026-09-21", "2026-09-22", {
        status: "PENDING",
        days: 2,
      });
      await leave(emp, d.vacationType.id, "2026-09-28", "2026-09-28", {
        deletedAt: new Date("2026-09-01T10:00:00Z"),
      });
      // Leave stays active while a cancellation is requested.
      await leave(emp, d.vacationType.id, "2026-09-23", "2026-09-24", {
        status: "CANCELLATION_REQUESTED",
        days: 2,
      });
      // Crossing both month edges: clipped to the month.
      await leave(emp, d.vacationType.id, "2026-08-31", "2026-09-01", { days: 2 });
      await leave(emp, d.vacationType.id, "2026-09-29", "2026-10-02", { days: 4 });
      // An imposed absence.
      await app.prisma.absence.create({
        data: {
          employeeId: emp,
          type: "VOCATIONAL_SCHOOL",
          startDate: new Date("2026-09-10T00:00:00Z"),
          endDate: new Date("2026-09-10T00:00:00Z"),
          days: 1,
          createdBy: d.adminUser.id,
        },
      });
    });

    it("lists the periods of effective leave and imposed absences, clipped to the month, labelled by code", async () => {
      const payload = await payloadFor(d.employee.id, d.adminToken, 2026, 9);
      expect(payload.dayRows).toEqual([
        // 31.08.-01.09. clipped to the 1st
        { from: "2026-09-01", to: "2026-09-01", label: "Urlaub" },
        { from: "2026-09-07", to: "2026-09-09", label: "Urlaub" }, // type renamed to "Erholung"
        { from: "2026-09-10", to: "2026-09-10", label: "Berufsschule" },
        { from: "2026-09-14", to: "2026-09-15", label: "Krankmeldung" },
        { from: "2026-09-17", to: "2026-09-17", label: "Urlaub (halber Tag)" },
        { from: "2026-09-23", to: "2026-09-24", label: "Urlaub" }, // CANCELLATION_REQUESTED stays
        // 29.09.-02.10. clipped to the 30th
        { from: "2026-09-29", to: "2026-09-30", label: "Urlaub" },
      ]);
      // Neither the PENDING request (21.-22.) nor the soft-deleted one (28.) is a row, and the stored
      // type name never reaches the label.
      expect(JSON.stringify(payload.dayRows)).not.toContain("Erholung");
    });

    it("the person themself gets the same rows (report:export:EIGENE)", async () => {
      const own = await payloadFor(d.employee.id, d.empToken, 2026, 9);
      const admin = await payloadFor(d.employee.id, d.adminToken, 2026, 9);
      expect(own.dayRows).toEqual(admin.dayRows);
      expect(own.dayRows.length).toBeGreaterThan(0);
    });

    it("a holiday follows the work location of the day: a Bavarian salon entry gets Fronleichnam, the default salon does not", async () => {
      // 04.06.2026 is Fronleichnam: a holiday in Bayern, none in the tenant's Niedersachsen default.
      const bavaria = await createTestSalon(app.prisma, d.tenant.id, {
        name: "Salon Bayern 617",
        federalState: "BAYERN",
      });
      await app.prisma.timeEntry.create({
        data: {
          employeeId: d.employee.id,
          date: new Date("2026-06-04T00:00:00Z"),
          startTime: new Date("2026-06-04T07:00:00Z"),
          endTime: new Date("2026-06-04T15:00:00Z"),
          breakMinutes: 30,
          type: "WORK",
          source: "MANUAL",
          salonId: bavaria.id,
        },
      });
      const worked = await payloadFor(d.employee.id, d.adminToken, 2026, 6);
      expect(worked.dayRows).toEqual([
        { from: "2026-06-04", to: "2026-06-04", label: "Feiertag: Fronleichnam" },
      ]);

      // The other person of the tenant has no entry that day: the default salon decides.
      const elsewhere = await payloadFor(d.adminEmployee.id, d.adminToken, 2026, 6);
      expect(elsewhere.dayRows).toEqual([]);
    });

    it("a holiday before the hire day or after the exit day is no row of that person (Issue #617, 617-05 decision)", async () => {
      // May 2026 in the default salon (Niedersachsen): 01.05. Tag der Arbeit, 14.05. Christi Himmelfahrt,
      // 25.05. Pfingstmontag. A control person employed the whole month sees all three.
      const emp = d.adminEmployee.id;
      const original = { hireDate: d.adminEmployee.hireDate, exitDate: d.adminEmployee.exitDate };
      try {
        const control = await payloadFor(emp, d.adminToken, 2026, 5);
        expect(control.dayRows.map((r) => r.from)).toEqual([
          "2026-05-01",
          "2026-05-14",
          "2026-05-25",
        ]);

        // Hired on the 12th: the holiday of the 1st lies before the hire day.
        await app.prisma.employee.update({
          where: { id: emp },
          data: { hireDate: new Date("2026-05-12T10:00:00Z") },
        });
        const hired = await payloadFor(emp, d.adminToken, 2026, 5);
        expect(hired.dayRows.map((r) => r.from)).toEqual(["2026-05-14", "2026-05-25"]);

        // Leaving on the 20th: the holiday of the 25th lies after the exit day.
        await app.prisma.employee.update({
          where: { id: emp },
          data: { exitDate: new Date("2026-05-20T10:00:00Z") },
        });
        const leaving = await payloadFor(emp, d.adminToken, 2026, 5);
        expect(leaving.dayRows).toEqual([
          { from: "2026-05-14", to: "2026-05-14", label: "Feiertag: Christi Himmelfahrt" },
        ]);
      } finally {
        await app.prisma.employee.update({ where: { id: emp }, data: original });
      }
    });
  });
});
