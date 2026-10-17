/**
 * Issue #682 — without a closed month the live saldo starts with the OpeningBalance, exactly like
 * every close path and the month series (one seed: `getCarryOverBase`, Phase 99 OB-02). With a
 * closed month nothing changes: the first close already put the OpeningBalance into its stored
 * carryOver, and the live saldo reads that carry, never the OpeningBalance a second time.
 *
 * Fixture (faked clock 2026-07-15, in the past of every real run; July is the running month):
 *   nF  FIXED          hired 2026-05-01, never closed, OpeningBalance +600
 *   nM  MONTHLY_HOURS  hired 2026-05-01, never closed, OpeningBalance -300 (negative)
 *   nS  SHIFT_BASED    hired 2026-05-01, never closed, OpeningBalance +450, roster beyond today
 *   nT  MONTHLY_HOURS  hired 2026-05-01, May TRACK_ONLY (#494 resets the chain), OpeningBalance +600
 *   nX  FIXED          hired 2026-05-01, never closed, only a SUPERSEDED OpeningBalance (+900)
 *   nE  FIXED          hired 2026-05-01, § 18 exempt, OpeningBalance +600
 *   nO  MONTHLY_HOURS  TRACK_ONLY today, never closed, OpeningBalance +600
 *   cF  FIXED          hired 2026-04-01, OpeningBalance +600, April closed through the REAL close path
 *   eF  FIXED          hired 2026-05-01, OpeningBalance set through POST /overtime/opening-balance
 *
 * No PII - synthetic names only.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  grantSystemRole,
  salonIdForEmployee,
} from "./setup";
import {
  computeMonthSaldo,
  computeMonthReportFigures,
} from "../contexts/working-time-account/month-saldo";
import {
  computeOvertimeBalanceBreakdown,
  openMonthCarryInMinutes,
  updateOvertimeAccount,
} from "../contexts/working-time-account/overtime-balance";

const FAKE_NOW = new Date("2026-07-15T10:00:00.000Z");
/** Live saldo faked to the first day of the month after M: its window ends on M's last day. */
const STICHTAG_NOW: Record<number, Date> = {
  5: new Date("2026-06-01T10:00:00.000Z"),
  6: new Date("2026-07-01T10:00:00.000Z"),
  7: FAKE_NOW,
};

type Kind = "FIXED" | "MONTHLY" | "MONTHLY_TRACK_ONLY" | "SHIFT_BASED";

describe("Issue #682 — live saldo starts with the OpeningBalance when no month is closed", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let salonId: string;
  let adminToken: string;
  let adminUserId: string;
  const people: Record<string, string> = {};

  async function person(
    key: string,
    hireDate: string,
    contracts: Array<{ kind: Kind; validFrom: string }>,
    exempt = false,
  ): Promise<string> {
    const passwordHash = await bcrypt.hash("test1234", 4);
    const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `c682-${key}-${unique}@example.invalid`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `C682-${key}-${unique}`,
        firstName: `Vorname${key}`,
        lastName: `C682${key}`,
        hireDate: new Date(`${hireDate}T00:00:00Z`),
        breakOver6hOverride: 0,
        breakOver9hOverride: 0,
        isTimeTrackingExempt: exempt,
      },
    });
    await grantSystemRole(app.prisma, { tenantId, userId: user.id, role: "EMPLOYEE" });
    for (const c of contracts) {
      const base = { employeeId: employee.id, validFrom: new Date(`${c.validFrom}T00:00:00Z`) };
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
      const net = 420 + ((i * 37) % 120);
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

  async function openingBalance(employeeId: string, minutes: number, superseded = false) {
    await app.prisma.openingBalance.create({
      data: {
        employeeId,
        minutes,
        effectiveFrom: new Date("2026-04-01T00:00:00Z"),
        reason: "Fixture 682",
        source: "ADMIN_ENTRY",
        createdBy: adminUserId,
        superseded,
        supersededReason: superseded ? "Fixture 682 superseded" : null,
      },
    });
  }

  async function live(employeeId: string, now: Date = FAKE_NOW): Promise<number> {
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

  async function balances(employeeId: string, months: number[]): Promise<number> {
    let sum = 0;
    for (const m of months)
      sum += (await computeMonthSaldo(app, employeeId, 2026, m)).balanceMinutes;
    return sum;
  }

  const snapshotRows = () =>
    app.prisma.saldoSnapshot.findMany({
      where: { employee: { tenantId } },
      orderBy: { id: "asc" },
    });
  let snapshotsBefore: unknown[];

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FAKE_NOW);
    app = await getTestApp();
    const seed = await seedTestData(app, "c682");
    tenantId = seed.tenant.id;
    salonId = seed.salonId;
    adminToken = seed.adminToken;
    adminUserId = seed.adminUser.id;

    people.nF = await person("F", "2026-05-01", [{ kind: "FIXED", validFrom: "2026-05-01" }]);
    await openingBalance(people.nF, 600);
    await entries(people.nF, "2026-05-01", "2026-07-14", 4);

    people.nM = await person("M", "2026-05-01", [{ kind: "MONTHLY", validFrom: "2026-05-01" }]);
    await openingBalance(people.nM, -300);
    await entries(people.nM, "2026-05-01", "2026-07-14", 5);

    people.nS = await person("S", "2026-05-01", [{ kind: "SHIFT_BASED", validFrom: "2026-05-01" }]);
    await openingBalance(people.nS, 450);
    for (const day of weekdays("2026-05-01", "2026-07-31")) {
      await app.prisma.shift.create({
        data: {
          employeeId: people.nS,
          salonId,
          date: new Date(`${day}T00:00:00Z`),
          startTime: "08:00",
          endTime: "16:00",
        },
      });
    }
    await entries(people.nS, "2026-05-01", "2026-07-14", 6);

    people.nT = await person("T", "2026-05-01", [
      { kind: "MONTHLY_TRACK_ONLY", validFrom: "2026-05-01" },
      { kind: "MONTHLY", validFrom: "2026-06-01" },
    ]);
    await openingBalance(people.nT, 600);
    await entries(people.nT, "2026-05-01", "2026-07-14", 4);

    people.nX = await person("X", "2026-05-01", [{ kind: "FIXED", validFrom: "2026-05-01" }]);
    await openingBalance(people.nX, 900, true);
    await entries(people.nX, "2026-05-01", "2026-07-14", 4);

    people.nE = await person("E", "2026-05-01", [{ kind: "FIXED", validFrom: "2026-05-01" }], true);
    await openingBalance(people.nE, 600);
    await entries(people.nE, "2026-05-01", "2026-07-14", 4);

    people.nO = await person("O", "2026-05-01", [
      { kind: "MONTHLY_TRACK_ONLY", validFrom: "2026-05-01" },
    ]);
    await openingBalance(people.nO, 600);
    await entries(people.nO, "2026-05-01", "2026-07-14", 4);

    people.cF = await person("C", "2026-04-01", [{ kind: "FIXED", validFrom: "2026-04-01" }]);
    await openingBalance(people.cF, 600);
    await entries(people.cF, "2026-04-01", "2026-07-14", 4);

    people.eF = await person("P", "2026-05-01", [{ kind: "FIXED", validFrom: "2026-05-01" }]);
    await entries(people.eF, "2026-05-01", "2026-07-14", 4);
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

  const noClose: Record<string, { ob: number; months: number[] }> = {
    nF: { ob: 600, months: [5, 6, 7] },
    nM: { ob: -300, months: [5, 6, 7] },
    nS: { ob: 450, months: [5, 6, 7] },
  };

  for (const [key, { ob, months }] of Object.entries(noClose)) {
    for (const month of months) {
      it(`${key}: live saldo at the end of 2026-${month} == Gesamtsaldo of the month series`, async () => {
        const fig = await computeMonthReportFigures(app, people[key]!, 2026, month);
        expect(fig.confirmed).toBe(false);
        expect(fig.closingBalanceMinutes).not.toBeNull();
        expect(await live(people[key]!, STICHTAG_NOW[month]!)).toBe(fig.closingBalanceMinutes);
      });
    }

    it(`${key}: the live saldo is the OpeningBalance (${ob}) plus every open month`, async () => {
      const total = await live(people[key]!);
      const sum = await balances(people[key]!, months);
      expect(total).toBe(ob + sum);
      // Not vacuous: the months carry a balance of their own, and the pre-682 value (sum only) is gone.
      expect(sum).not.toBe(0);
      expect(total).not.toBe(sum);
    });

    it(`${key}: the OpeningBalance is part of the forecast, never of "Bestätigt" (no month closed)`, async () => {
      const b = await computeOvertimeBalanceBreakdown(app, people[key]!);
      expect(b).not.toBeNull();
      expect(b!.hasClosedMonth).toBe(false);
      expect(b!.confirmedMinutes).toBe(0);
      expect(b!.openMonthMinutes).toBe(Math.round(b!.totalHours * 60));
    });
  }

  it("carry-in of every open month equals the live saldo at that Stichtag (no double OpeningBalance)", async () => {
    for (const key of Object.keys(noClose)) {
      expect(await openMonthCarryInMinutes(app, people[key]!, 2026, 5)).toBe(noClose[key]!.ob);
      expect(await openMonthCarryInMinutes(app, people[key]!, 2026, 6)).toBe(
        await live(people[key]!, STICHTAG_NOW[5]!),
      );
      expect(await openMonthCarryInMinutes(app, people[key]!, 2026, 7)).toBe(
        await live(people[key]!, STICHTAG_NOW[6]!),
      );
    }
  });

  it("track-only month in the chain (nT, #494): May resets the chain, the OpeningBalance is dropped like its close drops it", async () => {
    const june = await computeMonthSaldo(app, people.nT!, 2026, 6);
    const july = await computeMonthSaldo(app, people.nT!, 2026, 7);
    expect(await live(people.nT!)).toBe(june.balanceMinutes + july.balanceMinutes);
    expect(await live(people.nT!)).toBe(await closing(people.nT!, 7));
    // The carry into June is 0 (May's close would store carry 0) — before #682 the chain path
    // re-added the OpeningBalance after the reset and returned 600 here.
    expect(await openMonthCarryInMinutes(app, people.nT!, 2026, 6)).toBe(0);
  });

  it("a superseded OpeningBalance is ignored (nX)", async () => {
    expect(await live(people.nX!)).toBe(await balances(people.nX!, [5, 6, 7]));
    expect(await live(people.nX!)).toBe(await closing(people.nX!, 7));
  });

  it("§ 18 exempt (nE): no live saldo at all, the OpeningBalance changes nothing", async () => {
    expect(await computeOvertimeBalanceBreakdown(app, people.nE!)).toBeNull();
  });

  it("track-only today (nO): the live saldo stays 0 with an OpeningBalance", async () => {
    const b = await computeOvertimeBalanceBreakdown(app, people.nO!);
    expect(b!.totalHours).toBe(0);
    expect(b!.confirmedMinutes).toBe(0);
    expect(b!.openMonthMinutes).toBe(0);
  });

  it("the stored balance follows the live value on the next write (updateOvertimeAccount)", async () => {
    await updateOvertimeAccount(app, people.nF!);
    const acc = await app.prisma.overtimeAccount.findUniqueOrThrow({
      where: { employeeId: people.nF! },
    });
    expect(Math.round(Number(acc.balanceHours) * 60)).toBe(await live(people.nF!));
  });

  it("POST /overtime/opening-balance stores the OpeningBalance-inclusive live value at once (eF)", async () => {
    const before = await live(people.eF!);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/opening-balance",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        employeeId: people.eF,
        minutes: 720,
        effectiveFrom: "2026-05-01",
        reason: "Übernommenes Guthaben (Test 682)",
      },
    });
    expect(res.statusCode).toBe(201);
    const after = await live(people.eF!);
    expect(after).toBe(before + 720);
    const acc = await app.prisma.overtimeAccount.findUniqueOrThrow({
      where: { employeeId: people.eF! },
    });
    expect(Math.round(Number(acc.balanceHours) * 60)).toBe(after);
  });

  describe("with a closed month (cF, real close path): nothing changes, no double count", () => {
    let aprilCarry: number;
    let aprilBalance: number;

    beforeAll(async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/overtime/close-month",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { employeeId: people.cF, year: 2026, month: 4, confirmGaps: true },
      });
      expect(res.statusCode).toBe(201);
      const snap = await app.prisma.saldoSnapshot.findFirstOrThrow({
        where: { employeeId: people.cF!, periodType: "MONTHLY", superseded: false },
      });
      aprilCarry = snap.carryOver;
      aprilBalance = snap.balanceMinutes;
      snapshotsBefore = await snapshotRows();
    });

    it("the close put the OpeningBalance into the stored carry exactly once", () => {
      expect(aprilBalance).not.toBe(0);
      expect(aprilCarry).toBe(600 + aprilBalance);
    });

    it("live == stored April carry + May..July, == Gesamtsaldo; the OpeningBalance is not added again", async () => {
      const open = await balances(people.cF!, [5, 6, 7]);
      expect(await live(people.cF!)).toBe(aprilCarry + open);
      expect(await live(people.cF!)).not.toBe(aprilCarry + open + 600);
      expect(await live(people.cF!)).toBe(await closing(people.cF!, 7));
      const b = await computeOvertimeBalanceBreakdown(app, people.cF!);
      expect(b!.hasClosedMonth).toBe(true);
      expect(b!.confirmedMinutes).toBe(aprilCarry);
      expect(await openMonthCarryInMinutes(app, people.cF!, 2026, 5)).toBe(aprilCarry);
    });

    it("closed months are never recalculated: every SaldoSnapshot row is byte-identical afterwards", async () => {
      for (const key of Object.keys(people)) {
        for (const month of [4, 5, 6, 7]) {
          await computeMonthReportFigures(app, people[key]!, 2026, month);
          await openMonthCarryInMinutes(app, people[key]!, 2026, month);
        }
        await computeOvertimeBalanceBreakdown(app, people[key]!);
        await updateOvertimeAccount(app, people[key]!);
      }
      expect(await snapshotRows()).toEqual(snapshotsBefore);
      expect(snapshotsBefore.length).toBe(1);
    });
  });
});
