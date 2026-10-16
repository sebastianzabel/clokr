/**
 * Issue #80 (D-09b, D-15, D-17, D-18) — the Monatsabschluss refuses to lock a month that still
 * contains an unacknowledged cross-salon § 4 ArbZG violation.
 *
 * Since #70 (Phase 70b) such days exist in the database; the mocks here stay pure-kernel
 * proofs. Real-database proofs of several entries per day: time-entry-multi-entry-70,
 * multi-entry-month-close-70, multi-entry-saldo-equality-70. The closed-WORK-entry read of the
 * facade (`getWorkedEntriesInRange`, T2 — the read every month-close consumer uses) is mocked for
 * the constructed days only: for the test employee and day the constructed two-salon rows replace
 * the real row; every other employee and day delegates to the real implementation. Everything else
 * is real: employees, salons, tenant config, DayBreak / DayBreakAck rows, the month lock and the
 * saldo snapshot.
 *
 * Each case uses its own employee because a successful close writes a snapshot.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  cleanupTestData,
  createTestSalon,
  grantSystemRole,
} from "./setup";
import { getDeferredMonthCloseState } from "../contexts/working-time-account/deferred-month-close";
import { evaluateDayBreaks } from "../contexts/time-tracking/day-break-rule";

vi.mock("../contexts/time-tracking/facade/time-entries", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../contexts/time-tracking/facade/time-entries")>();
  return { ...original, getWorkedEntriesInRange: vi.fn(original.getWorkedEntriesInRange) };
});

import { getWorkedEntriesInRange } from "../contexts/time-tracking/facade/time-entries";

const TZ = "Europe/Berlin";
const YEAR = 2026;
const MONTH = 3;
const VIOLATION_DAY = "2026-03-10"; // Tuesday
const PASSWORD = "test1234";

type T2Row = Awaited<ReturnType<typeof getWorkedEntriesInRange>>[number];

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** Mon-Fri days of March 2026. */
function marchWorkdays(): string[] {
  const out: string[] = [];
  const cur = new Date("2026-03-01T00:00:00Z");
  while (cur.getUTCMonth() === 2) {
    const dow = cur.getUTCDay();
    if (dow >= 1 && dow <= 5) out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

describe("Issue #80 — cross-salon § 4 violation in the month close", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let adminUserId: string;
  let salonA: string;
  let salonB: string;
  /** employeeId -> constructed T2 rows (replace the employee's real rows on those days). */
  const constructed = new Map<string, T2Row[]>();
  let seq = 0;

  function row(
    employeeId: string,
    day: string,
    salonId: string,
    start: string,
    end: string,
    opts: { isLocked?: boolean } = {},
  ): T2Row {
    return {
      id: randomUUID(),
      employeeId,
      date: dateOf(day),
      startTime: new Date(`${day}T${start}:00.000Z`),
      endTime: new Date(`${day}T${end}:00.000Z`),
      breakMinutes: 0,
      breakStatus: "CONFIRMED",
      isLocked: opts.isLocked ?? false,
      salonId,
    } as T2Row;
  }

  /** 8 h net across two salons with a 30 min travel gap 12:00-12:30: a § 4 shortfall. */
  function twoSalonDay(employeeId: string, day = VIOLATION_DAY): T2Row[] {
    const rows = [
      row(employeeId, day, salonA, "08:00", "12:00"),
      row(employeeId, day, salonB, "12:30", "16:30"),
    ];
    constructed.set(employeeId, [...(constructed.get(employeeId) ?? []), ...rows]);
    return rows;
  }

  /** Ack snapshot taken from the kernel, exactly as POST /day-breaks/acks stores it. */
  function currentSnapshot(rows: T2Row[]) {
    const { snapshot } = evaluateDayBreaks({
      rows: rows.map((r) => ({
        id: r.id,
        startTime: r.startTime,
        endTime: r.endTime!,
        breakMinutes: r.breakMinutes,
        breakStatus: r.breakStatus,
        salonId: r.salonId,
      })),
      dayBreaks: [],
      acks: [],
    });
    // Spread: a plain object literal type is assignable to Prisma's JSON input, the interface is not.
    return { ...snapshot };
  }

  async function createEmployee(
    label: string,
    scheduleType: "FIXED_SCHEDULE" | "MONTHLY_HOURS" = "FIXED_SCHEDULE",
    opts: { skipDay?: string } = {},
  ): Promise<string> {
    const prisma = app.prisma;
    const s = `${label}-${++seq}-${Date.now().toString(36)}`;
    const user = await prisma.user.create({
      data: {
        email: `csmc-${s}@test.de`,
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `CSMC-${s}`.slice(0, 30),
        firstName: "Salon",
        lastName: label,
        hireDate: new Date("2026-03-01T00:00:00Z"),
      },
    });
    await grantSystemRole(prisma, { tenantId, userId: user.id, role: "EMPLOYEE" });
    const fixed = scheduleType === "FIXED_SCHEDULE";
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        type: scheduleType,
        weeklyHours: fixed ? 40 : 0,
        mondayHours: fixed ? 8 : 0,
        tuesdayHours: fixed ? 8 : 0,
        wednesdayHours: fixed ? 8 : 0,
        thursdayHours: fixed ? 8 : 0,
        fridayHours: fixed ? 8 : 0,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: fixed ? [1, 2, 3, 4, 5] : [],
        monthlyHours: fixed ? null : 80,
        validFrom: new Date("2026-03-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    // A complete month of real, single-salon entries (no gap). The violation day is replaced in
    // the T2 read by the constructed two-salon rows.
    for (const d of marchWorkdays()) {
      if (d === opts.skipDay) continue;
      await prisma.timeEntry.create({
        data: {
          employeeId: emp.id,
          date: dateOf(d),
          startTime: new Date(`${d}T07:00:00Z`),
          endTime: new Date(`${d}T15:30:00Z`),
          breakMinutes: 30,
          breakStatus: "CONFIRMED",
          type: "WORK",
          salonId: salonA,
        },
      });
    }
    return emp.id;
  }

  function closeMonth(employeeId: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/overtime/close-month",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { employeeId, year: YEAR, month: MONTH },
    });
  }

  async function setFlags(flags: {
    blockMonthCloseOnUnconfirmedBreak?: boolean;
    enforceBreakConfirmation?: boolean;
  }) {
    await app.prisma.tenantConfig.update({ where: { tenantId }, data: flags });
  }

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const s = `csmc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const tenant = await prisma.tenant.create({
      data: { name: `CrossSalonClose ${s}`, slug: s, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    salonA = (await createTestSalon(prisma, tenantId, { name: "Salon A" })).id;
    salonB = (await createTestSalon(prisma, tenantId, { name: "Salon B" })).id;
    await prisma.tenantConfig.create({
      data: {
        tenantId,
        defaultVacationDays: 30,
        timezone: TZ,
        enforceBreakConfirmation: false,
        blockMonthCloseOnUnconfirmedBreak: true,
      },
    });

    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${s}@test.de`,
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        role: "ADMIN",
        isActive: true,
      },
    });
    adminUserId = adminUser.id;
    // Exempt from time tracking: never listed in the status and never auto-closed.
    await prisma.employee.create({
      data: {
        tenantId,
        userId: adminUser.id,
        employeeNumber: `ADM-${s}`.slice(0, 30),
        firstName: "Admin",
        lastName: "CrossSalon",
        hireDate: new Date("2024-01-01T00:00:00Z"),
        isTimeTrackingExempt: true,
      },
    });
    await grantSystemRole(prisma, { tenantId, userId: adminUser.id, role: "ADMIN" });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: adminUser.email, password: PASSWORD },
    });
    adminToken = (JSON.parse(login.body) as { accessToken: string }).accessToken;

    const actual = await vi.importActual<
      typeof import("../contexts/time-tracking/facade/time-entries")
    >("../contexts/time-tracking/facade/time-entries");
    vi.mocked(getWorkedEntriesInRange).mockImplementation(async (db, scope, from, to) => {
      const real = await actual.getWorkedEntriesInRange(db, scope, from, to);
      const inScope = (id: string) =>
        scope.kind === "employee"
          ? scope.employeeId === id
          : scope.kind === "employees"
            ? scope.employeeIds.includes(id)
            : true;
      const extra: T2Row[] = [];
      for (const [employeeId, rows] of constructed) {
        if (!inScope(employeeId)) continue;
        for (const r of rows) if (r.date >= from && r.date <= to) extra.push(r);
      }
      if (extra.length === 0) return real;
      const replaced = real.filter(
        (r) =>
          !extra.some(
            (c) => c.employeeId === r.employeeId && c.date.getTime() === r.date.getTime(),
          ),
      );
      return [...replaced, ...extra];
    });
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("cross-salon-month-close-80 cleanup:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    constructed.clear();
    await setFlags({ blockMonthCloseOnUnconfirmedBreak: true, enforceBreakConfirmation: false });
  });

  describe("POST /overtime/close-month (D-09b, D-15)", () => {
    it("answers 409 for an unacknowledged cross-salon § 4 day, independent of enforceBreakConfirmation", async () => {
      const empId = await createEmployee("block409");
      twoSalonDay(empId);

      const res = await closeMonth(empId);

      expect(res.statusCode, res.body).toBe(409);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(body.breakFindingCount).toBe(1);
      expect(body.breakFindingDays).toEqual([VIOLATION_DAY]);
      expect(body.requiresBreakFindingAck).toBe(true);
      expect(body.error).toContain("§ 4 ArbZG");
      expect(
        await app.prisma.saldoSnapshot.count({ where: { employeeId: empId } }),
        "no snapshot is written when the close is refused",
      ).toBe(0);
    });

    it("also blocks a MONTHLY_HOURS employee — the gate is not limited by schedule type (D-15)", async () => {
      const empId = await createEmployee("monthly409", "MONTHLY_HOURS");
      twoSalonDay(empId);

      const res = await closeMonth(empId);

      expect(res.statusCode, res.body).toBe(409);
      expect((JSON.parse(res.body) as { breakFindingDays: string[] }).breakFindingDays).toEqual([
        VIOLATION_DAY,
      ]);
    });

    it("does not answer this 409 when blockMonthCloseOnUnconfirmedBreak is false", async () => {
      await setFlags({ blockMonthCloseOnUnconfirmedBreak: false });
      const empId = await createEmployee("flagoff");
      twoSalonDay(empId);

      const res = await closeMonth(empId);

      expect(res.statusCode, res.body).toBe(201);
    });

    it("a current acknowledgement clears the block (D-17)", async () => {
      const empId = await createEmployee("acked");
      const rows = twoSalonDay(empId);
      await app.prisma.dayBreakAck.create({
        data: {
          employeeId: empId,
          date: dateOf(VIOLATION_DAY),
          reason: "Kundentermin ohne Unterbrechung",
          snapshot: currentSnapshot(rows),
          acknowledgedBy: adminUserId,
        },
      });

      const res = await closeMonth(empId);

      expect(res.statusCode, res.body).toBe(201);
    });

    it("a stale acknowledgement does not clear the block (D-17)", async () => {
      const empId = await createEmployee("stale");
      const rows = twoSalonDay(empId);
      const snapshot = currentSnapshot(rows);
      await app.prisma.dayBreakAck.create({
        data: {
          employeeId: empId,
          date: dateOf(VIOLATION_DAY),
          reason: "Kundentermin ohne Unterbrechung",
          // The day changed after the acknowledgement: 15 minutes more net working time.
          snapshot: { ...snapshot, netWorkedMin: snapshot.netWorkedMin - 15 },
          acknowledgedBy: adminUserId,
        },
      });

      const res = await closeMonth(empId);

      expect(res.statusCode, res.body).toBe(409);
      expect(
        (JSON.parse(res.body) as { requiresBreakFindingAck?: boolean }).requiresBreakFindingAck,
      ).toBe(true);
    });

    it("a recorded day break in the gap cures the violation", async () => {
      const empId = await createEmployee("cured");
      twoSalonDay(empId);
      await app.prisma.dayBreak.create({
        data: {
          employeeId: empId,
          date: dateOf(VIOLATION_DAY),
          startTime: new Date(`${VIOLATION_DAY}T12:00:00.000Z`),
          endTime: new Date(`${VIOLATION_DAY}T12:30:00.000Z`),
          createdBy: adminUserId,
        },
      });

      const res = await closeMonth(empId);

      expect(res.statusCode, res.body).toBe(201);
    });

    it("a soft-deleted acknowledgement does not clear the block", async () => {
      const empId = await createEmployee("revoked");
      const rows = twoSalonDay(empId);
      await app.prisma.dayBreakAck.create({
        data: {
          employeeId: empId,
          date: dateOf(VIOLATION_DAY),
          reason: "Kundentermin ohne Unterbrechung",
          snapshot: currentSnapshot(rows),
          acknowledgedBy: adminUserId,
          deletedAt: new Date(),
          deletedBy: adminUserId,
        },
      });

      const res = await closeMonth(empId);

      expect(res.statusCode, res.body).toBe(409);
    });
  });
  // ── Status listing (D-15, OQ-3) ─────────────────────────────────────────────────────────────
  describe("GET /overtime/close-month/status — breakFindingDays", () => {
    type StatusRow = { employeeId: string; status: string; breakFindingDays?: string[] };

    async function statusRows(): Promise<StatusRow[]> {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/overtime/close-month/status",
        headers: { authorization: `Bearer ${adminToken}` },
        query: { year: String(YEAR), month: String(MONTH) },
      });
      expect(res.statusCode, res.body).toBe(200);
      return (JSON.parse(res.body) as { employees: StatusRow[] }).employees;
    }

    async function statusRow(employeeId: string): Promise<StatusRow> {
      const row = (await statusRows()).find((e) => e.employeeId === employeeId);
      expect(row, "employee must appear in the status response").toBeDefined();
      return row!;
    }

    it("lists the violation day of a FIXED_SCHEDULE employee", async () => {
      const empId = await createEmployee("st-fixed");
      twoSalonDay(empId);
      expect((await statusRow(empId)).breakFindingDays).toEqual([VIOLATION_DAY]);
    });

    it("lists it for a MONTHLY_HOURS employee too (gap-free branch, D-15)", async () => {
      const empId = await createEmployee("st-monthly", "MONTHLY_HOURS");
      twoSalonDay(empId);
      expect((await statusRow(empId)).breakFindingDays).toEqual([VIOLATION_DAY]);
    });

    it("is [] for an employee without a cross-salon day", async () => {
      const empId = await createEmployee("st-clean");
      expect((await statusRow(empId)).breakFindingDays).toEqual([]);
    });

    it("is shown regardless of the block flag and of enforceBreakConfirmation (OQ-3)", async () => {
      await setFlags({ blockMonthCloseOnUnconfirmedBreak: false, enforceBreakConfirmation: false });
      const empId = await createEmployee("st-flagoff");
      twoSalonDay(empId);
      expect((await statusRow(empId)).breakFindingDays).toEqual([VIOLATION_DAY]);
    });

    it("is [] once a current acknowledgement exists and the day returns when it goes stale (D-17)", async () => {
      const empId = await createEmployee("st-ack");
      const rows = twoSalonDay(empId);
      const snapshot = currentSnapshot(rows);
      const ack = await app.prisma.dayBreakAck.create({
        data: {
          employeeId: empId,
          date: dateOf(VIOLATION_DAY),
          reason: "Kundentermin ohne Unterbrechung",
          snapshot,
          acknowledgedBy: adminUserId,
        },
      });
      expect((await statusRow(empId)).breakFindingDays).toEqual([]);

      await app.prisma.dayBreakAck.update({
        where: { id: ack.id },
        data: { snapshot: { ...snapshot, totalBreakMin: snapshot.totalBreakMin + 5 } },
      });
      expect((await statusRow(empId)).breakFindingDays).toEqual([VIOLATION_DAY]);
    });

    it("never lists a § 3-only day: enough break recorded, 11 h net across two salons (D-18)", async () => {
      const empId = await createEmployee("st-s3only");
      const rows = [
        { ...row(empId, VIOLATION_DAY, salonA, "06:00", "12:00"), breakMinutes: 45 },
        row(empId, VIOLATION_DAY, salonB, "12:30", "18:30"),
      ] as T2Row[];
      constructed.set(empId, rows);
      expect((await statusRow(empId)).breakFindingDays).toEqual([]);
      const res = await closeMonth(empId);
      expect(res.statusCode, res.body).toBe(201);
    });

    it("is [] for a closed month", async () => {
      const empId = await createEmployee("st-closed");
      expect((await closeMonth(empId)).statusCode).toBe(201);
      twoSalonDay(empId); // the day looks like a violation afterwards, but the month is closed
      const closed = await statusRow(empId);
      expect(closed.status).toBe("closed");
      expect(closed.breakFindingDays).toEqual([]);
    });

    it("issues no DayBreak / DayBreakAck query without a candidate day and exactly one per model with one", async () => {
      await createEmployee("st-perf-clean");
      const breakSpy = vi.spyOn(app.prisma.dayBreak, "findMany");
      const ackSpy = vi.spyOn(app.prisma.dayBreakAck, "findMany");
      try {
        await statusRows();
        expect(breakSpy).not.toHaveBeenCalled();
        expect(ackSpy).not.toHaveBeenCalled();

        twoSalonDay(await createEmployee("st-perf-a"));
        twoSalonDay(await createEmployee("st-perf-b"));
        await statusRows();
        expect(breakSpy).toHaveBeenCalledTimes(1);
        expect(ackSpy).toHaveBeenCalledTimes(1);
      } finally {
        breakSpy.mockRestore();
        ackSpy.mockRestore();
      }
    });
  });

  // ── Auto-close and deferred-close reporter (D-15) ────────────────────────────────────────────
  describe("auto-close defer and deferred-close reason", () => {
    const AFTER_WINDOW = new Date("2026-04-20T06:00:00.000Z");

    async function runAutoClose() {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(AFTER_WINDOW);
      try {
        await app.tryAutoCloseMonth();
      } finally {
        vi.useRealTimers();
      }
    }

    function snapshotCount(employeeId: string) {
      return app.prisma.saldoSnapshot.count({ where: { employeeId, periodType: "MONTHLY" } });
    }

    it("does not auto-close a month with an unacknowledged cross-salon § 4 day, but closes its clean sibling", async () => {
      const violating = await createEmployee("ac-violating");
      const clean = await createEmployee("ac-clean");
      twoSalonDay(violating);

      await runAutoClose();

      expect(await snapshotCount(violating), "deferred: no snapshot").toBe(0);
      expect(await snapshotCount(clean), "the clean employee still closes").toBe(1);
    });

    it("auto-closes once the day is acknowledged with a current snapshot", async () => {
      const empId = await createEmployee("ac-acked");
      const rows = twoSalonDay(empId);
      await app.prisma.dayBreakAck.create({
        data: {
          employeeId: empId,
          date: dateOf(VIOLATION_DAY),
          reason: "Kundentermin ohne Unterbrechung",
          snapshot: currentSnapshot(rows),
          acknowledgedBy: adminUserId,
        },
      });

      await runAutoClose();

      expect(await snapshotCount(empId)).toBe(1);
    });

    it("auto-closes over the day when the block flag is off", async () => {
      await setFlags({ blockMonthCloseOnUnconfirmedBreak: false });
      const empId = await createEmployee("ac-flagoff");
      twoSalonDay(empId);

      await runAutoClose();

      expect(await snapshotCount(empId)).toBe(1);
    });

    async function deferredEmployee(employeeId: string) {
      const state = await getDeferredMonthCloseState(app.prisma, tenantId, {
        now: AFTER_WINDOW,
        detailed: true,
        employeeIds: [employeeId],
      });
      return state.employees.find((e) => e.employeeId === employeeId);
    }

    it("the deferred-close reporter names CROSS_SALON_BREAKS with the violation days", async () => {
      const empId = await createEmployee("dc-cross");
      twoSalonDay(empId);

      const entry = await deferredEmployee(empId);

      expect(entry).toBeDefined();
      expect(entry!.reason).toBe("CROSS_SALON_BREAKS");
      expect(entry!.gapDates).toEqual([VIOLATION_DAY]);
      expect(entry!.gapCount).toBe(1);
    });

    it("keeps today's precedence: a gap day wins over the cross-salon reason", async () => {
      const empId = await createEmployee("dc-gap", "FIXED_SCHEDULE", { skipDay: "2026-03-12" });
      twoSalonDay(empId);

      const entry = await deferredEmployee(empId);

      expect(entry!.reason).toBe("GAPS");
      expect(entry!.gapDates).toEqual(["2026-03-12"]);
    });

    it("reports UNKNOWN when the block flag is off", async () => {
      await setFlags({ blockMonthCloseOnUnconfirmedBreak: false });
      const empId = await createEmployee("dc-flagoff");
      twoSalonDay(empId);

      expect((await deferredEmployee(empId))!.reason).toBe("UNKNOWN");
    });
  });
  // ── Issue #511 (D-12) — the generalised detector: a single-salon, single-entry Satz-3 day ─────
  describe("Issue #511 (D-12) — single-salon break findings", () => {
    // The harness entry of a day runs 07:00Z-15:30Z (08:00-16:30 Berlin) with breakMinutes 30. A
    // break at 13:30Z-14:00Z leaves a 390 min block before it: Satz 1 is met, Satz 3 is violated.
    const LATE_BREAK = ["13:30", "14:00"] as const;
    const MOVED_BREAK = ["13:20", "13:50"] as const; // same minutes, other placement

    const utc = (hhmm: string) => new Date(`${VIOLATION_DAY}T${hhmm}:00.000Z`);

    function entryOf(employeeId: string) {
      return app.prisma.timeEntry.findFirstOrThrow({
        where: { employeeId, date: dateOf(VIOLATION_DAY), deletedAt: null },
      });
    }

    async function addBreak(employeeId: string, [start, end]: readonly [string, string]) {
      const entry = await entryOf(employeeId);
      return app.prisma.break.create({
        data: { timeEntryId: entry.id, startTime: utc(start), endTime: utc(end) },
      });
    }

    /** The snapshot POST /day-breaks/acks would store for the employee's real day right now. */
    async function realDaySnapshot(employeeId: string) {
      const entry = await entryOf(employeeId);
      const breaks = await app.prisma.break.findMany({ where: { timeEntryId: entry.id } });
      const { snapshot } = evaluateDayBreaks({
        rows: [
          {
            id: entry.id,
            startTime: entry.startTime,
            endTime: entry.endTime!,
            breakMinutes: entry.breakMinutes,
            breakStatus: entry.breakStatus,
            salonId: entry.salonId,
            breaks,
          },
        ],
        dayBreaks: [],
        acks: [],
      });
      return { ...snapshot };
    }

    async function ackRealDay(employeeId: string) {
      await app.prisma.dayBreakAck.create({
        data: {
          employeeId,
          date: dateOf(VIOLATION_DAY),
          reason: "Kundentermin ohne Unterbrechung",
          snapshot: await realDaySnapshot(employeeId),
          acknowledgedBy: adminUserId,
        },
      });
    }

    async function findingDaysOf(employeeId: string): Promise<string[] | undefined> {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/overtime/close-month/status",
        headers: { authorization: `Bearer ${adminToken}` },
        query: { year: String(YEAR), month: String(MONTH) },
      });
      expect(res.statusCode, res.body).toBe(200);
      const rows = (
        JSON.parse(res.body) as { employees: { employeeId: string; breakFindingDays?: string[] }[] }
      ).employees;
      const found = rows.find((e) => e.employeeId === employeeId);
      expect(found, "employee must appear in the status response").toBeDefined();
      return found!.breakFindingDays;
    }

    it("answers 409 for a Satz-3 day of a single entry, independent of enforceBreakConfirmation", async () => {
      const empId = await createEmployee("p-block");
      await addBreak(empId, LATE_BREAK);

      const res = await closeMonth(empId);

      expect(res.statusCode, res.body).toBe(409);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(body.breakFindingCount).toBe(1);
      expect(body.breakFindingDays).toEqual([VIOLATION_DAY]);
      expect(body.requiresBreakFindingAck).toBe(true);
      expect(body.error).toContain("§ 11 JArbSchG");
      expect(await app.prisma.saldoSnapshot.count({ where: { employeeId: empId } })).toBe(0);
    });

    it("a hint-only day (stored break sum, no Break rows) never blocks and is never listed (A5)", async () => {
      const empId = await createEmployee("p-hint");

      expect(await findingDaysOf(empId)).toEqual([]);
      const res = await closeMonth(empId);

      expect(res.statusCode, res.body).toBe(201);
    });

    it("a current acknowledgement clears the block; a moved break makes it stale again", async () => {
      const acked = await createEmployee("p-acked");
      await addBreak(acked, LATE_BREAK);
      await ackRealDay(acked);
      expect(await findingDaysOf(acked), "anti-vacuity: the ack is what clears it").toEqual([]);
      expect((await closeMonth(acked)).statusCode).toBe(201);

      const stale = await createEmployee("p-stale");
      const moved = await addBreak(stale, LATE_BREAK);
      await ackRealDay(stale);
      await app.prisma.break.update({
        where: { id: moved.id },
        data: { startTime: utc(MOVED_BREAK[0]), endTime: utc(MOVED_BREAK[1]) },
      });

      const res = await closeMonth(stale);

      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({
        breakFindingDays: [VIOLATION_DAY],
        requiresBreakFindingAck: true,
      });
    });

    it("an entry-level WAIVED (durchgearbeitet) resolves a single-salon day", async () => {
      const empId = await createEmployee("p-waived");
      await addBreak(empId, LATE_BREAK);
      expect(await findingDaysOf(empId), "control: listed before the waiver").toEqual([
        VIOLATION_DAY,
      ]);
      await app.prisma.timeEntry.updateMany({
        where: { employeeId: empId, date: dateOf(VIOLATION_DAY) },
        data: { breakStatus: "WAIVED" },
      });

      expect(await findingDaysOf(empId)).toEqual([]);
      expect((await closeMonth(empId)).statusCode).toBe(201);
    });

    it("also blocks a MONTHLY_HOURS employee — statutory, every schedule type", async () => {
      const empId = await createEmployee("p-monthly", "MONTHLY_HOURS");
      await addBreak(empId, LATE_BREAK);

      const res = await closeMonth(empId);

      expect(res.statusCode, res.body).toBe(409);
      expect((JSON.parse(res.body) as { breakFindingDays: string[] }).breakFindingDays).toEqual([
        VIOLATION_DAY,
      ]);
    });

    it("does not block when blockMonthCloseOnUnconfirmedBreak is false", async () => {
      await setFlags({ blockMonthCloseOnUnconfirmedBreak: false });
      const empId = await createEmployee("p-flagoff");
      await addBreak(empId, LATE_BREAK);

      expect((await closeMonth(empId)).statusCode).toBe(201);
    });

    it("the status lists the day regardless of the flag, [] for others and for a closed month", async () => {
      await setFlags({ blockMonthCloseOnUnconfirmedBreak: false, enforceBreakConfirmation: false });
      const finding = await createEmployee("p-st-finding");
      const clean = await createEmployee("p-st-clean");
      const monthly = await createEmployee("p-st-monthly", "MONTHLY_HOURS");
      await addBreak(finding, LATE_BREAK);
      await addBreak(monthly, LATE_BREAK);

      expect(await findingDaysOf(finding)).toEqual([VIOLATION_DAY]);
      expect(await findingDaysOf(monthly)).toEqual([VIOLATION_DAY]);
      expect(await findingDaysOf(clean)).toEqual([]);

      // A closed month is never re-evaluated (D-14): close the clean employee, then give the
      // locked day a finding — the status still answers [].
      expect((await closeMonth(clean)).statusCode).toBe(201);
      await addBreak(clean, LATE_BREAK);
      expect(await findingDaysOf(clean)).toEqual([]);
    });

    // ── Auto-close defer and the deferred-close reason (D-12) ──────────────────────────────────
    describe("auto-close defer and deferred-close reason BREAK_PLACEMENT", () => {
      const AFTER_WINDOW_511 = new Date("2026-04-20T06:00:00.000Z");

      async function runAutoClose511() {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(AFTER_WINDOW_511);
        try {
          await app.tryAutoCloseMonth();
        } finally {
          vi.useRealTimers();
        }
      }

      const snapshots = (employeeId: string) =>
        app.prisma.saldoSnapshot.count({ where: { employeeId, periodType: "MONTHLY" } });

      async function reasonOf(employeeId: string) {
        const state = await getDeferredMonthCloseState(app.prisma, tenantId, {
          now: AFTER_WINDOW_511,
          detailed: true,
          employeeIds: [employeeId],
        });
        return state.employees.find((e) => e.employeeId === employeeId);
      }

      it("defers a month with a Satz-3 day, closes its clean sibling, and closes once acknowledged", async () => {
        const finding = await createEmployee("p-ac-finding");
        const clean = await createEmployee("p-ac-clean");
        const acked = await createEmployee("p-ac-acked");
        await addBreak(finding, LATE_BREAK);
        await addBreak(acked, LATE_BREAK);
        await ackRealDay(acked);

        await runAutoClose511();

        expect(await snapshots(finding), "deferred: no snapshot").toBe(0);
        expect(await snapshots(clean), "the clean employee still closes").toBe(1);
        expect(await snapshots(acked), "a current acknowledgement lets it close").toBe(1);
      });

      it("auto-closes over the day when the block flag is off", async () => {
        await setFlags({ blockMonthCloseOnUnconfirmedBreak: false });
        const empId = await createEmployee("p-ac-flagoff");
        await addBreak(empId, LATE_BREAK);

        await runAutoClose511();

        expect(await snapshots(empId)).toBe(1);
      });

      it("the reporter names BREAK_PLACEMENT with the finding day", async () => {
        const empId = await createEmployee("p-dc-placement");
        await addBreak(empId, LATE_BREAK);

        const entry = await reasonOf(empId);

        expect(entry).toBeDefined();
        expect(entry!.reason).toBe("BREAK_PLACEMENT");
        expect(entry!.gapDates).toEqual([VIOLATION_DAY]);
        expect(entry!.gapCount).toBe(1);
      });

      it("a cross-salon Satz-1 day keeps CROSS_SALON_BREAKS, also when a placement day exists", async () => {
        const crossOnly = await createEmployee("p-dc-cross");
        twoSalonDay(crossOnly);
        expect((await reasonOf(crossOnly))!.reason).toBe("CROSS_SALON_BREAKS");

        const both = await createEmployee("p-dc-both");
        // 2026-03-10: cross-salon Satz-1 shortfall; 2026-03-11: single-salon Satz-3 day.
        twoSalonDay(both);
        const wednesday = await app.prisma.timeEntry.findFirstOrThrow({
          where: { employeeId: both, date: dateOf("2026-03-11") },
        });
        await app.prisma.break.create({
          data: {
            timeEntryId: wednesday.id,
            startTime: new Date("2026-03-11T13:30:00.000Z"),
            endTime: new Date("2026-03-11T14:00:00.000Z"),
          },
        });
        const entry = (await reasonOf(both))!;
        expect(entry.reason).toBe("CROSS_SALON_BREAKS");
        expect(entry.gapDates).toEqual([VIOLATION_DAY, "2026-03-11"]);
      });

      it("keeps the GAPS precedence over BREAK_PLACEMENT", async () => {
        const empId = await createEmployee("p-dc-gap", "FIXED_SCHEDULE", { skipDay: "2026-03-12" });
        await addBreak(empId, LATE_BREAK);

        const entry = (await reasonOf(empId))!;

        expect(entry.reason).toBe("GAPS");
        expect(entry.gapDates).toEqual(["2026-03-12"]);
      });
    });
  });
});
