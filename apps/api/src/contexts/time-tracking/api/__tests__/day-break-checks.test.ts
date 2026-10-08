// Issue #80 (D-09, D-11, D-13, D-20, D-22) — GET /api/v1/day-breaks/checks.
//
// A multi-entry day cannot exist in the database while the partial unique index
// `TimeEntry_employeeId_date_unique_not_deleted` holds, so the range read of closed WORK entries
// (`getWorkedEntriesInRange`, the facade the day check reads through) is wrapped for the
// constructed days only and delegates to the real implementation for everything else. Everything
// downstream is real: employees, salons, role assignments, the month lock, DayBreak and
// DayBreakAck rows and the kernel `evaluateDayBreaks`.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
} from "../../../../__tests__/setup";
import { evaluateDayBreaks } from "../../day-break-rule";

vi.mock("../../facade/time-entries", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../facade/time-entries")>();
  return { ...original, getWorkedEntriesInRange: vi.fn(original.getWorkedEntriesInRange) };
});

// A spy on the bulk day-break/acknowledgement read, to prove (80-AC6) it is not issued for a range
// without a multi-entry day.
vi.mock("../../day-break-store", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../day-break-store")>();
  return { ...original, loadDayBreakDataForDays: vi.fn(original.loadDayBreakDataForDays) };
});

import { getWorkedEntriesInRange } from "../../facade/time-entries";
import { loadDayBreakDataForDays } from "../../day-break-store";

const DAY = "2026-03-10"; // constructed two-salon day
const mockedRange = vi.mocked(getWorkedEntriesInRange);
const mockedBulk = vi.mocked(loadDayBreakDataForDays);

interface ConstructedRow {
  id: string;
  employeeId: string;
  date: Date;
  startTime: Date;
  endTime: Date;
  breakMinutes: number;
  breakStatus: string;
  isLocked: boolean;
  salonId: string;
}

interface DayCheckBody {
  date: string;
  detail: "full" | "redacted";
  crossSalon: boolean;
  netWorkedMinutes: number;
  totalBreakMinutes: number;
  requiredBreakMinutes: number;
  breakShortfall: boolean;
  maxDailyExceeded: boolean;
  acknowledged: boolean;
  locked: boolean;
  mayAcknowledge: boolean;
  mayRecordDayBreak: boolean;
  acknowledgement: { id: string; createdAt: string; reason: string } | null;
  entries: Array<{ id: string; startTime: string; endTime: string; salonId: string }> | null;
  gaps: Array<{
    startTime: string;
    endTime: string;
    crossSalon: boolean;
    countsAsBreak: boolean;
  }> | null;
  dayBreaks: Array<{ id: string; startTime: string; endTime: string }> | null;
}

interface ChecksBody {
  employeeId: string;
  from: string;
  to: string;
  days: DayCheckBody[];
}

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}
function at(hhmm: string, day = DAY): string {
  return `${day}T${hhmm}:00.000Z`;
}
describe("Issue #80 — GET /api/v1/day-breaks/checks", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let dataB: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: string;
  let salonB: string;
  const constructedDays = new Map<string, ConstructedRow[]>();

  function row(
    employeeId: string,
    day: string,
    salonId: string,
    start: string,
    end: string,
    opts: { isLocked?: boolean } = {},
  ): ConstructedRow {
    return {
      id: randomUUID(),
      employeeId,
      date: dateOf(day),
      startTime: new Date(at(start, day)),
      endTime: new Date(at(end, day)),
      breakMinutes: 0,
      breakStatus: "CONFIRMED",
      isLocked: opts.isLocked ?? false,
      salonId,
    };
  }

  /** 8 h net across two salons with a 30 min travel gap: a § 4 shortfall (30 min required). */
  function twoSalonDay(employeeId: string, day = DAY, opts: { isLocked?: boolean } = {}) {
    const rows = [
      row(employeeId, day, salonA, "08:00", "12:00", opts),
      row(employeeId, day, salonB, "12:30", "16:30", opts),
    ];
    constructedDays.set(`${employeeId}:${day}`, rows);
    return rows;
  }

  function getChecks(token: string, employeeId: string, from = "2026-03-01", to = "2026-03-31") {
    return app.inject({
      method: "GET",
      url: `/api/v1/day-breaks/checks?employeeId=${employeeId}&from=${from}&to=${to}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function checksOf(token: string, employeeId: string, from?: string, to?: string) {
    const res = await getChecks(token, employeeId, from, to);
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as ChecksBody;
  }

  async function seedDayBreak(employeeId: string, day: string, start: string, end: string) {
    return app.prisma.dayBreak.create({
      data: {
        employeeId,
        date: dateOf(day),
        startTime: new Date(at(start, day)),
        endTime: new Date(at(end, day)),
        createdBy: data.adminUser.id,
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "daybreakchecks-80");
    dataB = await seedTestData(app, "daybreakchecks-80-b");
    salonA = data.salonId;
    salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "Zweiter Salon" })).id;

    const actual = await vi.importActual<typeof import("../../facade/time-entries")>(
      "../../facade/time-entries",
    );
    mockedRange.mockImplementation(async (db, scope, from, to) => {
      const real = await actual.getWorkedEntriesInRange(db, scope, from, to);
      if (scope.kind !== "employee") return real;
      const extra: ConstructedRow[] = [];
      for (const [key, rows] of constructedDays) {
        if (!key.startsWith(`${scope.employeeId}:`)) continue;
        const date = rows[0].date;
        if (date >= from && date <= to) extra.push(...rows);
      }
      return [...real, ...extra] as typeof real;
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, dataB.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    constructedDays.clear();
    mockedBulk.mockClear();
    const ids = [data.employee.id, data.adminEmployee.id, dataB.employee.id];
    await app.prisma.dayBreakAck.deleteMany({ where: { employeeId: { in: ids } } });
    await app.prisma.dayBreak.deleteMany({ where: { employeeId: { in: ids } } });
  });

  // ── Task 1: the employee's own days, the kernel gaps, the empty list ──────

  describe("own days (D-09, D-20, D-22, 80-AC5, 80-AC6)", () => {
    it("80-AC6: real single-entry data over a month yields an empty list and no day-break or acknowledgement read", async () => {
      const dates = ["2026-03-02", "2026-03-03", "2026-03-04"];
      for (const d of dates) {
        await app.prisma.timeEntry.create({
          data: {
            employeeId: data.employee.id,
            date: dateOf(d),
            startTime: new Date(at("08:00", d)),
            endTime: new Date(at("16:00", d)),
            breakMinutes: 30,
            type: "WORK",
            source: "MANUAL",
            salonId: salonA,
          },
        });
      }
      try {
        const body = await checksOf(data.empToken, data.employee.id);
        expect(body).toEqual({
          employeeId: data.employee.id,
          from: "2026-03-01",
          to: "2026-03-31",
          days: [],
        });
        expect(mockedBulk).not.toHaveBeenCalled();
      } finally {
        await app.prisma.timeEntry.deleteMany({
          where: { employeeId: data.employee.id, date: { in: dates.map(dateOf) } },
        });
      }
    });

    it("the employee sees the own A+B day in full: two entries, one kernel gap, the shortfall; no acknowledgement offer (D-14), a day break may be recorded", async () => {
      const rows = twoSalonDay(data.employee.id);
      const body = await checksOf(data.empToken, data.employee.id);
      expect(body.days).toHaveLength(1);
      const day = body.days[0];
      expect(day).toEqual({
        date: DAY,
        detail: "full",
        crossSalon: true,
        netWorkedMinutes: 480,
        totalBreakMinutes: 0,
        requiredBreakMinutes: 30,
        breakShortfall: true,
        maxDailyExceeded: false,
        acknowledged: false,
        locked: false,
        mayAcknowledge: false,
        mayRecordDayBreak: true,
        acknowledgement: null,
        entries: rows.map((r) => ({
          id: r.id,
          startTime: r.startTime.toISOString(),
          endTime: r.endTime.toISOString(),
          salonId: r.salonId,
        })),
        gaps: [
          {
            startTime: at("12:00"),
            endTime: at("12:30"),
            crossSalon: true,
            countsAsBreak: false,
          },
        ],
        dayBreaks: [],
      });
    });

    it("D-22: the response gaps are the kernel's own gap list, mapped one to one", async () => {
      const rows = twoSalonDay(data.employee.id);
      await seedDayBreak(data.employee.id, DAY, "12:00", "12:10");
      const body = await checksOf(data.empToken, data.employee.id);
      const kernel = evaluateDayBreaks({ rows, dayBreaks: [], acks: [] });
      expect(kernel.gaps.length).toBeGreaterThan(0);
      expect(body.days[0].gaps).toEqual(
        kernel.gaps.map((g) => ({
          startTime: g.startTime.toISOString(),
          endTime: g.endTime.toISOString(),
          crossSalon: g.crossSalon,
          countsAsBreak: g.countsAsBreak,
        })),
      );
    });

    it("a recorded day break inside the gap is listed and clears the shortfall", async () => {
      twoSalonDay(data.employee.id);
      const dayBreak = await seedDayBreak(data.employee.id, DAY, "12:00", "12:30");
      const day = (await checksOf(data.empToken, data.employee.id)).days[0];
      expect(day.dayBreaks).toEqual([
        { id: dayBreak.id, startTime: at("12:00"), endTime: at("12:30") },
      ]);
      expect(day.totalBreakMinutes).toBe(30);
      expect(day.breakShortfall).toBe(false);
    });

    it("80-AC5: reading writes no TimeEntry, DayBreak, DayBreakAck or audit row", async () => {
      twoSalonDay(data.employee.id);
      const count = async () => ({
        entries: await app.prisma.timeEntry.count({ where: { employeeId: data.employee.id } }),
        breaks: await app.prisma.dayBreak.count({ where: { employeeId: data.employee.id } }),
        acks: await app.prisma.dayBreakAck.count({ where: { employeeId: data.employee.id } }),
        audits: await app.prisma.auditLog.count({
          where: { entity: { in: ["DayBreak", "DayBreakAck", "TimeEntry"] } },
        }),
      });
      const before = await count();
      await checksOf(data.empToken, data.employee.id);
      await checksOf(data.adminToken, data.employee.id);
      expect(await count()).toEqual(before);
    });
  });
});
