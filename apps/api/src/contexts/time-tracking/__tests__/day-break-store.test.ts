// Issue #80 (D-03/D-06) — the day-break store: tenant binding, soft delete, bulk bounds, the
// closed-WORK day filter and the range delegation.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { TimeEntry } from "@clokr/db";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";

vi.mock("../day-entries", async (importOriginal) => {
  const original = await importOriginal<typeof import("../day-entries")>();
  return { ...original, findEntriesOfDay: vi.fn(original.findEntriesOfDay) };
});

import { findEntriesOfDay } from "../day-entries";
import { getWorkedEntriesInRange } from "../facade/time-entries";
import {
  listDayBreaksOfDay,
  listAcksOfDay,
  loadDayBreakDataForDays,
  closedWorkRowsOfDay,
  closedWorkRowsInRange,
} from "../day-break-store";

const DAY = "2026-03-10";
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const mockedLookup = vi.mocked(findEntriesOfDay);

describe("day-break-store (Issue #80)", () => {
  let app: FastifyInstance;
  let a: Awaited<ReturnType<typeof seedTestData>>;
  let b: Awaited<ReturnType<typeof seedTestData>>;
  let aSecondEmployeeId: string;

  async function seedRows(employeeId: string, date: string, opts: { deleted?: boolean } = {}) {
    const deleted = opts.deleted ? { deletedAt: new Date(), deletedBy: "test" } : {};
    const dayBreak = await app.prisma.dayBreak.create({
      data: {
        employeeId,
        date: d(date),
        startTime: new Date(`${date}T12:00:00.000Z`),
        endTime: new Date(`${date}T12:30:00.000Z`),
        ...deleted,
      },
    });
    const ack = await app.prisma.dayBreakAck.create({
      data: {
        employeeId,
        date: d(date),
        reason: "Test",
        snapshot: { entryIds: [], salonIds: [], netWorkedMin: 0, totalBreakMin: 0 },
        acknowledgedBy: "test",
        ...deleted,
      },
    });
    return { dayBreak, ack };
  }

  beforeAll(async () => {
    app = await getTestApp();
    a = await seedTestData(app, "daybreak-store-a");
    b = await seedTestData(app, "daybreak-store-b");
    // A second employee of tenant A for the bulk read.
    const empUser = await app.prisma.user.create({
      data: {
        email: `second-${randomUUID()}@example.test`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await app.prisma.employee.create({
      data: {
        tenantId: a.tenant.id,
        userId: empUser.id,
        employeeNumber: `E-2-${randomUUID().slice(0, 6)}`,
        firstName: "Zweite",
        lastName: "Person",
        hireDate: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    aSecondEmployeeId = emp.id;
  });

  afterAll(async () => {
    for (const x of [a, b]) {
      try {
        await cleanupTestData(app, x.tenant.id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
    await closeTestApp();
  });

  it("T-80-08: reads bind the employee to the tenant — a foreign tenant id gets nothing", async () => {
    const ownA = await seedRows(a.employee.id, DAY);
    const ownB = await seedRows(b.employee.id, DAY);

    const mine = await listDayBreaksOfDay(app.prisma, {
      tenantId: a.tenant.id,
      employeeId: a.employee.id,
      date: d(DAY),
    });
    expect(mine.map((r) => r.id)).toEqual([ownA.dayBreak.id]);
    const myAcks = await listAcksOfDay(app.prisma, {
      tenantId: a.tenant.id,
      employeeId: a.employee.id,
      date: d(DAY),
    });
    expect(myAcks.map((r) => r.id)).toEqual([ownA.ack.id]);

    // tenant A's id with tenant B's employee id: nothing, although rows exist
    expect(ownB.dayBreak.id).toBeTruthy();
    expect(
      await listDayBreaksOfDay(app.prisma, {
        tenantId: a.tenant.id,
        employeeId: b.employee.id,
        date: d(DAY),
      }),
    ).toEqual([]);
    expect(
      await listAcksOfDay(app.prisma, {
        tenantId: a.tenant.id,
        employeeId: b.employee.id,
        date: d(DAY),
      }),
    ).toEqual([]);
  });

  it("D-06: soft-deleted rows are never returned by any store read", async () => {
    const date = "2026-04-20";
    await seedRows(a.employee.id, date, { deleted: true });
    const params = { tenantId: a.tenant.id, employeeId: a.employee.id, date: d(date) };
    expect(await listDayBreaksOfDay(app.prisma, params)).toEqual([]);
    expect(await listAcksOfDay(app.prisma, params)).toEqual([]);
    const bulk = await loadDayBreakDataForDays(app.prisma, {
      tenantId: a.tenant.id,
      employeeIds: [a.employee.id],
      from: d("2026-04-20"),
      to: d("2026-04-20"),
    });
    expect(bulk).toEqual({ dayBreaks: [], acks: [] });
  });

  it("loadDayBreakDataForDays with no employees returns empty arrays and issues no query", async () => {
    const spy = vi.fn();
    const wrapper = {
      dayBreak: { findMany: spy },
      dayBreakAck: { findMany: spy },
    } as unknown as Parameters<typeof loadDayBreakDataForDays>[0];
    const out = await loadDayBreakDataForDays(wrapper, {
      tenantId: a.tenant.id,
      employeeIds: [],
      from: d("2026-03-01"),
      to: d("2026-03-31"),
    });
    expect(out).toEqual({ dayBreaks: [], acks: [] });
    expect(spy).not.toHaveBeenCalled();
  });

  it("loadDayBreakDataForDays returns only rows inside the inclusive bounds", async () => {
    const dates = ["2026-02-28", "2026-03-01", "2026-03-15", "2026-03-31", "2026-04-01"];
    for (const date of dates) await seedRows(aSecondEmployeeId, date);
    const out = await loadDayBreakDataForDays(app.prisma, {
      tenantId: a.tenant.id,
      employeeIds: [a.employee.id, aSecondEmployeeId],
      from: d("2026-03-01"),
      to: d("2026-03-31"),
    });
    const inBreaks = out.dayBreaks.map((r) => r.date.toISOString().slice(0, 10));
    const inAcks = out.acks.map((r) => r.date.toISOString().slice(0, 10));
    for (const list of [inBreaks, inAcks]) {
      expect(list).toContain("2026-03-01");
      expect(list).toContain("2026-03-15");
      expect(list).toContain("2026-03-31");
      expect(list).not.toContain("2026-02-28");
      expect(list).not.toContain("2026-04-01");
    }
    // tenant binding in the bulk read: tenant B's employee is never returned
    const foreign = await loadDayBreakDataForDays(app.prisma, {
      tenantId: a.tenant.id,
      employeeIds: [b.employee.id],
      from: d("2026-03-01"),
      to: d("2026-03-31"),
    });
    expect(foreign).toEqual({ dayBreaks: [], acks: [] });
  });

  it("closedWorkRowsOfDay keeps only closed WORK rows, in start order", async () => {
    function row(
      id: string,
      start: string,
      end: string | null,
      type: "WORK" | "SICK" = "WORK",
    ): TimeEntry {
      return {
        id,
        employeeId: a.employee.id,
        date: d(DAY),
        startTime: new Date(`${DAY}T${start}:00.000Z`),
        endTime: end ? new Date(`${DAY}T${end}:00.000Z`) : null,
        breakMinutes: 0,
        type,
        isLocked: false,
        breakStatus: "CONFIRMED",
        salonId: a.salonId,
      } as unknown as TimeEntry;
    }
    mockedLookup.mockResolvedValueOnce([
      row("open", "06:00", null),
      row("early", "08:00", "12:00"),
      row("other-type", "12:30", "13:00", "SICK"),
      row("late", "13:00", "17:00"),
    ]);
    const rows = await closedWorkRowsOfDay(app.prisma, {
      tenantId: a.tenant.id,
      employeeId: a.employee.id,
      date: d(DAY),
    });
    expect(rows.map((r) => r.id)).toEqual(["early", "late"]);
    expect(rows[0].endTime).toBeInstanceOf(Date);
  });

  it("closedWorkRowsInRange returns exactly what getWorkedEntriesInRange returns (delegation)", async () => {
    const date = "2026-05-12";
    await app.prisma.timeEntry.create({
      data: {
        employeeId: a.employee.id,
        date: d(date),
        startTime: new Date(`${date}T08:00:00.000Z`),
        endTime: new Date(`${date}T16:00:00.000Z`),
        salonId: a.salonId,
      },
    });
    const scope = { kind: "employee", employeeId: a.employee.id, tenantId: a.tenant.id } as const;
    const direct = await getWorkedEntriesInRange(
      app.prisma,
      scope,
      d("2026-05-01"),
      d("2026-05-31"),
    );
    const viaStore = await closedWorkRowsInRange(
      app.prisma,
      scope,
      d("2026-05-01"),
      d("2026-05-31"),
    );
    expect(direct.length).toBeGreaterThan(0); // anti-vacuity
    expect(viaStore).toEqual(direct);
  });
});
