// Issue #80 (80-AC3, 80-AC6; D-04, D-06, D-17) — checkArbZG reads REAL DayBreak / DayBreakAck rows.
//
// A multi-entry day cannot exist in the database while the partial unique index
// `TimeEntry_employeeId_date_unique_not_deleted` holds, so `findEntriesOfDay` is mocked and returns
// constructed rows; the DayBreak / DayBreakAck rows are real. The two store list functions are
// wrapped in delegating spies so the query discipline (80-AC6) can be counted.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { TimeEntry } from "@clokr/db";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
} from "../../../__tests__/setup";

vi.mock("../day-entries", async (importOriginal) => {
  const original = await importOriginal<typeof import("../day-entries")>();
  return { ...original, findEntriesOfDay: vi.fn(original.findEntriesOfDay) };
});

vi.mock("../day-break-store", async (importOriginal) => {
  const original = await importOriginal<typeof import("../day-break-store")>();
  return {
    ...original,
    listDayBreaksOfDay: vi.fn(original.listDayBreaksOfDay),
    listAcksOfDay: vi.fn(original.listAcksOfDay),
  };
});

import { findEntriesOfDay } from "../day-entries";
import { listDayBreaksOfDay, listAcksOfDay } from "../day-break-store";
import { evaluateDayBreaks } from "../day-break-rule";
import type { DayBreakRow } from "../day-break-rule";
import { checkArbZG } from "../arbzg";

const DAY = "2026-03-10";
const OTHER_DAY = "2026-03-11";
const DAY_DATE = new Date(`${DAY}T00:00:00.000Z`);
const mockedLookup = vi.mocked(findEntriesOfDay);
const breakSpy = vi.mocked(listDayBreaksOfDay);
const ackSpy = vi.mocked(listAcksOfDay);

function at(hhmm: string, day = DAY): Date {
  return new Date(`${day}T${hhmm}:00.000Z`);
}

describe("checkArbZG honours real DayBreak and DayBreakAck rows (Issue #80)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: string;
  let salonB: string;

  function row(
    salonId: string,
    start: string,
    end: string,
    opts: { breakMinutes?: number } = {},
  ): TimeEntry {
    return {
      id: randomUUID(),
      employeeId: data.employee.id,
      date: DAY_DATE,
      startTime: at(start),
      endTime: at(end),
      breakMinutes: opts.breakMinutes ?? 0,
      type: "WORK",
      source: "MANUAL",
      note: null,
      isLocked: false,
      lockedAt: null,
      isInvalid: false,
      invalidReason: null,
      invalidReasonCode: null,
      deletedAt: null,
      createdAt: new Date("2026-03-10T20:00:00.000Z"),
      updatedAt: new Date("2026-03-10T20:00:00.000Z"),
      createdBy: null,
      breakStatus: "CONFIRMED",
      breakWaivedReason: null,
      retroRequestId: null,
      salonId,
    } as unknown as TimeEntry;
  }

  function serveDay(rows: TimeEntry[]) {
    const sorted = [...rows].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    mockedLookup.mockImplementation(async (_db, params) =>
      params.date.getTime() === DAY_DATE.getTime() ? sorted : [],
    );
  }

  function snapshotOf(rows: TimeEntry[]) {
    const kernelRows: DayBreakRow[] = rows.map((r) => ({
      id: r.id,
      startTime: r.startTime,
      endTime: r.endTime!,
      breakMinutes: r.breakMinutes,
      breakStatus: r.breakStatus,
      salonId: r.salonId,
    }));
    return evaluateDayBreaks({ rows: kernelRows, dayBreaks: [], acks: [] }).snapshot;
  }

  async function makeDayBreak(date: string, start: string, end: string, deleted = false) {
    return app.prisma.dayBreak.create({
      data: {
        employeeId: data.employee.id,
        date: new Date(`${date}T00:00:00.000Z`),
        startTime: at(start, date),
        endTime: at(end, date),
        createdBy: data.adminUser.id,
        ...(deleted ? { deletedAt: new Date(), deletedBy: data.adminUser.id } : {}),
      },
    });
  }

  async function makeAck(snapshot: unknown, deleted = false) {
    return app.prisma.dayBreakAck.create({
      data: {
        employeeId: data.employee.id,
        date: DAY_DATE,
        reason: "Test",
        snapshot: snapshot as object,
        acknowledgedBy: data.adminUser.id,
        ...(deleted ? { deletedAt: new Date(), deletedBy: data.adminUser.id } : {}),
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "arbzg-daybreak-80");
    salonA = data.salonId;
    salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "Zweiter Salon" })).id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    mockedLookup.mockReset();
    mockedLookup.mockResolvedValue([]);
    breakSpy.mockClear();
    ackSpy.mockClear();
    await app.prisma.dayBreakAck.deleteMany({ where: { employeeId: data.employee.id } });
    await app.prisma.dayBreak.deleteMany({ where: { employeeId: data.employee.id } });
  });

  it("80-AC3/D-04: a real DayBreak in the 30-minute gap clears BREAK_TOO_SHORT", async () => {
    const rows = [row(salonA, "08:00", "12:00"), row(salonB, "12:30", "16:30")];
    serveDay(rows);
    // anti-vacuity: without the break the day is a violation
    const before = await checkArbZG(app.prisma, data.employee.id, DAY_DATE);
    expect(before.filter((w) => w.code === "BREAK_TOO_SHORT")).toHaveLength(1);

    await makeDayBreak(DAY, "12:00", "12:30");
    const after = await checkArbZG(app.prisma, data.employee.id, DAY_DATE);
    expect(after.some((w) => w.code === "BREAK_TOO_SHORT")).toBe(false);
  });

  it("D-06: the same DayBreak soft-deleted brings BREAK_TOO_SHORT back", async () => {
    serveDay([row(salonA, "08:00", "12:00"), row(salonB, "12:30", "16:30")]);
    await makeDayBreak(DAY, "12:00", "12:30", true);
    const warnings = await checkArbZG(app.prisma, data.employee.id, DAY_DATE);
    expect(warnings.filter((w) => w.code === "BREAK_TOO_SHORT")).toHaveLength(1);
  });

  it("a DayBreak dated on another day does not affect this day", async () => {
    serveDay([row(salonA, "08:00", "12:00"), row(salonB, "12:30", "16:30")]);
    await makeDayBreak(OTHER_DAY, "12:00", "12:30");
    const warnings = await checkArbZG(app.prisma, data.employee.id, DAY_DATE);
    expect(warnings.filter((w) => w.code === "BREAK_TOO_SHORT")).toHaveLength(1);
  });

  describe("D-17: a current acknowledgement downgrades the > 9 h cross-salon finding", () => {
    function nineAndAHalf() {
      return [row(salonA, "07:00", "12:30", { breakMinutes: 30 }), row(salonB, "13:00", "17:30")];
    }

    it("current snapshot: severity warning, waived, crossSalon", async () => {
      const rows = nineAndAHalf();
      serveDay(rows);
      await makeAck(snapshotOf(rows));
      const warnings = await checkArbZG(app.prisma, data.employee.id, DAY_DATE);
      const short = warnings.filter((w) => w.code === "BREAK_TOO_SHORT");
      expect(short).toHaveLength(1);
      expect(short[0].severity).toBe("warning");
      expect(short[0].waived).toBe(true);
      expect(short[0].crossSalon).toBe(true);
    });

    it("stale snapshot (netWorkedMin differs): stays an error without waived", async () => {
      const rows = nineAndAHalf();
      serveDay(rows);
      const snap = snapshotOf(rows);
      await makeAck({ ...snap, netWorkedMin: snap.netWorkedMin + 1 });
      const warnings = await checkArbZG(app.prisma, data.employee.id, DAY_DATE);
      const short = warnings.filter((w) => w.code === "BREAK_TOO_SHORT");
      expect(short).toHaveLength(1);
      expect(short[0].severity).toBe("error");
      expect("waived" in short[0]).toBe(false);
    });

    it("soft-deleted current acknowledgement: stays an error", async () => {
      const rows = nineAndAHalf();
      serveDay(rows);
      await makeAck(snapshotOf(rows), true);
      const warnings = await checkArbZG(app.prisma, data.employee.id, DAY_DATE);
      const short = warnings.filter((w) => w.code === "BREAK_TOO_SHORT");
      expect(short).toHaveLength(1);
      expect(short[0].severity).toBe("error");
    });
  });

  it("80-AC6: a single-entry day issues no day-break and no acknowledgement read", async () => {
    serveDay([row(salonA, "08:00", "16:00")]);
    await checkArbZG(app.prisma, data.employee.id, DAY_DATE);
    expect(breakSpy).toHaveBeenCalledTimes(0);
    expect(ackSpy).toHaveBeenCalledTimes(0);
  });

  it("80-AC6: a two-entry day issues exactly one day-break and one acknowledgement read", async () => {
    serveDay([row(salonA, "08:00", "12:00"), row(salonB, "12:30", "16:30")]);
    await checkArbZG(app.prisma, data.employee.id, DAY_DATE);
    expect(breakSpy).toHaveBeenCalledTimes(1);
    expect(ackSpy).toHaveBeenCalledTimes(1);
  });
});
