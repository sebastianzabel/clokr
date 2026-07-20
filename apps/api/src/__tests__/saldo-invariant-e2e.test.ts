/**
 * E2E saldo invariant — realistic dataset 2026-01-01 → 2026-07-15, one employee
 * per schedule type (FIXED_SCHEDULE, SHIFT_BASED, MONTHLY_HOURS budget,
 * MONTHLY_HOURS pure tracking, FLEXTIME).
 *
 * THE INVARIANT: the saldo must be identical whether months are open or closed.
 *   live (all open)  ==  cron-closed Jan–Jun + live July
 *   cron close       ==  manual close (same snapshot values)
 *   close            ==  retroactive recalc (unchanged data reproduces values)
 * Plus the guards: D2 (cron backward backfill loop — Phase 76.27-03), D3b (later-month-closed rejection).
 *
 * Dataset details:
 *  - approved vacation Mar 9–13, SICK absence May 18–19 (all employees)
 *  - NI public holidays skipped in entries (computed via getHolidays)
 *  - SHIFT_BASED: shifts on Tue/Thu/Fri Jan–Jun alternating 7h/9h, one week in
 *    April (13.–17.) without a shift plan (imperfect data — worked w/o Soll)
 *  - FIXED gets an extra Sunday entry on 2026-05-31 to exercise the month-
 *    boundary-day fix (pre-fix: double-counted in May AND June snapshots)
 *
 * No PII — synthetic employees only.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { monthRangeUtc } from "../utils/timezone";
import { updateOvertimeAccount } from "../routes/time-entries";
import { recalculateSnapshots } from "../utils/recalculate-snapshots";
import { getHolidays } from "../utils/holidays";

// "Today" for every live-saldo evaluation (Berlin Jul 16 — cron grace day >= 15).
const FINAL_NOW = new Date("2026-07-16T10:00:00.000Z");
const TZ = "Europe/Berlin";

type EmpKey = "fixed" | "shift" | "mhBudget" | "mhPure" | "flex";
const EMP_KEYS: EmpKey[] = ["fixed", "shift", "mhBudget", "mhPure", "flex"];

describe("saldo invariant E2E — all schedule types, Jan–Jul 2026", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const empIds = {} as Record<EmpKey, string>;

  // Recorded values shared across sequential steps
  const liveBefore = {} as Record<EmpKey, number>;
  const cronJune = {} as Record<
    EmpKey,
    { workedMinutes: number; expectedMinutes: number; balanceMinutes: number; carryOver: number }
  >;
  let preRecalcSnapshots: Record<EmpKey, Awaited<ReturnType<typeof fetchMonthlySnapshots>>>;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function dayStrings(fromStr: string, toStr: string, weekdays: number[]): string[] {
    const out: string[] = [];
    const cur = new Date(fromStr + "T00:00:00Z");
    const end = new Date(toStr + "T00:00:00Z");
    while (cur <= end) {
      if (weekdays.includes(cur.getUTCDay())) out.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
  }

  // Covered days (no entries seeded): NI holidays + vacation + sick
  const holidayStrs = new Set(getHolidays(2026, "NI").map((h) => h.date));
  const leaveDays = new Set(["2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13"]);
  const sickDays = new Set(["2026-05-18", "2026-05-19"]);
  const isCovered = (d: string) => holidayStrs.has(d) || leaveDays.has(d) || sickDays.has(d);

  async function seedEntry(empId: string, dateStr: string) {
    // 07:00–15:30 UTC minus 30 min break = 480 net minutes
    await app.prisma.timeEntry.create({
      data: {
        employeeId: empId,
        date: new Date(dateStr + "T00:00:00Z"),
        startTime: new Date(dateStr + "T07:00:00Z"),
        endTime: new Date(dateStr + "T15:30:00Z"),
        breakMinutes: 30,
        type: "WORK",
      },
    });
  }

  async function liveBalance(empId: string): Promise<number> {
    await updateOvertimeAccount(app, empId);
    const acc = await app.prisma.overtimeAccount.findUnique({ where: { employeeId: empId } });
    return Number(acc!.balanceHours);
  }

  async function fetchMonthlySnapshots(empId: string) {
    return app.prisma.saldoSnapshot.findMany({
      where: {
        employeeId: empId,
        periodType: "MONTHLY",
        superseded: false,
        periodEnd: { gte: new Date("2026-01-01T00:00:00Z") },
      },
      orderBy: { periodEnd: "asc" },
      select: {
        workedMinutes: true,
        expectedMinutes: true,
        balanceMinutes: true,
        carryOver: true,
        periodEnd: true,
      },
    });
  }

  async function activeJuneSnapshot(empId: string) {
    return app.prisma.saldoSnapshot.findFirst({
      where: {
        employeeId: empId,
        periodType: "MONTHLY",
        superseded: false,
        periodEnd: new Date("2026-06-30T00:00:00Z"),
      },
    });
  }

  async function closeMonth(empId: string, month: number) {
    return app.inject({
      method: "POST",
      url: "/api/v1/overtime/close-month",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: empId, year: 2026, month },
    });
  }

  async function unlockMonth(empId: string, month: number) {
    return app.inject({
      method: "POST",
      url: "/api/v1/overtime/unlock-month",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: empId, year: 2026, month, reason: "e2e saldo invariant test" },
    });
  }

  async function runCronAt(iso: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
    try {
      await app.tryAutoCloseMonth();
    } finally {
      vi.useRealTimers();
    }
  }

  async function liveAtFinalNow(empId: string): Promise<number> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FINAL_NOW);
    try {
      return await liveBalance(empId);
    } finally {
      vi.useRealTimers();
    }
  }

  // ── Setup ─────────────────────────────────────────────────────────────────

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "e2esaldo");
    const prisma = app.prisma;
    const HIRE = new Date("2026-01-01T00:00:00Z");

    async function createEmp(key: EmpKey, scheduleData: Record<string, unknown>): Promise<string> {
      const s = `${key}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
      const user = await prisma.user.create({
        data: { email: `${s}@e2e.test`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
      });
      const emp = await prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: user.id,
          employeeNumber: `E2E-${s}`,
          firstName: "E2E",
          lastName: key,
          hireDate: HIRE,
          isTimeTrackingExempt: false,
        },
      });
      await prisma.workSchedule.create({
        data: { employeeId: emp.id, validFrom: HIRE, ...scheduleData } as never,
      });
      await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
      // Dec-2025 zero snapshot: live open-range starts Jan 1 (without any snapshot
      // the live calc falls back to the current month only).
      const dec = monthRangeUtc(2025, 12, TZ);
      await prisma.saldoSnapshot.create({
        data: {
          employeeId: emp.id,
          periodType: "MONTHLY",
          periodStart: dec.start,
          periodEnd: dec.end,
          workedMinutes: 0,
          expectedMinutes: 0,
          balanceMinutes: 0,
          carryOver: 0,
          closedAt: new Date(),
          closedBy: "e2e-seed",
        },
      });
      empIds[key] = emp.id;
      return emp.id;
    }

    await createEmp("fixed", {
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
    });
    await createEmp("shift", {
      type: "SHIFT_BASED",
      weeklyHours: 38,
      mondayHours: 0,
      tuesdayHours: 1,
      wednesdayHours: 0,
      thursdayHours: 1,
      fridayHours: 1,
      saturdayHours: 0,
      sundayHours: 0,
      workDays: [2, 4, 5],
    });
    await createEmp("mhBudget", {
      type: "MONTHLY_HOURS",
      weeklyHours: null,
      monthlyHours: 50,
      mondayHours: 0,
      tuesdayHours: 0,
      wednesdayHours: 0,
      thursdayHours: 0,
      fridayHours: 0,
      saturdayHours: 0,
      sundayHours: 0,
      overtimeMode: "CARRY_FORWARD",
    });
    await createEmp("mhPure", {
      type: "MONTHLY_HOURS",
      weeklyHours: null,
      monthlyHours: null,
      mondayHours: 0,
      tuesdayHours: 0,
      wednesdayHours: 0,
      thursdayHours: 0,
      fridayHours: 0,
      saturdayHours: 0,
      sundayHours: 0,
      overtimeMode: "CARRY_FORWARD",
    });
    await createEmp("flex", {
      type: "FLEXTIME",
      weeklyHours: 38,
      mondayHours: 0,
      tuesdayHours: 9.5,
      wednesdayHours: 9.5,
      thursdayHours: 9.5,
      fridayHours: 9.5,
      saturdayHours: 0,
      sundayHours: 0,
      workDays: [2, 3, 4, 5],
    });

    // Leave type + approved vacation Mar 9–13 and SICK May 18–19 for everyone
    const leaveType = await prisma.leaveType.create({
      data: { tenantId: data.tenant.id, name: "Urlaub E2E", isPaid: true, requiresApproval: false },
    });
    for (const key of EMP_KEYS) {
      await prisma.leaveRequest.create({
        data: {
          employeeId: empIds[key],
          leaveTypeId: leaveType.id,
          startDate: new Date("2026-03-09"),
          endDate: new Date("2026-03-13"),
          days: 5,
          status: "APPROVED",
        },
      });
      await prisma.absence.create({
        data: {
          employeeId: empIds[key],
          type: "SICK",
          source: "MANUAL",
          startDate: new Date("2026-05-18"),
          endDate: new Date("2026-05-19"),
          days: 2,
          createdBy: data.adminEmployee.id,
        },
      });
    }

    // Time entries Jan 1 – Jul 15 (skip holidays/leave/sick)
    const RANGE_END = "2026-07-15";
    const workdaysFor: Record<EmpKey, number[]> = {
      fixed: [1, 2, 3, 4, 5], // Mon–Fri
      shift: [2, 4, 5], // Tue/Thu/Fri
      mhBudget: [2, 4], // Tue/Thu (flexible Minijob)
      mhPure: [2, 4],
      flex: [2, 3, 4, 5], // Tue–Fri
    };
    for (const key of EMP_KEYS) {
      for (const d of dayStrings("2026-01-01", RANGE_END, workdaysFor[key])) {
        if (isCovered(d)) continue;
        await seedEntry(empIds[key], d);
      }
    }
    // Boundary-day probe: extra Sunday entry on 2026-05-31 for the FIXED employee.
    // Pre-fix this was double-counted (May close upper bound AND June close lower bound).
    await seedEntry(empIds.fixed, "2026-05-31");

    // SHIFT_BASED shift plan Jan–Jun on Tue/Thu/Fri, alternating 7h/9h; the week
    // 2026-04-13..17 has NO plan (imperfect data — entries exist, Soll does not).
    const noPlanWeek = new Set(["2026-04-14", "2026-04-16", "2026-04-17"]);
    let alt = 0;
    for (const d of dayStrings("2026-01-01", "2026-06-30", [2, 4, 5])) {
      if (isCovered(d) || noPlanWeek.has(d)) continue;
      const nineHour = alt++ % 2 === 0;
      await app.prisma.shift.create({
        data: {
          employeeId: empIds.shift,
          date: new Date(d + "T00:00:00Z"),
          startTime: "09:00",
          endTime: nineHour ? "18:00" : "16:00", // 9h → 510 net / 7h → 390 net
        },
      });
    }
  }, 300_000);

  afterAll(async () => {
    try {
      const employees = await app.prisma.employee.findMany({
        where: { tenantId: data.tenant.id },
        select: { id: true },
      });
      await app.prisma.saldoSnapshot.deleteMany({
        where: { employeeId: { in: employees.map((e) => e.id) } },
      });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("saldo-invariant-e2e cleanup failed:", err);
    }
    await closeTestApp();
    vi.useRealTimers();
  });

  // ── Step 1: live saldo with ALL months open ───────────────────────────────

  it("step 1 — records the live saldo with all months open", async () => {
    for (const key of EMP_KEYS) {
      liveBefore[key] = await liveAtFinalNow(empIds[key]);
      expect(Number.isFinite(liveBefore[key])).toBe(true);
    }
  }, 120_000);

  // ── Step 2: cron closes Jan–Jun sequentially → saldo unchanged ────────────

  it("step 2 — cron-closing Jan–Jun does not change the saldo (any model)", async () => {
    // Cron closes the PREVIOUS month; iterate Feb..Jul 16th to close Jan..Jun.
    for (let m = 2; m <= 7; m++) {
      await runCronAt(`2026-${String(m).padStart(2, "0")}-16T06:00:00.000Z`);
    }

    for (const key of EMP_KEYS) {
      const snaps = await fetchMonthlySnapshots(empIds[key]);
      expect(snaps, `${key}: Jan–Jun must be closed`).toHaveLength(6);
      const june = await activeJuneSnapshot(empIds[key]);
      expect(june).not.toBeNull();
      cronJune[key] = {
        workedMinutes: june!.workedMinutes,
        expectedMinutes: june!.expectedMinutes,
        balanceMinutes: june!.balanceMinutes,
        carryOver: june!.carryOver,
      };

      const after = await liveAtFinalNow(empIds[key]);
      expect(after, `${key}: live == cron-closed saldo`).toBeCloseTo(liveBefore[key], 2);
    }
  }, 600_000);

  // ── Step 3: manual close == cron close (June snapshot values) ─────────────

  it("step 3 — manual close produces identical snapshot values to the cron close", async () => {
    for (const key of EMP_KEYS) {
      const unlockRes = await unlockMonth(empIds[key], 6);
      expect(unlockRes.statusCode, `${key}: unlock June`).toBe(200);

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FINAL_NOW);
      let closeRes;
      try {
        closeRes = await closeMonth(empIds[key], 6);
      } finally {
        vi.useRealTimers();
      }
      expect(closeRes.statusCode, `${key}: manual close June — ${closeRes.body}`).toBe(201);

      const june = await activeJuneSnapshot(empIds[key]);
      expect(june).not.toBeNull();
      expect(june!.workedMinutes, `${key}: workedMinutes`).toBe(cronJune[key].workedMinutes);
      expect(june!.expectedMinutes, `${key}: expectedMinutes`).toBe(cronJune[key].expectedMinutes);
      expect(june!.balanceMinutes, `${key}: balanceMinutes`).toBe(cronJune[key].balanceMinutes);
      expect(june!.carryOver, `${key}: carryOver`).toBe(cronJune[key].carryOver);

      const after = await liveAtFinalNow(empIds[key]);
      expect(after, `${key}: live after manual re-close`).toBeCloseTo(liveBefore[key], 2);
    }
  }, 300_000);

  // ── Step 4: later-month-closed rejection (D3b) + repair flow ──────────────

  it("step 4 — closing May while June is closed is rejected; sequential re-close restores the saldo", async () => {
    const key: EmpKey = "fixed";
    const empId = empIds[key];

    const unlockMay = await unlockMonth(empId, 5);
    expect(unlockMay.statusCode).toBe(200);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FINAL_NOW);
    try {
      // June still closed → closing May must be rejected (stale-chain protection)
      const closeMay = await closeMonth(empId, 5);
      expect(closeMay.statusCode).toBe(400);
      expect(JSON.parse(closeMay.body).error).toContain("Spätere Monate");

      // Repair flow: unlock June, then close May and June sequentially
      const unlockJune = await unlockMonth(empId, 6);
      expect(unlockJune.statusCode).toBe(200);
      expect((await closeMonth(empId, 5)).statusCode).toBe(201);
      expect((await closeMonth(empId, 6)).statusCode).toBe(201);
    } finally {
      vi.useRealTimers();
    }

    const after = await liveAtFinalNow(empId);
    expect(after).toBeCloseTo(liveBefore[key], 2);
  }, 180_000);

  // ── Step 5: cron backward-backfill loop (D2 — the prod incident scenario) ──
  //
  // Phase 76.27-03: the old sequential guard (skip June while May open) has been
  // REPLACED by a bounded backward backfill loop.  When cron targets June (the
  // prev-month ceiling), it now closes ALL open months from firstOpenMonth up to
  // and including June — oldest-first in a single cron run.
  //
  // New behavior: with May AND June both open, one cron run at July-16 closes
  // both: May first (using Apr's snapshot as carryOver base), June second (using
  // the freshly-created May snapshot as carryOver base).  June's final carryOver
  // must equal the same value that was computed when we closed it sequentially.

  it("step 5 — cron backward loop closes BOTH May and June in one run when both are open", async () => {
    const key: EmpKey = "shift";
    const empId = empIds[key];

    // Re-open June, then May → May open, June open
    expect((await unlockMonth(empId, 6)).statusCode).toBe(200);
    expect((await unlockMonth(empId, 5)).statusCode).toBe(200);

    // Cron targets June (prev month of July 16).
    // Backward loop: firstOpenMonth ≤ May < June → closes May then June in one run.
    await runCronAt("2026-07-16T06:00:00.000Z");

    const june = await activeJuneSnapshot(empId);
    expect(
      june,
      "Backward loop must close June in the same cron run (both May+June were open)",
    ).not.toBeNull();
    expect(june!.carryOver).toBe(cronJune[key].carryOver);

    const after = await liveAtFinalNow(empId);
    expect(after).toBeCloseTo(liveBefore[key], 2);
  }, 300_000);

  // ── Step 6: retroactive recalc reproduces the close values ────────────────

  it("step 6 — recalculateSnapshots on unchanged data reproduces every snapshot exactly", async () => {
    preRecalcSnapshots = {} as typeof preRecalcSnapshots;
    for (const key of EMP_KEYS) {
      preRecalcSnapshots[key] = await fetchMonthlySnapshots(empIds[key]);
      expect(preRecalcSnapshots[key]).toHaveLength(6);
    }

    for (const key of EMP_KEYS) {
      await recalculateSnapshots(app, empIds[key], new Date("2025-12-31T00:00:00Z"));

      const post = await fetchMonthlySnapshots(empIds[key]);
      expect(post).toHaveLength(6);
      for (let i = 0; i < 6; i++) {
        const pre = preRecalcSnapshots[key][i];
        expect(post[i].workedMinutes, `${key} month ${i + 1} worked`).toBe(pre.workedMinutes);
        expect(post[i].expectedMinutes, `${key} month ${i + 1} expected`).toBe(pre.expectedMinutes);
        expect(post[i].balanceMinutes, `${key} month ${i + 1} balance`).toBe(pre.balanceMinutes);
        expect(post[i].carryOver, `${key} month ${i + 1} carryOver`).toBe(pre.carryOver);
      }

      const after = await liveAtFinalNow(empIds[key]);
      expect(after, `${key}: live after recalc`).toBeCloseTo(liveBefore[key], 2);
    }
  }, 300_000);
});
