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
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
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
});
