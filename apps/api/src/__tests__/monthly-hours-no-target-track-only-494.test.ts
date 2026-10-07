/**
 * Phase 494 (Issue #494) target tests — a MONTHLY_HOURS contract without monthly hours (null or 0)
 * behaves like TRACK_ONLY regardless of the stored `overtimeMode`: live saldo 0, Monatsabschluss
 * writes no carry-over.
 *
 * Written RED on branch base `7c6018e9`, before any production line changes. Every `it` title starts
 * with exactly one tag:
 *   - `FLIP R1 · `   red before the predicate edit of plan 494-02, green after it
 *   - `FLIP D-10 · ` red before AND right after the predicate edit, green after the live-loop reset
 *                    of plan 494-02 (D-10: unclosed complete months of a track-only contract
 *                    contribute 0 to the live total, exactly as a close would zero them)
 *   - `KEEP · `      green on every tree
 * The received red values are the recorded "before" characterisation of #494.
 *
 * Expected values are HAND values derived in a comment per cell — never copied from an
 * implementation. THIS FILE MUST NEVER BE EDITED TO MAKE A TEST PASS: a red cell after plan 494-02
 * is a finding, not a stale value.
 *
 * Calendar facts used by the hand values (Europe/Berlin, NIEDERSACHSEN): 2026-07-01 is a Wednesday;
 * 01.-22.07.2026 has 16 weekdays and no public holiday (16 x 480 = 7680 min Soll for FIXED 40 h
 * Mo-Fr 8 h); June 2026 starts on a Monday, has 22 weekdays and no holiday (10560 min); Ascension
 * (14.05.) is a NI holiday, so every fixture works on days 15-19 of a month only. A fixture "day"
 * is 08:00-13:00Z, break 0 = 300 net minutes (below the § 4 threshold, no break gate can block a
 * close), so days 15-19 are 1500 min per month.
 *
 * Frozen clock `2026-07-23T10:00:00.000Z` unless a cell names another. Only `Date` is faked
 * (faking timers breaks the pg pool). The cron describe is LAST on purpose: the cron walks every
 * tenant of the worker database and would close months of the describes above.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData, reissueTokenNow } from "./setup";
import { monthRangeUtc } from "../contexts/working-time-account/timezone";
import { updateOvertimeAccount } from "../contexts/time-tracking/api/time-entries";
import { recalculateSnapshots } from "../contexts/working-time-account/recalculate-snapshots";

const TZ = "Europe/Berlin";
const NOW = "2026-07-23T10:00:00.000Z";

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

const FIXED_40 = {
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
};

const two = (n: number) => String(n).padStart(2, "0");
const ymd = (month: number, day: number) => `2026-${two(month)}-${two(day)}`;
/** Days 15-19 of the given months (the fixture "work block"). */
const block = (...months: number[]) =>
  months.flatMap((m) => [15, 16, 17, 18, 19].map((d) => ymd(m, d)));

describe("Issue #494 — MONTHLY_HOURS without monthly hours behaves like TRACK_ONLY", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  interface EmpSpec {
    key: string;
    hire: string;
    schedules: Array<{ validFrom: string; data: Record<string, unknown> }>;
    entries: string[];
    lockedEntries?: string[];
    legacySnapshots?: Array<{ month: number } & SnapshotRow>;
  }

  async function createEmp(spec: EmpSpec): Promise<string> {
    const s = `${spec.key}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const user = await app.prisma.user.create({
      data: { email: `${s}@mhnt494.test`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
    });
    const emp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `MHNT-${s}`,
        firstName: "Target",
        lastName: spec.key,
        hireDate: new Date(`${spec.hire}T00:00:00Z`),
        isTimeTrackingExempt: false,
      },
    });
    for (const sch of spec.schedules) {
      await app.prisma.workSchedule.create({
        data: {
          employeeId: emp.id,
          validFrom: new Date(`${sch.validFrom}T00:00:00Z`),
          ...sch.data,
        } as never,
      });
    }
    await app.prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    const makeEntry = async (ds: string, isLocked: boolean) => {
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
          isLocked,
        },
      });
    };
    for (const ds of spec.entries) await makeEntry(ds, false);
    for (const ds of spec.lockedEntries ?? []) await makeEntry(ds, true);
    for (const snap of spec.legacySnapshots ?? []) {
      const { start, end } = monthRangeUtc(2026, snap.month, TZ);
      await app.prisma.saldoSnapshot.create({
        data: {
          employeeId: emp.id,
          periodType: "MONTHLY",
          periodStart: start,
          periodEnd: end,
          workedMinutes: snap.workedMinutes,
          expectedMinutes: snap.expectedMinutes,
          balanceMinutes: snap.balanceMinutes,
          carryOver: snap.carryOver,
          closedAt: new Date(end.getTime() + 24 * 60 * 60_000),
          closedBy: "mhnt494-seed",
        },
      });
    }
    return emp.id;
  }

  async function atClock<T>(iso: string, fn: (token: string) => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
    try {
      return await fn(reissueTokenNow(app, data.adminToken));
    } finally {
      vi.useRealTimers();
    }
  }

  async function liveGet(id: string, iso = NOW): Promise<Live> {
    return atClock(iso, async (token) => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${id}`,
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

  async function closeMonth(id: string, month: number, iso = NOW): Promise<number> {
    return atClock(iso, async (token) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/overtime/close-month",
        headers: { authorization: `Bearer ${token}` },
        payload: { employeeId: id, year: 2026, month, confirmGaps: true },
      });
      if (res.statusCode !== 201)
        console.error(`close month ${month} -> ${res.statusCode} ${res.body}`);
      return res.statusCode;
    });
  }

  async function activeSnapshots(id: string): Promise<SnapshotRow[]> {
    return app.prisma.saldoSnapshot.findMany({
      where: { employeeId: id, periodType: "MONTHLY", superseded: false },
      orderBy: { periodStart: "asc" },
      select: {
        workedMinutes: true,
        expectedMinutes: true,
        balanceMinutes: true,
        carryOver: true,
      },
    });
  }

  async function fixtureCounts(id: string) {
    const [schedules, entries, snapshots] = await Promise.all([
      app.prisma.workSchedule.count({ where: { employeeId: id } }),
      app.prisma.timeEntry.count({ where: { employeeId: id, deletedAt: null } }),
      app.prisma.saldoSnapshot.count({ where: { employeeId: id } }),
    ]);
    return { schedules, entries, snapshots };
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "mhnt494");
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("mhnt494 cleanup failed:", err);
    }
  });

  // ── G — R1, monthlyHours null, CARRY_FORWARD ──────────────────────────────
  describe("G — monthlyHours null, CARRY_FORWARD (R1)", () => {
    let id: string;
    beforeAll(async () => {
      id = await createEmp({
        key: "G",
        hire: "2026-01-01",
        schedules: [
          {
            validFrom: "2026-01-01",
            data: { ...MH_BASE, monthlyHours: null, overtimeMode: "CARRY_FORWARD" },
          },
        ],
        entries: block(1, 2, 3, 4, 5, 6),
      });
    }, 120_000);

    it("KEEP · fixture G: one contract row, 30 entries, no snapshot", async () => {
      expect(await fixtureCounts(id)).toEqual({ schedules: 1, entries: 30, snapshots: 0 });
    });

    it("FLIP R1 · live saldo is 0 (no Soll, no carry), nothing confirmed, nothing open", async () => {
      // Hand: a contract without monthly hours has no Soll, and with the mode forced to track-only
      // the 9000 worked minutes (6 x 1500) never become a saldo. Unfixed prediction: 150 h / 0 / 9000.
      const live = await liveGet(id);
      expect({
        balanceHours: live.balanceHours,
        confirmedMinutes: live.confirmedMinutes,
        openMonthMinutes: live.openMonthMinutes,
      }).toEqual({ balanceHours: 0, confirmedMinutes: 0, openMonthMinutes: 0 });
    });

    it("FLIP R1 · Monatsabschluss Jan-Jun stores worked 1500, Soll 0, balance 1500, carry-over 0", async () => {
      // Hand: each month worked = 5 x 300 = 1500, expected 0 (no Soll), balance 1500; the track-only
      // rule zeroes the carry-over. Unfixed prediction: carry 1500, 3000 ... 9000.
      const statuses: number[] = [];
      for (let m = 1; m <= 6; m++) statuses.push(await closeMonth(id, m));
      expect(statuses).toEqual([201, 201, 201, 201, 201, 201]);
      const rows = await activeSnapshots(id);
      expect(rows).toEqual(
        Array.from({ length: 6 }, () => ({
          workedMinutes: 1500,
          expectedMinutes: 0,
          balanceMinutes: 1500,
          carryOver: 0,
        })),
      );
    });

    it("FLIP R1 · after closing, the OvertimeAccount and the live balance are 0", async () => {
      // Hand: carry-over 0 everywhere and the open July window has nothing worked -> 0.
      // Unfixed prediction: 150 h.
      await atClock(NOW, async () => {
        await updateOvertimeAccount(app, id);
      });
      const acc = await app.prisma.overtimeAccount.findUniqueOrThrow({ where: { employeeId: id } });
      const live = await liveGet(id);
      expect({ account: Number(acc.balanceHours), live: live.balanceHours }).toEqual({
        account: 0,
        live: 0,
      });
    });
  });

  // ── H — R1, monthlyHours 0, CARRY_FORWARD ────────────────────────────────
  describe("H — monthlyHours 0, CARRY_FORWARD (R1)", () => {
    let id: string;
    beforeAll(async () => {
      id = await createEmp({
        key: "H",
        hire: "2026-01-01",
        schedules: [
          {
            validFrom: "2026-01-01",
            data: { ...MH_BASE, monthlyHours: 0, overtimeMode: "CARRY_FORWARD" },
          },
        ],
        entries: block(1, 2, 3, 4, 5, 6),
      });
    }, 120_000);

    it("KEEP · fixture H: stored monthlyHours reads back as a Decimal equal to 0", async () => {
      const row = await app.prisma.workSchedule.findFirstOrThrow({ where: { employeeId: id } });
      expect(row.monthlyHours).not.toBeNull();
      expect(typeof row.monthlyHours).toBe("object"); // Prisma Decimal, not a number
      expect(Number(row.monthlyHours)).toBe(0);
      expect(row.overtimeMode).toBe("CARRY_FORWARD");
      expect((await fixtureCounts(id)).entries).toBe(30);
    });

    it("FLIP R1 · live saldo is 0 (unfixed prediction: 150 h)", async () => {
      // Hand: same as G — 0 h contract has no Soll and no saldo.
      const live = await liveGet(id);
      expect({
        balanceHours: live.balanceHours,
        confirmedMinutes: live.confirmedMinutes,
        openMonthMinutes: live.openMonthMinutes,
      }).toEqual({ balanceHours: 0, confirmedMinutes: 0, openMonthMinutes: 0 });
    });

    it("FLIP R1 · closing January writes carry-over 0 (unfixed prediction: 1500)", async () => {
      // Hand: January worked 1500, Soll 0, balance 1500, track-only zeroes the carry.
      expect(await closeMonth(id, 1)).toBe(201);
      expect(await activeSnapshots(id)).toEqual([
        { workedMinutes: 1500, expectedMinutes: 0, balanceMinutes: 1500, carryOver: 0 },
      ]);
    });
  });

  // ── I — R1 + D-02/D-03, legacy stale carry ───────────────────────────────
  describe("I — legacy stale carry-over on a 0 h CARRY_FORWARD contract (R1, D-02, D-03)", () => {
    let id: string;
    let mayId: string;
    beforeAll(async () => {
      id = await createEmp({
        key: "I",
        hire: "2026-03-01",
        schedules: [
          {
            validFrom: "2026-03-01",
            data: { ...MH_BASE, monthlyHours: null, overtimeMode: "CARRY_FORWARD" },
          },
        ],
        lockedEntries: [ymd(3, 16), ymd(4, 16), ymd(5, 15)],
        entries: block(6),
        // Consistent legacy chain written under the old rule: carry = carry-in + balance.
        legacySnapshots: [
          { month: 3, workedMinutes: 600, expectedMinutes: 0, balanceMinutes: 600, carryOver: 600 },
          {
            month: 4,
            workedMinutes: 900,
            expectedMinutes: 0,
            balanceMinutes: 900,
            carryOver: 1500,
          },
          {
            month: 5,
            workedMinutes: 588,
            expectedMinutes: 0,
            balanceMinutes: 588,
            carryOver: 2088,
          },
        ],
      });
      mayId = (
        await app.prisma.saldoSnapshot.findFirstOrThrow({
          where: { employeeId: id, carryOver: 2088 },
          select: { id: true },
        })
      ).id;
    }, 120_000);

    it("KEEP · fixture I: three legacy snapshots, three locked entries, five open June entries", async () => {
      expect(await fixtureCounts(id)).toEqual({ schedules: 1, entries: 8, snapshots: 3 });
      expect(await activeSnapshots(id)).toEqual([
        { workedMinutes: 600, expectedMinutes: 0, balanceMinutes: 600, carryOver: 600 },
        { workedMinutes: 900, expectedMinutes: 0, balanceMinutes: 900, carryOver: 1500 },
        { workedMinutes: 588, expectedMinutes: 0, balanceMinutes: 588, carryOver: 2088 },
      ]);
    });

    it("FLIP R1 · live saldo is 0/0/0 although a closed month exists (unfixed: 59.8 h / 2088 / 1500)", async () => {
      // Hand: no stored value is rewritten (D-02), but the live figure ignores the stale carry and
      // the open June work (1500) because the contract has no monthly hours.
      const live = await liveGet(id);
      expect(live).toEqual({
        balanceHours: 0,
        confirmedMinutes: 0,
        openMonthMinutes: 0,
        hasClosedMonth: true,
      });
    });

    it("FLIP R1 · closing June writes carry-over 0 and leaves the May row untouched (unfixed carry: 3588)", async () => {
      // Hand: June worked 1500, Soll 0, balance 1500; carry zeroed. The May row keeps its stored
      // carry 2088 as audit evidence (same id, not superseded).
      expect(await closeMonth(id, 6)).toBe(201);
      const rows = await activeSnapshots(id);
      expect(rows[rows.length - 1]).toEqual({
        workedMinutes: 1500,
        expectedMinutes: 0,
        balanceMinutes: 1500,
        carryOver: 0,
      });
      const may = await app.prisma.saldoSnapshot.findUniqueOrThrow({ where: { id: mayId } });
      expect({ carryOver: may.carryOver, superseded: may.superseded }).toEqual({
        carryOver: 2088,
        superseded: false,
      });
    });
  });

  // ── K — D-10, 0 h CARRY_FORWARD then 40 h ────────────────────────────────
  describe("K — contract change 0 h CARRY_FORWARD -> FIXED 40 h from 2026-07-01 (D-04, D-10)", () => {
    let id: string;
    let liveBefore: Live;
    beforeAll(async () => {
      id = await createEmp({
        key: "K",
        hire: "2026-01-01",
        schedules: [
          {
            validFrom: "2026-01-01",
            data: { ...MH_BASE, monthlyHours: null, overtimeMode: "CARRY_FORWARD" },
          },
          { validFrom: "2026-07-01", data: FIXED_40 },
        ],
        entries: [...block(1, 2, 3, 4, 5), ymd(7, 1), ymd(7, 2), ymd(7, 3)],
      });
    }, 120_000);

    it("KEEP · fixture K: two contract rows, 28 entries (Jan-May blocks + 01.-03.07.), no snapshot", async () => {
      expect(await fixtureCounts(id)).toEqual({ schedules: 2, entries: 28, snapshots: 0 });
    });

    it("FLIP D-10 · live before any close is -113 h: Jan-Jun contribute 0, only July counts (unfixed: 12 h)", async () => {
      // Hand: Jan-Jun were a 0 h contract and are zeroed exactly as a close would zero them -> 0.
      // July 01.-22. (yesterday is the window end) = 16 weekdays x 480 = 7680 Soll, worked 3 x 300
      // = 900 -> 900 - 7680 = -6780 min = -113 h; nothing confirmed, all of it open.
      // Unfixed prediction: 7500 (Jan-May worked, no Soll) - 6780 = +720 min = 12 h (probe S3).
      liveBefore = await liveGet(id);
      expect({
        balanceHours: liveBefore.balanceHours,
        confirmedMinutes: liveBefore.confirmedMinutes,
        openMonthMinutes: liveBefore.openMonthMinutes,
      }).toEqual({ balanceHours: -113, confirmedMinutes: 0, openMonthMinutes: -6780 });
    });

    it("FLIP R1 · closing Jan-Jun stores carry-over 0 on every row and the live balance stays -113 h", async () => {
      // Hand: Jan-May {worked 1500, Soll 0, balance 1500, carry 0}; June has no entries {0,0,0,0};
      // live afterwards: confirmed 0, July open -6780. Unfixed prediction: carries 1500 ... 7500 and
      // a live balance of +720 min.
      for (let m = 1; m <= 6; m++) expect(await closeMonth(id, m)).toBe(201);
      const rows = await activeSnapshots(id);
      const live = await liveGet(id);
      expect(rows).toEqual([
        ...Array.from({ length: 5 }, () => ({
          workedMinutes: 1500,
          expectedMinutes: 0,
          balanceMinutes: 1500,
          carryOver: 0,
        })),
        { workedMinutes: 0, expectedMinutes: 0, balanceMinutes: 0, carryOver: 0 },
      ]);
      expect(live.balanceHours).toBe(-113);
    });

    it("FLIP D-10 · live == closed: the figure before closing equals the figure after (-113 h both)", async () => {
      const after = await liveGet(id);
      expect({ before: liveBefore.balanceHours, after: after.balanceHours }).toEqual({
        before: -113,
        after: -113,
      });
    });
  });

  // ── K2 — D-10, explicit TRACK_ONLY then 40 h ─────────────────────────────
  describe("K2 — contract change 0 h TRACK_ONLY -> FIXED 40 h from 2026-07-01 (D-10 covers explicit TRACK_ONLY)", () => {
    let id: string;
    let liveBefore: Live;
    beforeAll(async () => {
      id = await createEmp({
        key: "K2",
        hire: "2026-01-01",
        schedules: [
          {
            validFrom: "2026-01-01",
            data: { ...MH_BASE, monthlyHours: null, overtimeMode: "TRACK_ONLY" },
          },
          { validFrom: "2026-07-01", data: FIXED_40 },
        ],
        entries: [...block(1, 2, 3, 4, 5), ymd(7, 1), ymd(7, 2), ymd(7, 3)],
      });
    }, 120_000);

    it("KEEP · fixture K2: two contract rows, 28 entries, no snapshot", async () => {
      expect(await fixtureCounts(id)).toEqual({ schedules: 2, entries: 28, snapshots: 0 });
    });

    it("FLIP D-10 · live before any close is -113 h (unfixed: +12 h, the pre-existing leak of probe S3)", async () => {
      // Hand: identical to K — the explicit TRACK_ONLY months contribute 0, July -6780 min.
      liveBefore = await liveGet(id);
      expect({
        balanceHours: liveBefore.balanceHours,
        confirmedMinutes: liveBefore.confirmedMinutes,
        openMonthMinutes: liveBefore.openMonthMinutes,
      }).toEqual({ balanceHours: -113, confirmedMinutes: 0, openMonthMinutes: -6780 });
    });

    it("KEEP · closing Jan-Jun stores carry-over 0 on every row and the live balance is -113 h (already true today)", async () => {
      for (let m = 1; m <= 6; m++) expect(await closeMonth(id, m)).toBe(201);
      const rows = await activeSnapshots(id);
      const live = await liveGet(id);
      expect(rows.map((r) => r.carryOver)).toEqual([0, 0, 0, 0, 0, 0]);
      expect(live.balanceHours).toBe(-113);
    });

    it("FLIP D-10 · live == closed: the figure before closing equals the figure after (-113 h both)", async () => {
      const after = await liveGet(id);
      expect({ before: liveBefore.balanceHours, after: after.balanceHours }).toEqual({
        before: -113,
        after: -113,
      });
    });
  });

  // ── L — D-04, 40 h then 0 h ──────────────────────────────────────────────
  describe("L — contract change FIXED 40 h -> 0 h CARRY_FORWARD from 2026-07-01 (D-04)", () => {
    let id: string;
    let juneId: string;
    beforeAll(async () => {
      id = await createEmp({
        key: "L",
        hire: "2026-06-01",
        schedules: [
          { validFrom: "2026-06-01", data: FIXED_40 },
          {
            validFrom: "2026-07-01",
            data: { ...MH_BASE, monthlyHours: null, overtimeMode: "CARRY_FORWARD" },
          },
        ],
        entries: block(6),
      });
    }, 120_000);

    it("KEEP · fixture L: two contract rows, five June entries, no snapshot", async () => {
      expect(await fixtureCounts(id)).toEqual({ schedules: 2, entries: 5, snapshots: 0 });
    });

    it("FLIP R1 · live at 2026-07-23 is 0/0/0 under today's 0 h contract (unfixed: -151 h)", async () => {
      // Hand: the live display follows today's contract (existing deliberate rule); today's contract
      // has no monthly hours -> 0. Unfixed prediction: June 1500 - 10560 = -9060 min = -151 h.
      const live = await liveGet(id);
      expect({
        balanceHours: live.balanceHours,
        confirmedMinutes: live.confirmedMinutes,
        openMonthMinutes: live.openMonthMinutes,
      }).toEqual({ balanceHours: 0, confirmedMinutes: 0, openMonthMinutes: 0 });
    });

    it("KEEP · closing June keeps its carry-over: the month under the 40 h contract is history (D-04)", async () => {
      // Hand: June is a 40 h month: 22 weekdays x 480 = 10560 Soll, worked 5 x 300 = 1500,
      // balance -9060, carry-over -9060 (a later 0 h contract does not retroactively zero it).
      expect(await closeMonth(id, 6)).toBe(201);
      const rows = await activeSnapshots(id);
      juneId = (
        await app.prisma.saldoSnapshot.findFirstOrThrow({
          where: { employeeId: id, superseded: false },
          select: { id: true },
        })
      ).id;
      expect(rows).toEqual([
        { workedMinutes: 1500, expectedMinutes: 10560, balanceMinutes: -9060, carryOver: -9060 },
      ]);
    });

    it("FLIP R1 · closing July at 2026-08-10 stores carry-over 0 and leaves June untouched (unfixed carry: -9060)", async () => {
      // Hand: July is a 0 h month: worked 0, Soll 0, balance 0; track-only drops the carried 40 h-era
      // saldo from the chain -> carry 0. The June row keeps its stored -9060 (same id).
      expect(await closeMonth(id, 7, "2026-08-10T10:00:00.000Z")).toBe(201);
      const rows = await activeSnapshots(id);
      const june = await app.prisma.saldoSnapshot.findUniqueOrThrow({ where: { id: juneId } });
      expect(rows[rows.length - 1]).toEqual({
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
      });
      expect({ carryOver: june.carryOver, superseded: june.superseded }).toEqual({
        carryOver: -9060,
        superseded: false,
      });
    });

    it("FLIP R1 · live at 2026-08-10 after the July close is 0 (unfixed: -151 h)", async () => {
      const live = await liveGet(id, "2026-08-10T10:00:00.000Z");
      expect(live.balanceHours).toBe(0);
    });
  });

  // ── M — D-03/R6, recalc never rewrites a closed month ────────────────────
  describe("M — recalculateSnapshots skips a locked legacy month of a 0 h CARRY_FORWARD contract (D-03, R6)", () => {
    let id: string;
    beforeAll(async () => {
      id = await createEmp({
        key: "M",
        hire: "2026-05-01",
        schedules: [
          {
            validFrom: "2026-05-01",
            data: { ...MH_BASE, monthlyHours: null, overtimeMode: "CARRY_FORWARD" },
          },
        ],
        entries: [],
        lockedEntries: [ymd(5, 15)],
        legacySnapshots: [
          {
            month: 5,
            workedMinutes: 2088,
            expectedMinutes: 0,
            balanceMinutes: 2088,
            carryOver: 2088,
          },
        ],
      });
    }, 120_000);

    it("KEEP · fixture M: one legacy snapshot, one locked entry", async () => {
      expect(await fixtureCounts(id)).toEqual({ schedules: 1, entries: 1, snapshots: 1 });
    });

    it("KEEP · recalculating from the May snapshot skips it and leaves the row byte-identical", async () => {
      const first = await app.prisma.saldoSnapshot.findFirstOrThrow({ where: { employeeId: id } });
      const result = await recalculateSnapshots(app, id, first.periodStart);
      const second = await app.prisma.saldoSnapshot.findUniqueOrThrow({ where: { id: first.id } });
      expect(result.lockedMonthsSkipped.map((s) => s.snapshotId)).toEqual([first.id]);
      expect(second).toEqual(first);
      expect(await app.prisma.saldoSnapshot.count({ where: { employeeId: id } })).toBe(1);
    });
  });

  // ── J — R1, cron close — LAST on purpose ─────────────────────────────────
  describe("J — cron auto-close of a 0 h CARRY_FORWARD contract (R1)", () => {
    let id: string;
    beforeAll(async () => {
      id = await createEmp({
        key: "J",
        hire: "2026-06-01",
        schedules: [
          {
            validFrom: "2026-06-01",
            data: { ...MH_BASE, monthlyHours: 0, overtimeMode: "CARRY_FORWARD" },
          },
        ],
        entries: block(6),
      });
    }, 120_000);

    it("KEEP · fixture J: one contract row, five June entries, no snapshot", async () => {
      expect(await fixtureCounts(id)).toEqual({ schedules: 1, entries: 5, snapshots: 0 });
    });

    it("FLIP R1 · the cron close of June stores worked 1500, Soll 0, balance 1500, carry-over 0 (unfixed carry: 1500)", async () => {
      // Hand: June worked 5 x 300 = 1500, no Soll, balance 1500; track-only zeroes the carry.
      // The cron runs on 16.07. 06:00Z (Berlin 08:00, past the grace day 15) and closes June.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-07-16T06:00:00.000Z"));
      try {
        await app.tryAutoCloseMonth();
      } finally {
        vi.useRealTimers();
      }
      expect(await activeSnapshots(id)).toEqual([
        { workedMinutes: 1500, expectedMinutes: 0, balanceMinutes: 1500, carryOver: 0 },
      ]);
    }, 120_000);
  });
});
