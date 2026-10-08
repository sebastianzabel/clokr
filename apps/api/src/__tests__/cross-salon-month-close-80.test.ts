/**
 * Issue #80 (D-09b, D-15, D-17, D-18) — the Monatsabschluss refuses to lock a month that still
 * contains an unacknowledged cross-salon § 4 ArbZG violation.
 *
 * A multi-entry day cannot exist in the database while the partial unique index
 * `TimeEntry_employeeId_date_unique_not_deleted` holds, so the closed-WORK-entry read of the
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
import { getTestApp, closeTestApp, cleanupTestData, createTestSalon } from "./setup";
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
      expect(body.crossSalonBreakCount).toBe(1);
      expect(body.crossSalonBreakDays).toEqual([VIOLATION_DAY]);
      expect(body.requiresCrossSalonAck).toBe(true);
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
      expect(
        (JSON.parse(res.body) as { crossSalonBreakDays: string[] }).crossSalonBreakDays,
      ).toEqual([VIOLATION_DAY]);
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
        (JSON.parse(res.body) as { requiresCrossSalonAck?: boolean }).requiresCrossSalonAck,
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
});
