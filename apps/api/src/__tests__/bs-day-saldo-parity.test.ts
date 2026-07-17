/**
 * Executable proof for the BBiG §15 Berufsschule (BS) saldo semantics — the
 * question raised while verifying debug defects D7/D10.
 *
 * CLAIM UNDER TEST: a Berufsschultag (VOCATIONAL_SCHOOL absence) must be
 * BALANCE-NEUTRAL — an Azubi at Berufsschule ends up with the SAME saldo as if
 * that day had been fulfilled (BBiG §15: Berufsschulzeit = Arbeitszeit). The
 * live path must agree with the (legally binding) manual month-close.
 *
 * Mechanism: the base Soll (calcExpectedMinutesTz) counts the BS day as a normal
 * workday. BS-doubling then adds the day to BOTH worked and expected. Neutrality
 * therefore requires the BS day to ALSO be subtracted once via the absence path
 * (as overtime.ts:1124-1155 does). The former live/cron code filtered
 * VOCATIONAL_SCHOOL out of that subtraction → the base count was never cancelled
 * → each BS day left a −1×daily-Soll penalty AND made the live saldo diverge
 * from the closed snapshot by that amount.
 *
 * Both assertions below FAIL on the pre-D10 code and PASS on the fixed code:
 *   1. consistency: live saldo == manual-closed snapshot saldo (Azubi w/ BS day)
 *   2. neutrality : liveBalance(BS day) − liveBalance(unexcused gap) == daily Soll
 *
 * No PII — synthetic employees only (memory: no PII in artifacts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { monthRangeUtc } from "../utils/timezone";
import { updateOvertimeAccount } from "../routes/time-entries";

const TZ = "Europe/Berlin";
// FIXED_SCHEDULE Azubi, Mo=0, Di–Fr=9.5h. June 9 2026 is a Tuesday → daily Soll 570.
const DAILY_SOLL_MIN = 570;
const BS_DATE = "2026-06-09";
// Evaluate live + close at the same pinned "now" so the ranges match exactly.
const NOW = new Date("2026-07-01T10:00:00.000Z");

describe("BBiG §15 — Berufsschultag is balance-neutral (live == closed)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  async function createAzubi(tag: string): Promise<string> {
    const s = `bs-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const user = await app.prisma.user.create({
      data: { email: `${s}@bs.test`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
    });
    const emp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `BS-${s}`,
        firstName: "Azubi",
        lastName: tag,
        hireDate: new Date("2026-06-01T00:00:00Z"),
        isTimeTrackingExempt: false,
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        validFrom: new Date("2026-06-01T00:00:00Z"),
        type: "FIXED_SCHEDULE",
        weeklyHours: 38,
        mondayHours: 0,
        tuesdayHours: 9.5,
        wednesdayHours: 9.5,
        thursdayHours: 9.5,
        fridayHours: 9.5,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [2, 3, 4, 5],
      } as never,
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    // May-2026 zero snapshot: live open-range starts June 1 and the manual-close
    // sequential guard sees the previous month as closed.
    const may = monthRangeUtc(2026, 5, TZ);
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: emp.id,
        periodType: "MONTHLY",
        periodStart: may.start,
        periodEnd: may.end,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
        closedBy: "bs-parity-seed",
      },
    });
    return emp.id;
  }

  // Seed a normal WORK entry (480 net) on every Tue–Fri in June EXCEPT the BS date.
  async function seedJuneWork(empId: string) {
    const cur = new Date("2026-06-01T00:00:00Z");
    const end = new Date("2026-06-30T00:00:00Z");
    while (cur <= end) {
      const dow = cur.getUTCDay();
      const dateStr = cur.toISOString().slice(0, 10);
      if ([2, 3, 4, 5].includes(dow) && dateStr !== BS_DATE) {
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
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }

  async function liveBalanceMin(empId: string): Promise<number> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      await updateOvertimeAccount(app, empId);
      const acc = await app.prisma.overtimeAccount.findUnique({ where: { employeeId: empId } });
      return Math.round(Number(acc!.balanceHours) * 60);
    } finally {
      vi.useRealTimers();
    }
  }

  async function closeJune(empId: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      return await app.inject({
        method: "POST",
        url: "/api/v1/overtime/close-month",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { employeeId: empId, year: 2026, month: 6 },
      });
    } finally {
      vi.useRealTimers();
    }
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "bsparity");
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  it("consistency: live saldo == manual-closed snapshot for an Azubi with a BS day", async () => {
    const emp = await createAzubi("consist");
    await seedJuneWork(emp);
    await app.prisma.absence.create({
      data: {
        employeeId: emp,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: new Date(BS_DATE),
        endDate: new Date(BS_DATE),
        days: 1,
        createdBy: data.adminUser.id,
      },
    });

    // Live BEFORE closing (no June snapshot yet → live computes the open month).
    const liveMin = await liveBalanceMin(emp);

    const res = await closeJune(emp);
    expect(res.statusCode, res.body).toBe(201);

    const snap = await app.prisma.saldoSnapshot.findFirst({
      where: {
        employeeId: emp,
        periodType: "MONTHLY",
        superseded: false,
        periodEnd: new Date("2026-06-30T00:00:00Z"),
      },
    });
    expect(snap).not.toBeNull();

    // THE INVARIANT: the live-displayed saldo equals the legally-binding closed
    // snapshot. Pre-D10 these diverged by exactly one daily Soll (the BS day).
    expect(liveMin, "live == closed for Azubi with BS day").toBe(snap!.balanceMinutes);
  });

  it("neutrality: a BS day is worth exactly one fulfilled day vs an unexcused gap", async () => {
    // Employee B: BS day on June 9. Employee C: identical, but June 9 is a plain
    // gap (no entry, no absence = unfulfilled workday).
    const empBs = await createAzubi("neutral-bs");
    const empGap = await createAzubi("neutral-gap");
    await seedJuneWork(empBs);
    await seedJuneWork(empGap);
    await app.prisma.absence.create({
      data: {
        employeeId: empBs,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: new Date(BS_DATE),
        endDate: new Date(BS_DATE),
        days: 1,
        createdBy: data.adminUser.id,
      },
    });

    const bsMin = await liveBalanceMin(empBs);
    const gapMin = await liveBalanceMin(empGap);

    // BBiG §15: the BS day is fulfilled, the gap is not → B is better off by
    // exactly one daily Soll. Pre-D10 the BS day was ALSO penalized → delta 0.
    expect(bsMin - gapMin, "BS day fulfilled vs unexcused gap = one daily Soll").toBe(
      DAILY_SOLL_MIN,
    );
  });
});
