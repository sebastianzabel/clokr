// Issue #80 (D-06, D-08, D-13, D-14, D-17, D-18) — POST / DELETE /api/v1/day-breaks/acks.
//
// A multi-entry day cannot exist in the database while the partial unique index
// `TimeEntry_employeeId_date_unique_not_deleted` holds, so the day lookup `findEntriesOfDay` is
// mocked for the constructed days only and delegates to the real implementation for every other
// date (same harness as `day-breaks.test.ts`). Everything else is real: employees, salons, role
// assignments, the month lock, DayBreakAck rows and the audit log.

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
} from "../../../../__tests__/setup";

vi.mock("../../day-entries", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../day-entries")>();
  return { ...original, findEntriesOfDay: vi.fn(original.findEntriesOfDay) };
});

import { findEntriesOfDay } from "../../day-entries";
import { checkArbZG } from "../../arbzg";

const PASSWORD = "test1234";
const DAY = "2026-03-10"; // constructed two-salon day
const mockedLookup = vi.mocked(findEntriesOfDay);

const SELF_ACK_MESSAGE = "Eigene Pausenverstöße können nicht selbst quittiert werden.";
const REASON = "Kundentermin ohne Unterbrechung";

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}
function at(hhmm: string, day = DAY): string {
  return `${day}T${hhmm}:00.000Z`;
}
function errorOf(res: { body: string }): string {
  return (JSON.parse(res.body) as { error: string }).error;
}

describe("Issue #80 — /api/v1/day-breaks/acks", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let dataB: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: string;
  let salonB: string;
  const constructedDays = new Map<string, TimeEntry[]>();

  function row(
    employeeId: string,
    day: string,
    salonId: string,
    start: string,
    end: string,
    opts: { isLocked?: boolean } = {},
  ): TimeEntry {
    return {
      id: randomUUID(),
      employeeId,
      date: dateOf(day),
      startTime: new Date(at(start, day)),
      endTime: new Date(at(end, day)),
      breakMinutes: 0,
      type: "WORK",
      source: "MANUAL",
      note: null,
      isLocked: opts.isLocked ?? false,
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

  /** 8 h net across two salons with a 30 min travel gap: a § 4 shortfall (30 min required). */
  function twoSalonDay(employeeId: string, day = DAY, opts: { isLocked?: boolean } = {}) {
    constructedDays.set(`${employeeId}:${day}`, [
      row(employeeId, day, salonA, "08:00", "12:00", opts),
      row(employeeId, day, salonB, "12:30", "16:30", opts),
    ]);
  }

  /** 11 h net across two salons: § 4 shortfall AND over the § 3 cap of 10 h. */
  function elevenHourDay(employeeId: string, day = DAY) {
    constructedDays.set(`${employeeId}:${day}`, [
      row(employeeId, day, salonA, "08:00", "13:00"),
      row(employeeId, day, salonB, "13:30", "19:30"),
    ]);
  }

  function postAck(token: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/day-breaks/acks",
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  function ackBody(employeeId: string, day = DAY, reason = REASON) {
    return { employeeId, date: day, reason };
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "daybreakacks-80");
    dataB = await seedTestData(app, "daybreakacks-80-b");
    salonA = data.salonId;
    salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "Zweiter Salon" })).id;

    const actual = await vi.importActual<typeof import("../../day-entries")>("../../day-entries");
    mockedLookup.mockImplementation(async (db, params) => {
      const constructed = constructedDays.get(
        `${params.employeeId}:${params.date.toISOString().slice(0, 10)}`,
      );
      return constructed ?? actual.findEntriesOfDay(db, params);
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
    const ids = [data.employee.id, data.adminEmployee.id, dataB.employee.id];
    await app.prisma.dayBreakAck.deleteMany({ where: { employeeId: { in: ids } } });
    await app.prisma.dayBreak.deleteMany({ where: { employeeId: { in: ids } } });
  });

  // ── Task 1: POST /acks ────────────────────────────────────────────────────

  describe("POST /acks — acknowledge a cross-salon § 4 violation (D-08, D-13, D-14, D-17, D-18)", () => {
    it("a tenant-wide manager acknowledges the A+B day: 201, the day's snapshot is stored, one audit row in the same write", async () => {
      twoSalonDay(data.employee.id);
      const res = await postAck(data.adminToken, ackBody(data.employee.id));
      expect(res.statusCode).toBe(201);
      const { acknowledgement } = JSON.parse(res.body) as {
        acknowledgement: { id: string; employeeId: string; reason: string };
      };
      expect(acknowledgement.employeeId).toBe(data.employee.id);
      expect(acknowledgement.reason).toBe(REASON);

      const rows = await app.prisma.dayBreakAck.findMany({
        where: { employeeId: data.employee.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].acknowledgedBy).toBe(data.adminUser.id);
      expect(rows[0].deletedAt).toBeNull();
      expect(rows[0].date.toISOString().slice(0, 10)).toBe(DAY);
      const entryIds = constructedDays
        .get(`${data.employee.id}:${DAY}`)!
        .map((e) => e.id)
        .sort();
      expect(rows[0].snapshot).toEqual({
        entryIds,
        salonIds: [salonA, salonB].sort(),
        netWorkedMin: 480,
        totalBreakMin: 0,
      });

      const audits = await app.prisma.auditLog.findMany({
        where: { action: "DAY_BREAK_ACK", entityId: acknowledgement.id },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].entity).toBe("DayBreakAck");
      expect(audits[0].userId).toBe(data.adminUser.id);
      const newValue = audits[0].newValue as Record<string, unknown>;
      expect(newValue.employeeId).toBe(data.employee.id);
      expect(newValue.date).toBe(DAY);
      expect(newValue.reason).toBe(REASON);
      expect(newValue.snapshot).toEqual(rows[0].snapshot);
    });

    it("D-17: afterwards checkArbZG reports the finding as a waived cross-salon warning; the § 3 cap stays an error", async () => {
      twoSalonDay(data.employee.id);
      const before = await checkArbZG(app.prisma, data.employee.id, dateOf(DAY));
      const shortBefore = before.find((w) => w.code === "BREAK_TOO_SHORT");
      expect(shortBefore?.waived).toBeUndefined();

      expect((await postAck(data.adminToken, ackBody(data.employee.id))).statusCode).toBe(201);
      const after = await checkArbZG(app.prisma, data.employee.id, dateOf(DAY));
      const shortAfter = after.find((w) => w.code === "BREAK_TOO_SHORT");
      expect(shortAfter).toMatchObject({ severity: "warning", waived: true, crossSalon: true });

      // 11 h variant: acknowledgeable (§ 4 shortfall), but MAX_DAILY_EXCEEDED is never downgraded
      elevenHourDay(data.employee.id, "2026-03-13");
      expect(
        (await postAck(data.adminToken, ackBody(data.employee.id, "2026-03-13"))).statusCode,
      ).toBe(201);
      const eleven = await checkArbZG(app.prisma, data.employee.id, dateOf("2026-03-13"));
      const max = eleven.find((w) => w.code === "MAX_DAILY_EXCEEDED");
      expect(max?.severity).toBe("error");
      expect(max?.waived).toBeUndefined();
      expect(eleven.find((w) => w.code === "BREAK_TOO_SHORT")?.waived).toBe(true);
    });

    it("a caller holding only time-entry:update:EIGENE is 403 Forbidden", async () => {
      twoSalonDay(data.employee.id);
      const res = await postAck(data.empToken, ackBody(data.employee.id));
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toBe("Forbidden");
      expect(await app.prisma.dayBreakAck.count({ where: { employeeId: data.employee.id } })).toBe(
        0,
      );
    });

    it("D-14: a manager acknowledging the own day is 403 with the self-acknowledgement wording", async () => {
      twoSalonDay(data.adminEmployee.id);
      const res = await postAck(data.adminToken, ackBody(data.adminEmployee.id));
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toBe(SELF_ACK_MESSAGE);
      expect(
        await app.prisma.dayBreakAck.count({ where: { employeeId: data.adminEmployee.id } }),
      ).toBe(0);
    });
  });
});
