/**
 * Issue #681 — the Gesamtsaldo at the end of an OPEN month includes every unclosed month since the
 * last close and equals the live saldo at the same Stichtag.
 *
 * Stichtag: the live saldo never counts today (#438), so the Gesamtsaldo of the running month is
 * compared with the live saldo at the real (faked) today, and the Gesamtsaldo of a PAST open month
 * with the live saldo faked to the first day of the month after it (its window then ends on the
 * month's last day).
 *
 * Fixture (faked clock 2026-07-15, i.e. in the past of every real run; July is the running month):
 *   pA FIXED          closed April (converted convention), May + June + July open  -> three open months
 *   pB FIXED          closed May (LEGACY UTC-naive convention, #595), June + July   -> two open months
 *   pC MONTHLY_HOURS  closed April, May + June + July open
 *   pD SHIFT_BASED    closed April, May + June + July open, roster beyond today
 *   pE MONTHLY_HOURS  closed April, May TRACK_ONLY (#494: resets the chain), June + July accumulate
 *   pF FIXED          hired 2026-05-18 (mid-chain), never closed
 *   pG FIXED          hired 2026-05-01, never closed, OpeningBalance +600 (chain head, Phase 99;
 *                     the live saldo ignores it without a closed month - Issue #682, measured only)
 *
 * No PII - synthetic names only.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, grantSystemRole } from "./setup";
import { salonIdForEmployee } from "./setup";
import { legacySaldoSnapshotPeriodBounds, saldoSnapshotPeriodBounds } from "./test-dates";
import {
  computeMonthSaldo,
  computeMonthReportFigures,
} from "../contexts/working-time-account/month-saldo";
import {
  computeOvertimeBalanceBreakdown,
  openMonthCarryInMinutes,
} from "../contexts/working-time-account/overtime-balance";

const FAKE_NOW = new Date("2026-07-15T10:00:00.000Z");
/** Live saldo faked to the first day of the month after M: its window ends on M's last day. */
const STICHTAG_NOW: Record<number, Date> = {
  5: new Date("2026-06-01T10:00:00.000Z"),
  6: new Date("2026-07-01T10:00:00.000Z"),
  7: FAKE_NOW,
};

type Kind = "FIXED" | "MONTHLY" | "MONTHLY_TRACK_ONLY" | "SHIFT_BASED";

describe("Issue #681 — open-month chain: Gesamtsaldo == live saldo at the same Stichtag", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let salonId: string;
  let adminToken: string;
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
        email: `c681-${key}-${unique}@example.invalid`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `C681-${key}-${unique}`,
        firstName: `Vorname${key}`,
        lastName: `C681${key}`,
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

  async function live(employeeId: string, now: Date): Promise<number> {
    vi.setSystemTime(now);
    try {
      const b = await computeOvertimeBalanceBreakdown(app, employeeId);
      return Math.round((b?.totalHours ?? 0) * 60);
    } finally {
      vi.setSystemTime(FAKE_NOW);
    }
  }

  async function closing(employeeId: string, month: number): Promise<number | null> {
    return (await computeMonthReportFigures(app, employeeId, 2026, month)).closingBalanceMinutes;
  }

  let snapshotsBefore: unknown[];
  const snapshotRows = () =>
    app.prisma.saldoSnapshot.findMany({
      where: { employee: { tenantId } },
      orderBy: { id: "asc" },
    });

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FAKE_NOW);
    app = await getTestApp();
    const seed = await seedTestData(app, "c681");
    tenantId = seed.tenant.id;
    salonId = seed.salonId;
    adminToken = seed.adminToken;

    people.pA = await person("A", "2025-01-01", [{ kind: "FIXED", validFrom: "2025-01-01" }]);
    await closedMonth(people.pA, 2026, 4, 300);
    await entries(people.pA, "2026-05-01", "2026-07-14", 4);

    people.pB = await person("B", "2025-01-01", [{ kind: "FIXED", validFrom: "2025-01-01" }]);
    await closedMonth(people.pB, 2026, 4, 50);
    await closedMonth(people.pB, 2026, 5, -120, true);
    await entries(people.pB, "2026-06-01", "2026-07-14", 3);

    people.pC = await person("C", "2025-01-01", [{ kind: "MONTHLY", validFrom: "2025-01-01" }]);
    await closedMonth(people.pC, 2026, 4, 60);
    await entries(people.pC, "2026-05-01", "2026-07-14", 5);

    people.pD = await person("D", "2025-01-01", [{ kind: "SHIFT_BASED", validFrom: "2025-01-01" }]);
    await closedMonth(people.pD, 2026, 4, 0);
    // Roster on every weekday May..July (beyond today), 8 h net; entries through yesterday.
    for (const day of weekdays("2026-05-01", "2026-07-31")) {
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
    await entries(people.pD, "2026-05-01", "2026-07-14", 6);

    people.pE = await person("E", "2025-01-01", [
      { kind: "MONTHLY_TRACK_ONLY", validFrom: "2025-01-01" },
      { kind: "MONTHLY", validFrom: "2026-06-01" },
    ]);
    await closedMonth(people.pE, 2026, 4, 500);
    await entries(people.pE, "2026-05-01", "2026-07-14", 4);

    people.pF = await person("F", "2026-05-18", [{ kind: "FIXED", validFrom: "2026-05-18" }]);
    await entries(people.pF, "2026-05-18", "2026-07-14", 5);

    people.pG = await person("G", "2026-05-01", [{ kind: "FIXED", validFrom: "2026-05-01" }]);
    await app.prisma.openingBalance.create({
      data: {
        employeeId: people.pG,
        minutes: 600,
        effectiveFrom: new Date("2026-05-01T00:00:00Z"),
        reason: "Fixture 681",
        source: "ADMIN_ENTRY",
        createdBy: seed.adminUser.id,
      },
    });
    await entries(people.pG, "2026-05-01", "2026-07-14", 4);

    snapshotsBefore = await snapshotRows();
  });

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

  const openMonths: Record<string, number[]> = {
    pA: [5, 6, 7],
    pB: [6, 7],
    pC: [5, 6, 7],
    pD: [5, 6, 7],
    pE: [5, 6, 7],
    pF: [5, 6, 7],
  };

  for (const [key, months] of Object.entries(openMonths)) {
    for (const month of months) {
      it(`${key}: Gesamtsaldo end of 2026-${month} == live saldo at that Stichtag`, async () => {
        const fig = await computeMonthReportFigures(app, people[key]!, 2026, month);
        expect(fig.confirmed).toBe(false);
        expect(fig.labelled).toBe(true);
        expect(fig.closingBalanceMinutes).not.toBeNull();
        expect(fig.closingBalanceMinutes).toBe(await live(people[key]!, STICHTAG_NOW[month]!));
      });
    }
  }

  it("the chain is not vacuous: every earlier open month carries a non-zero balance", async () => {
    for (const [key, months] of Object.entries(openMonths)) {
      for (const month of months.slice(0, -1)) {
        const ms = await computeMonthSaldo(app, people[key]!, 2026, month);
        if (key === "pE" && month === 5) continue; // track-only month: contributes 0 by design
        expect(ms.balanceMinutes, `${key} ${month}`).not.toBe(0);
      }
    }
  });

  it("three open months (pA): July carries April's close plus May and June", async () => {
    const may = await computeMonthSaldo(app, people.pA!, 2026, 5);
    const june = await computeMonthSaldo(app, people.pA!, 2026, 6);
    const july = await computeMonthSaldo(app, people.pA!, 2026, 7);
    expect(await openMonthCarryInMinutes(app, people.pA!, 2026, 5)).toBe(300);
    expect(await openMonthCarryInMinutes(app, people.pA!, 2026, 6)).toBe(300 + may.balanceMinutes);
    expect(await openMonthCarryInMinutes(app, people.pA!, 2026, 7)).toBe(
      300 + may.balanceMinutes + june.balanceMinutes,
    );
    expect(july.days.at(-1)!.cumulativeSaldoMinutes).toBe(
      300 + may.balanceMinutes + june.balanceMinutes + july.balanceMinutes,
    );
    // The pre-681 value (last close + July only) is what the bug printed - it is not the answer.
    expect(july.days.at(-1)!.cumulativeSaldoMinutes).not.toBe(300 + july.balanceMinutes);
  });

  it("two open months with a LEGACY closed May (pB, #595 window): June starts at the stored carry", async () => {
    const june = await computeMonthSaldo(app, people.pB!, 2026, 6);
    expect(await openMonthCarryInMinutes(app, people.pB!, 2026, 6)).toBe(-120);
    expect(await openMonthCarryInMinutes(app, people.pB!, 2026, 7)).toBe(
      -120 + june.balanceMinutes,
    );
    // The closed May itself is read verbatim (confirmed, stored carry).
    const may = await computeMonthReportFigures(app, people.pB!, 2026, 5);
    expect(may.confirmed).toBe(true);
    expect(may.closingBalanceMinutes).toBe(-120);
  });

  it("track-only month in the chain (pE, #494): May contributes 0 and resets the chain", async () => {
    const may = await computeMonthSaldo(app, people.pE!, 2026, 5);
    expect(may.days.length).toBeGreaterThan(0);
    expect(may.days.every((d) => d.cumulativeSaldoMinutes === 0)).toBe(true);
    expect(await openMonthCarryInMinutes(app, people.pE!, 2026, 6)).toBe(0);
    const june = await computeMonthSaldo(app, people.pE!, 2026, 6);
    expect(june.days.at(-1)!.cumulativeSaldoMinutes).toBe(june.balanceMinutes);
  });

  it("hire mid-chain (pF): the chain starts on the hire day, never before", async () => {
    expect(await openMonthCarryInMinutes(app, people.pF!, 2026, 5)).toBe(0);
    const may = await computeMonthSaldo(app, people.pF!, 2026, 5);
    expect(may.days[0]!.date).toBe("2026-05-18");
    expect(await openMonthCarryInMinutes(app, people.pF!, 2026, 6)).toBe(may.balanceMinutes);
  });

  it("OpeningBalance at the chain head (pG): carried into every open month; live omits it (Issue #682, measured)", async () => {
    const may = await computeMonthSaldo(app, people.pG!, 2026, 5);
    const june = await computeMonthSaldo(app, people.pG!, 2026, 6);
    expect(await openMonthCarryInMinutes(app, people.pG!, 2026, 5)).toBe(600);
    expect(await openMonthCarryInMinutes(app, people.pG!, 2026, 7)).toBe(
      600 + may.balanceMinutes + june.balanceMinutes,
    );
    // Without any closed month the live saldo starts at 0 and does not read the OpeningBalance -
    // the difference is exactly its minutes. Not changed by #681; tracked as Issue #682 - when #682
    // lands, this measurement becomes an equality.
    expect((await closing(people.pG!, 7))! - (await live(people.pG!, FAKE_NOW))).toBe(600);
  });

  it("GET /overtime/month-saldo serves the same chain as the Monatsexport figure", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/month-saldo/${people.pA}?year=2026&month=7`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const days = (JSON.parse(res.body) as { days: Array<{ cumulativeSaldoMinutes: number }> }).days;
    expect(days.length).toBeGreaterThan(0);
    expect(days.at(-1)!.cumulativeSaldoMinutes).toBe(await closing(people.pA!, 7));
  });

  it("collections are fetched once per chain, not once per open month (3 vs 2 open months)", async () => {
    const spies = {
      timeEntry: vi.spyOn(app.prisma.timeEntry, "findMany"),
      shift: vi.spyOn(app.prisma.shift, "findMany"),
      leave: vi.spyOn(app.prisma.leaveRequest, "findMany"),
      absence: vi.spyOn(app.prisma.absence, "findMany"),
    };
    const counts = async (employeeId: string) => {
      for (const s of Object.values(spies)) s.mockClear();
      const t0 = performance.now();
      await openMonthCarryInMinutes(app, employeeId, 2026, 7);
      const ms = performance.now() - t0;
      return {
        calls: Object.fromEntries(
          Object.entries(spies).map(([k, s]) => [k, s.mock.calls.length]),
        ) as Record<keyof typeof spies, number>,
        ms,
      };
    };
    const threeOpen = await counts(people.pA!); // May + June before July
    const oneOpen = await counts(people.pB!); // June before July
    for (const s of Object.values(spies)) s.mockRestore();
    console.warn(
      `[681 perf] carry-in July: pA (2 unclosed months before) ${threeOpen.ms.toFixed(1)} ms ${JSON.stringify(threeOpen.calls)}; pB (1) ${oneOpen.ms.toFixed(1)} ms ${JSON.stringify(oneOpen.calls)}`,
    );
    expect(threeOpen.calls).toEqual(oneOpen.calls);
  });

  it("closed months are never recalculated: every SaldoSnapshot row is byte-identical afterwards", async () => {
    for (const key of Object.keys(people)) {
      for (const month of [4, 5, 6, 7]) {
        await computeMonthReportFigures(app, people[key]!, 2026, month);
        await openMonthCarryInMinutes(app, people[key]!, 2026, month);
      }
      await computeOvertimeBalanceBreakdown(app, people[key]!);
    }
    expect(await snapshotRows()).toEqual(snapshotsBefore);
    expect(snapshotsBefore.length).toBe(6);
  });
});
