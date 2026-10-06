/**
 * Phase 494 (Issue #494) R2/R3 neutrality pins.
 *
 * Written and GREEN on the unfixed tree at branch base `7c6018e9`, BEFORE the track-only predicate is
 * widened to "MONTHLY_HOURS without monthly hours". Every literal below is "captured": it was read from
 * that unfixed tree (run once with a capture log, copied, the log removed). This file is the integration
 * half of the proof that #494 changes ONLY the intended population.
 *
 * THIS FILE MUST NEVER BE EDITED TO MAKE A TEST PASS. A red cell after a later 494 plan is a regression
 * of a contract #494 must not touch, not a stale value. There is deliberately no snapshot mechanism —
 * every pinned value is an explicit literal.
 *
 * It deliberately contains NO contract with `monthlyHours` null/0 and `overtimeMode` CARRY_FORWARD on a
 * MONTHLY_HOURS row — that population is the intended flip and lives in the sibling file
 * `monthly-hours-no-target-track-only-494.test.ts`.
 *
 * Fixture — six employees, hire 2026-01-01, each working days 15-19 of every month Jan-Jun 2026
 * (08:00-13:00Z, break 0, 300 min per day, 1500 min per month):
 *   A MONTHLY_HOURS 15 h, CARRY_FORWARD
 *   B MONTHLY_HOURS 15 h, TRACK_ONLY
 *   C MONTHLY_HOURS monthlyHours null, TRACK_ONLY (explicit, already track-only before #494)
 *   D FIXED_SCHEDULE 40 h, Mo-Fr 8 h
 *   E FLEXTIME 20 h, Mo-Fr 4 h
 *   F MONTHLY_HOURS 15 h CARRY_FORWARD, contract change to 20 h from 2026-04-01 (R2)
 * Frozen clock for every live read and every close: 2026-07-23T10:00:00Z (Berlin 12:00).
 *
 * Per employee three cells, in file order (state is shared):
 *   1. live balance before any close
 *   2. Monatsabschluss Jan-Jun (manual close, confirmGaps) -> six stored snapshots
 *   3. live balance after closing, which must equal cell 1 (live == closed)
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData, reissueTokenNow } from "./setup";

const FROZEN_NOW = new Date("2026-07-23T10:00:00.000Z");
const HIRE = new Date("2026-01-01T00:00:00Z");

type EmpKey = "A" | "B" | "C" | "D" | "E" | "F";
const EMP_KEYS: EmpKey[] = ["A", "B", "C", "D", "E", "F"];

interface Live {
  balanceHours: number;
  confirmedMinutes: number;
  openMonthMinutes: number;
  hasClosedMonth: boolean;
}

interface SnapshotRow {
  workedMinutes: number;
  expectedMinutes: number;
  balanceMinutes: number;
  carryOver: number;
}

const MH_BASE = {
  type: "MONTHLY_HOURS",
  weeklyHours: null,
  mondayHours: 0,
  tuesdayHours: 0,
  wednesdayHours: 0,
  thursdayHours: 0,
  fridayHours: 0,
  saturdayHours: 0,
  sundayHours: 0,
  workDays: [1, 2, 3, 4, 5],
};

// Captured on the unfixed tree at 7c6018e9 (see header). Live values are minutes-derived hours.
const LIVE_BEFORE: Record<EmpKey, Live> = {
  A: { balanceHours: 53.77, confirmedMinutes: 0, openMonthMinutes: 3226, hasClosedMonth: false },
  B: { balanceHours: 0, confirmedMinutes: 0, openMonthMinutes: 0, hasClosedMonth: false },
  C: { balanceHours: 0, confirmedMinutes: 0, openMonthMinutes: 0, hasClosedMonth: false },
  D: { balanceHours: -962, confirmedMinutes: 0, openMonthMinutes: -57720, hasClosedMonth: false },
  E: { balanceHours: -406, confirmedMinutes: 0, openMonthMinutes: -24360, hasClosedMonth: false },
  F: { balanceHours: 36.43, confirmedMinutes: 0, openMonthMinutes: 2186, hasClosedMonth: false },
};

const SNAPSHOTS: Record<EmpKey, SnapshotRow[]> = {
  A: [
    { workedMinutes: 1500, expectedMinutes: 859, balanceMinutes: 641, carryOver: 641 },
    { workedMinutes: 1500, expectedMinutes: 900, balanceMinutes: 600, carryOver: 1241 },
    { workedMinutes: 1500, expectedMinutes: 900, balanceMinutes: 600, carryOver: 1841 },
    { workedMinutes: 1500, expectedMinutes: 818, balanceMinutes: 682, carryOver: 2523 },
    { workedMinutes: 1500, expectedMinutes: 771, balanceMinutes: 729, carryOver: 3252 },
    { workedMinutes: 1500, expectedMinutes: 900, balanceMinutes: 600, carryOver: 3852 },
  ],
  B: [
    { workedMinutes: 1500, expectedMinutes: 859, balanceMinutes: 641, carryOver: 0 },
    { workedMinutes: 1500, expectedMinutes: 900, balanceMinutes: 600, carryOver: 0 },
    { workedMinutes: 1500, expectedMinutes: 900, balanceMinutes: 600, carryOver: 0 },
    { workedMinutes: 1500, expectedMinutes: 818, balanceMinutes: 682, carryOver: 0 },
    { workedMinutes: 1500, expectedMinutes: 771, balanceMinutes: 729, carryOver: 0 },
    { workedMinutes: 1500, expectedMinutes: 900, balanceMinutes: 600, carryOver: 0 },
  ],
  C: [
    { workedMinutes: 1500, expectedMinutes: 0, balanceMinutes: 1500, carryOver: 0 },
    { workedMinutes: 1500, expectedMinutes: 0, balanceMinutes: 1500, carryOver: 0 },
    { workedMinutes: 1500, expectedMinutes: 0, balanceMinutes: 1500, carryOver: 0 },
    { workedMinutes: 1500, expectedMinutes: 0, balanceMinutes: 1500, carryOver: 0 },
    { workedMinutes: 1500, expectedMinutes: 0, balanceMinutes: 1500, carryOver: 0 },
    { workedMinutes: 1500, expectedMinutes: 0, balanceMinutes: 1500, carryOver: 0 },
  ],
  D: [
    { workedMinutes: 1500, expectedMinutes: 10080, balanceMinutes: -8580, carryOver: -8580 },
    { workedMinutes: 1500, expectedMinutes: 9600, balanceMinutes: -8100, carryOver: -16680 },
    { workedMinutes: 1500, expectedMinutes: 10560, balanceMinutes: -9060, carryOver: -25740 },
    { workedMinutes: 1500, expectedMinutes: 9600, balanceMinutes: -8100, carryOver: -33840 },
    { workedMinutes: 1500, expectedMinutes: 8640, balanceMinutes: -7140, carryOver: -40980 },
    { workedMinutes: 1500, expectedMinutes: 10560, balanceMinutes: -9060, carryOver: -50040 },
  ],
  E: [
    { workedMinutes: 1500, expectedMinutes: 5040, balanceMinutes: -3540, carryOver: -3540 },
    { workedMinutes: 1500, expectedMinutes: 4800, balanceMinutes: -3300, carryOver: -6840 },
    { workedMinutes: 1500, expectedMinutes: 5280, balanceMinutes: -3780, carryOver: -10620 },
    { workedMinutes: 1500, expectedMinutes: 4800, balanceMinutes: -3300, carryOver: -13920 },
    { workedMinutes: 1500, expectedMinutes: 4320, balanceMinutes: -2820, carryOver: -16740 },
    { workedMinutes: 1500, expectedMinutes: 5280, balanceMinutes: -3780, carryOver: -20520 },
  ],
  F: [
    { workedMinutes: 1500, expectedMinutes: 859, balanceMinutes: 641, carryOver: 641 },
    { workedMinutes: 1500, expectedMinutes: 900, balanceMinutes: 600, carryOver: 1241 },
    { workedMinutes: 1500, expectedMinutes: 900, balanceMinutes: 600, carryOver: 1841 },
    { workedMinutes: 1500, expectedMinutes: 1091, balanceMinutes: 409, carryOver: 2250 },
    { workedMinutes: 1500, expectedMinutes: 1029, balanceMinutes: 471, carryOver: 2721 },
    { workedMinutes: 1500, expectedMinutes: 1200, balanceMinutes: 300, carryOver: 3021 },
  ],
};

const LIVE_AFTER: Record<EmpKey, Live> = {
  A: { balanceHours: 53.77, confirmedMinutes: 3852, openMonthMinutes: -626, hasClosedMonth: true },
  B: { balanceHours: 0, confirmedMinutes: 0, openMonthMinutes: 0, hasClosedMonth: true },
  C: { balanceHours: 0, confirmedMinutes: 0, openMonthMinutes: 0, hasClosedMonth: true },
  D: {
    balanceHours: -962,
    confirmedMinutes: -50040,
    openMonthMinutes: -7680,
    hasClosedMonth: true,
  },
  E: {
    balanceHours: -406,
    confirmedMinutes: -20520,
    openMonthMinutes: -3840,
    hasClosedMonth: true,
  },
  F: { balanceHours: 36.43, confirmedMinutes: 3021, openMonthMinutes: -835, hasClosedMonth: true },
};

describe("Issue #494 R2/R3 — non-affected contracts are frozen (captured on 7c6018e9)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const empIds = {} as Record<EmpKey, string>;
  const liveBeforeActual = {} as Record<EmpKey, number>;

  async function createEmp(
    key: EmpKey,
    schedules: Array<{ validFrom: string; data: Record<string, unknown> }>,
  ): Promise<void> {
    const s = `${key}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const user = await app.prisma.user.create({
      data: { email: `${s}@tonp494.test`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
    });
    const emp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `TONP-${s}`,
        firstName: "Neutral",
        lastName: key,
        hireDate: HIRE,
        isTimeTrackingExempt: false,
      },
    });
    for (const sch of schedules) {
      await app.prisma.workSchedule.create({
        data: {
          employeeId: emp.id,
          validFrom: new Date(`${sch.validFrom}T00:00:00Z`),
          ...sch.data,
        } as never,
      });
    }
    await app.prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    for (let month = 1; month <= 6; month++) {
      for (let day = 15; day <= 19; day++) {
        const ds = `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        await app.prisma.timeEntry.create({
          data: {
            employeeId: emp.id,
            date: new Date(`${ds}T00:00:00Z`),
            startTime: new Date(`${ds}T08:00:00Z`),
            endTime: new Date(`${ds}T13:00:00Z`),
            breakMinutes: 0,
            type: "WORK",
            source: "MANUAL",
            salonId: data.salonId,
          },
        });
      }
    }
    empIds[key] = emp.id;
  }

  async function atFrozenNow<T>(fn: (token: string) => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
    try {
      return await fn(reissueTokenNow(app, data.adminToken));
    } finally {
      vi.useRealTimers();
    }
  }

  async function liveGet(key: EmpKey): Promise<Live> {
    return atFrozenNow(async (token) => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${empIds[key]}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const b = JSON.parse(res.body) as Live;
      return {
        balanceHours: Number(b.balanceHours),
        confirmedMinutes: b.confirmedMinutes,
        openMonthMinutes: b.openMonthMinutes,
        hasClosedMonth: b.hasClosedMonth,
      };
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "tonp494");

    await createEmp("A", [
      {
        validFrom: "2026-01-01",
        data: { ...MH_BASE, monthlyHours: 15, overtimeMode: "CARRY_FORWARD" },
      },
    ]);
    await createEmp("B", [
      {
        validFrom: "2026-01-01",
        data: { ...MH_BASE, monthlyHours: 15, overtimeMode: "TRACK_ONLY" },
      },
    ]);
    await createEmp("C", [
      {
        validFrom: "2026-01-01",
        data: { ...MH_BASE, monthlyHours: null, overtimeMode: "TRACK_ONLY" },
      },
    ]);
    await createEmp("D", [
      {
        validFrom: "2026-01-01",
        data: {
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
          overtimeMode: "CARRY_FORWARD",
        },
      },
    ]);
    await createEmp("E", [
      {
        validFrom: "2026-01-01",
        data: {
          type: "FLEXTIME",
          weeklyHours: 20,
          mondayHours: 4,
          tuesdayHours: 4,
          wednesdayHours: 4,
          thursdayHours: 4,
          fridayHours: 4,
          saturdayHours: 0,
          sundayHours: 0,
          workDays: [1, 2, 3, 4, 5],
          overtimeMode: "CARRY_FORWARD",
        },
      },
    ]);
    await createEmp("F", [
      {
        validFrom: "2026-01-01",
        data: { ...MH_BASE, monthlyHours: 15, overtimeMode: "CARRY_FORWARD" },
      },
      {
        validFrom: "2026-04-01",
        data: { ...MH_BASE, monthlyHours: 20, overtimeMode: "CARRY_FORWARD" },
      },
    ]);
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("tonp494 cleanup failed:", err);
    }
  });

  for (const key of EMP_KEYS) {
    describe(`employee ${key}`, () => {
      it("live balance before any close", async () => {
        const live = await liveGet(key);
        liveBeforeActual[key] = live.balanceHours;
        expect(live).toEqual(LIVE_BEFORE[key]);
      });

      it("Monatsabschluss Jan-Jun stores six snapshots", async () => {
        await atFrozenNow(async (token) => {
          for (let month = 1; month <= 6; month++) {
            const res = await app.inject({
              method: "POST",
              url: "/api/v1/overtime/close-month",
              headers: { authorization: `Bearer ${token}` },
              payload: { employeeId: empIds[key], year: 2026, month, confirmGaps: true },
            });
            expect(res.statusCode, `close month ${month}: ${res.body}`).toBe(201);
          }
        });
        const rows = await app.prisma.saldoSnapshot.findMany({
          where: { employeeId: empIds[key], periodType: "MONTHLY", superseded: false },
          orderBy: { periodStart: "asc" },
          select: {
            workedMinutes: true,
            expectedMinutes: true,
            balanceMinutes: true,
            carryOver: true,
          },
        });
        expect(rows).toEqual(SNAPSHOTS[key]);
      });

      it("live balance after closing equals the live balance before (live == closed)", async () => {
        const live = await liveGet(key);
        expect(live).toEqual(LIVE_AFTER[key]);
        expect(live.balanceHours).toBe(liveBeforeActual[key]);
      });
    });
  }
});
