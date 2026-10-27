/**
 * Issue #696 - the bulk carry-in is the single carry-in.
 *
 * `openMonthCarryInMinutesForMany` and `computeMonthReportFiguresForMany` read their inputs once
 * for all persons; the arithmetic is the one `computeAccountChain` / `computeMonthSaldo` already
 * run. This file pins that every (person, month) answer of the bulk functions equals the per-person
 * function's answer, over FIXED, MONTHLY_HOURS (labelled and track-only), SHIFT_BASED and a
 * mid-chain hire, with and without a closed month, with an OpeningBalance (#682), an exit date,
 * approved leave and a closed month stored in the legacy convention. Closed months are only read.
 *
 * Faked clock 2026-07-15, July is the running month. No PII - synthetic names only.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, grantSystemRole } from "./setup";
import { salonIdForEmployee } from "./setup";
import { legacySaldoSnapshotPeriodBounds, saldoSnapshotPeriodBounds } from "./test-dates";
import {
  computeMonthReportFigures,
  computeMonthReportFiguresForMany,
  monthReportFiguresKey,
} from "../contexts/working-time-account/month-saldo";
import {
  openMonthCarryInKey,
  openMonthCarryInMinutes,
  openMonthCarryInMinutesForMany,
} from "../contexts/working-time-account/overtime-balance";

const FAKE_NOW = new Date("2026-07-15T10:00:00.000Z");
const MONTHS: Array<[number, number]> = [
  [2025, 10],
  [2025, 12],
  [2026, 2],
  [2026, 4],
  [2026, 5],
  [2026, 6],
  [2026, 7],
];

type Kind = "FIXED" | "MONTHLY" | "MONTHLY_TRACK_ONLY" | "SHIFT_BASED";

describe("Issue #696 - bulk carry-in and bulk month figures equal the per-person functions", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let salonId: string;
  const people: Record<string, string> = {};

  async function person(
    key: string,
    hireDate: string,
    contracts: Array<{ kind: Kind; validFrom: string }>,
  ): Promise<string> {
    const passwordHash = await bcrypt.hash("test1234", 4);
    const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `c696-${key}-${unique}@example.invalid`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `C696-${key}-${unique}`,
        firstName: `Vorname${key}`,
        lastName: `C696${key}`,
        hireDate: new Date(`${hireDate}T00:00:00Z`),
        breakOver6hOverride: 0,
        breakOver9hOverride: 0,
      },
    });
    await grantSystemRole(app.prisma, { tenantId, userId: user.id, role: "EMPLOYEE" });
    for (const c of contracts) {
      const validFrom = new Date(`${c.validFrom}T00:00:00Z`);
      const base = { employeeId: employee.id, validFrom };
      if (c.kind === "FIXED") {
        await app.prisma.workSchedule.create({
          data: {
            ...base,
            type: "FIXED_SCHEDULE",
            weeklyHours: 40,
            mondayHours: 8,
            tuesdayHours: 8,
            wednesdayHours: 8,
            thursdayHours: 8,
            fridayHours: 8,
            saturdayHours: 0,
            sundayHours: 0,
            workDays: [1, 2, 3, 4, 5],
          },
        });
      } else if (c.kind === "MONTHLY" || c.kind === "MONTHLY_TRACK_ONLY") {
        await app.prisma.workSchedule.create({
          data: {
            ...base,
            type: "MONTHLY_HOURS",
            weeklyHours: 0,
            monthlyHours: 160,
            workDays: [1, 2, 3, 4, 5],
            overtimeMode: c.kind === "MONTHLY_TRACK_ONLY" ? "TRACK_ONLY" : "CARRY_FORWARD",
          },
        });
      } else {
        await app.prisma.workSchedule.create({
          data: {
            ...base,
            type: "SHIFT_BASED",
            weeklyHours: 40,
            mondayHours: 8,
            tuesdayHours: 8,
            wednesdayHours: 8,
            thursdayHours: 8,
            fridayHours: 8,
            saturdayHours: 0,
            sundayHours: 0,
            contractWorkDaysPerWeek: 5,
            usualWorkDays: [1, 2, 3, 4, 5],
          },
        });
      }
    }
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId: employee.id,
        salonId,
        kind: "HOME",
        validFrom: new Date(`${hireDate}T00:00:00Z`),
        validUntil: null,
        weekdays: [],
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    return employee.id;
  }

  /** Weekdays from..to (inclusive), YYYY-MM-DD. */
  function weekdays(from: string, to: string): string[] {
    const out: string[] = [];
    const cur = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    while (cur <= end) {
      const dow = cur.getUTCDay();
      if (dow !== 0 && dow !== 6) out.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
  }

  /** Entries with a net minute pattern that differs per day so every month has its own balance. */
  async function entries(employeeId: string, from: string, to: string, skipEvery = 0) {
    const sid = await salonIdForEmployee(app.prisma, employeeId);
    const days = weekdays(from, to);
    for (let i = 0; i < days.length; i++) {
      if (skipEvery > 0 && i % skipEvery === 0) continue;
      const net = 420 + ((i * 37) % 120); // 7:00 .. 8:59 net
      const start = new Date(`${days[i]}T06:00:00Z`);
      await app.prisma.timeEntry.create({
        data: {
          employeeId,
          date: new Date(`${days[i]}T00:00:00Z`),
          startTime: start,
          endTime: new Date(start.getTime() + (net + 30) * 60_000),
          breakMinutes: 30,
          type: "WORK",
          salonId: sid,
        },
      });
    }
  }

  async function closedMonth(
    employeeId: string,
    year: number,
    month: number,
    carryOver: number,
    legacy = false,
  ) {
    const b = legacy
      ? legacySaldoSnapshotPeriodBounds(year, month)
      : saldoSnapshotPeriodBounds(new Date(Date.UTC(year, month - 1, 1)));
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: b.start,
        periodEnd: b.end,
        workedMinutes: 9000,
        expectedMinutes: 9000,
        balanceMinutes: 0,
        carryOver,
        closedAt: new Date(Date.UTC(year, month, 1, 6)),
        superseded: false,
      },
    });
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FAKE_NOW);
    app = await getTestApp();
    const seed = await seedTestData(app, "c696");
    tenantId = seed.tenant.id;
    salonId = seed.salonId;

    // FIXED, closed 2026-02 only, everything after open (the long chain case).
    people.pA = await person("A", "2025-01-01", [{ kind: "FIXED", validFrom: "2025-01-01" }]);
    await closedMonth(people.pA, 2026, 2, 300);
    await entries(people.pA, "2025-01-06", "2026-07-14", 4);

    // FIXED, never closed, long history.
    people.pB = await person("B", "2025-01-01", [{ kind: "FIXED", validFrom: "2025-01-01" }]);
    await entries(people.pB, "2025-01-06", "2026-07-14", 3);

    // MONTHLY_HOURS labelled, closed April.
    people.pC = await person("C", "2025-01-01", [{ kind: "MONTHLY", validFrom: "2025-01-01" }]);
    await closedMonth(people.pC, 2026, 4, 60);
    await entries(people.pC, "2025-01-06", "2026-07-14", 5);

    // SHIFT_BASED with a roster, never closed.
    people.pD = await person("D", "2025-01-01", [{ kind: "SHIFT_BASED", validFrom: "2025-01-01" }]);
    for (const day of weekdays("2025-01-06", "2026-07-31")) {
      await app.prisma.shift.create({
        data: {
          employeeId: people.pD,
          salonId,
          date: new Date(`${day}T00:00:00Z`),
          startTime: "08:00",
          endTime: "16:00",
        },
      });
    }
    await entries(people.pD, "2025-01-06", "2026-07-14", 6);

    // MONTHLY_HOURS: track-only until 2026-06 (resets the chain), labelled afterwards.
    people.pE = await person("E", "2025-01-01", [
      { kind: "MONTHLY_TRACK_ONLY", validFrom: "2025-01-01" },
      { kind: "MONTHLY", validFrom: "2026-06-01" },
    ]);
    await entries(people.pE, "2025-01-06", "2026-07-14", 4);

    // Hired mid-chain, FIXED, never closed.
    people.pF = await person("F", "2026-05-18", [{ kind: "FIXED", validFrom: "2026-05-18" }]);
    await entries(people.pF, "2026-05-18", "2026-07-14", 5);

    // OpeningBalance (#682), never closed.
    people.pG = await person("G", "2026-01-01", [{ kind: "FIXED", validFrom: "2026-01-01" }]);
    await app.prisma.openingBalance.create({
      data: {
        employeeId: people.pG,
        minutes: 600,
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        reason: "Fixture 696",
        source: "ADMIN_ENTRY",
        createdBy: seed.adminUser.id,
      },
    });
    await entries(people.pG, "2026-01-05", "2026-07-14", 4);

    // A contract change mid-chain plus a closed month in the LEGACY convention.
    people.pH = await person("H", "2025-01-01", [
      { kind: "FIXED", validFrom: "2025-01-01" },
      { kind: "MONTHLY", validFrom: "2026-03-01" },
    ]);
    await closedMonth(people.pH, 2025, 12, -90, true);
    await entries(people.pH, "2025-01-06", "2026-07-14", 5);

    // Exited mid-chain: the window ends at the exit day.
    people.pI = await person("I", "2025-01-01", [{ kind: "FIXED", validFrom: "2025-01-01" }]);
    await app.prisma.employee.update({
      where: { id: people.pI },
      data: { exitDate: new Date("2026-03-20T00:00:00Z") },
    });
    await entries(people.pI, "2025-01-06", "2026-03-20", 4);

    // Approved vacation inside the chain reduces Soll.
    people.pJ = await person("J", "2025-01-01", [{ kind: "FIXED", validFrom: "2025-01-01" }]);
    await entries(people.pJ, "2025-01-06", "2026-07-14", 5);
    const vacation = await app.prisma.leaveType.findFirst({
      where: { tenantId, code: "VACATION" },
    });
    expect(vacation).toBeTruthy();
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: people.pJ,
        leaveTypeId: vacation!.id,
        startDate: new Date("2026-02-09T00:00:00Z"),
        endDate: new Date("2026-02-13T00:00:00Z"),
        days: 5,
        status: "APPROVED",
      },
    });

    // Leave on the edges of a month: the month bound is an INSTANT (local midnight), the leave
    // columns are dates, so the previous local day is taken in (Issue #493) - the bulk filter must
    // keep exactly what the query keeps.
    people.pK = await person("K", "2025-01-01", [{ kind: "FIXED", validFrom: "2025-01-01" }]);
    await entries(people.pK, "2025-01-06", "2026-07-14", 5);
    for (const [from, to] of [
      ["2026-04-27", "2026-04-30"],
      ["2026-06-01", "2026-06-02"],
      ["2026-06-29", "2026-06-30"],
    ] as const) {
      await app.prisma.leaveRequest.create({
        data: {
          employeeId: people.pK,
          leaveTypeId: vacation!.id,
          startDate: new Date(`${from}T00:00:00Z`),
          endDate: new Date(`${to}T00:00:00Z`),
          days: 2,
          status: "APPROVED",
        },
      });
    }
  }, 120_000);

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await app.prisma.openingBalance.deleteMany({ where: { employee: { tenantId } } });
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  const requests = () =>
    Object.values(people).flatMap((employeeId) =>
      MONTHS.map(([year, month]) => ({ employeeId, year, month })),
    );

  it("openMonthCarryInMinutesForMany equals openMonthCarryInMinutes for every person and month", async () => {
    const snapshotsBefore = await app.prisma.saldoSnapshot.findMany({
      where: { employee: { tenantId } },
      orderBy: { id: "asc" },
    });
    const bulk = await openMonthCarryInMinutesForMany(app, tenantId, requests());
    let nonZero = 0;
    const distinct = new Set<number>();
    for (const r of requests()) {
      const single = await openMonthCarryInMinutes(app, r.employeeId, r.year, r.month);
      const key = openMonthCarryInKey(r.employeeId, r.year, r.month);
      expect(bulk.get(key), key).toBe(single);
      if (single !== 0) nonZero += 1;
      distinct.add(single);
    }
    // Not vacuous: the chains carry values, and they differ between persons and months.
    expect(nonZero).toBeGreaterThan(30);
    expect(distinct.size).toBeGreaterThan(20);
    // Closed months are only read.
    expect(
      await app.prisma.saldoSnapshot.findMany({
        where: { employee: { tenantId } },
        orderBy: { id: "asc" },
      }),
    ).toEqual(snapshotsBefore);
  });

  it("computeMonthReportFiguresForMany equals computeMonthReportFigures for every person and month", async () => {
    const bulk = await computeMonthReportFiguresForMany(app, tenantId, requests());
    let open = 0;
    for (const r of requests()) {
      const single = await computeMonthReportFigures(app, r.employeeId, r.year, r.month);
      const key = monthReportFiguresKey(r.employeeId, r.year, r.month);
      expect(bulk.get(key), key).toEqual(single);
      if (!single.confirmed && single.labelled) open += 1;
    }
    expect(open).toBeGreaterThan(40);
  });

  it("a tenant-less or unknown person is answered like the single call", async () => {
    const ghost = "00000000-0000-4000-8000-000000000000";
    const bulk = await openMonthCarryInMinutesForMany(app, tenantId, [
      { employeeId: ghost, year: 2026, month: 5 },
    ]);
    expect(bulk.get(openMonthCarryInKey(ghost, 2026, 5))).toBe(
      await openMonthCarryInMinutes(app, ghost, 2026, 5),
    );
  });
});
