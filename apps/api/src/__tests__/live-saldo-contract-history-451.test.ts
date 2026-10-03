/**
 * live-saldo-contract-history-451.test.ts
 *
 * Issue #451 point 5 / owner decision 4 (D-04, D-05), orchestrator OQ1.
 *
 * RED-first regression suite, measured against the UNCHANGED `overtime-balance.ts` (base
 * cbe460dd): the live lifetime saldo (`computeOvertimeBalanceBreakdown`, `GET
 * /overtime/:employeeId`) must evaluate every open month — complete AND the current partial
 * month — with the WorkSchedule valid IN THAT MONTH, the same rule the Monatsabschluss paths
 * (`getEffectiveSchedule(app, employeeId, <month midpoint>)`, see
 * `plugins/auto-close-month.ts`) already use. Today it fetches ONE schedule
 * (`getEffectiveSchedule(app, employeeId)`, no date → today's contract) and reuses it for every
 * evaluated month.
 *
 * D-04 — complete months on a contract-change history (own tenant, own employee):
 *   hire 2026-01-01, 40h/Mo-Fr 8h until 31.01., 20h/Mo-Fr 4h from 01.02. — fake clock
 *   2026-03-20T10:00Z (window end = yesterday = 2026-03-19). Each month must use ITS OWN
 *   contract: Jan (row A, 8h), Feb (row B, 4h), the Mar 1-19 partial month (row B, 4h). The two
 *   independent oracles (the live total, and the sum of the three month-saldo balances) must
 *   agree.
 *
 * OQ1 — does the CURRENT PARTIAL month share the bug independently of the complete-month part?
 *   OQ1-a: the change is effective THIS month (01.02., "today" = 10.02.) — the partial month
 *     (Feb) is evaluated together with one complete month (Jan) that historically predates it.
 *   OQ1-b: the change is dated NEXT month (01.03., "today" = 10.02., not yet effective) — same
 *     shape, but nothing in the evaluated window has changed yet.
 *   Both record whatever the unchanged code actually produces — the measurement decides, not a
 *   prediction (see SUMMARY for the result and its explanation).
 *
 * D-05 — holidays before hire / after exit must never reduce the entry/exit month's Soll:
 *   entry: hire 2026-05-15 (Fri, AFTER Christi Himmelfahrt 14.05.) — 14.05. must not deduct.
 *   exit: hire 2026-05-04, exit 2026-05-20 (BEFORE Pfingstmontag 25.05.) — 25.05. (and 01.05.
 *     Tag der Arbeit, before the hire) must not deduct; 14.05. (inside the employment window)
 *     correctly does.
 *
 * Every date below is a FIXED fake clock (`vi.useFakeTimers` + `vi.setSystemTime`) — never a
 * date-relative fixture (CLAUDE.md, issues #394/#434). Tenant federalState NIEDERSACHSEN (2026
 * holidays used here: Neujahr 01.01. Thu, Tag der Arbeit 01.05. Fri, Christi Himmelfahrt 14.05.
 * Thu, Pfingstmontag 25.05. Mon).
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

async function createEmployeeWithSchedules(
  app: FastifyInstance,
  tenantId: string,
  label: string,
  hireDate: string,
  schedules: { validFrom: string; weeklyHours: number; dayHours: number }[],
  exitDate?: string,
): Promise<{ id: string }> {
  const passwordHash = await bcrypt.hash("test1234", 10);
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const user = await app.prisma.user.create({
    data: { email: `${label}-${suffix}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
  });
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `${label}-${suffix}`,
      firstName: label,
      lastName: "LiveSaldo451",
      hireDate: new Date(`${hireDate}T00:00:00Z`),
      exitDate: exitDate ? new Date(`${exitDate}T00:00:00Z`) : null,
    },
  });
  for (const s of schedules) {
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: s.weeklyHours,
        mondayHours: s.dayHours,
        tuesdayHours: s.dayHours,
        wednesdayHours: s.dayHours,
        thursdayHours: s.dayHours,
        fridayHours: s.dayHours,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date(`${s.validFrom}T00:00:00Z`),
      },
    });
  }
  await app.prisma.overtimeAccount.create({
    data: { employeeId: employee.id, balanceHours: 0 },
  });
  return { id: employee.id };
}

async function getBalanceHours(app: FastifyInstance, token: string, employeeId: string) {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/overtime/${employeeId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  return Number(JSON.parse(res.body).balanceHours);
}

async function getMonthSaldoBalanceMinutes(
  app: FastifyInstance,
  token: string,
  employeeId: string,
  year: number,
  month: number,
) {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/overtime/month-saldo/${employeeId}?year=${year}&month=${month}`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  return Number(JSON.parse(res.body).balanceMinutes);
}

describe("Issue #451 Plan 05 — live saldo per-month contract (D-04/D-05, OQ1)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "451ls");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("451-05 live-saldo-contract-history cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("D-04: Jan (8h) + Feb (4h) + partial Mar (4h) each on their OWN contract — and agrees with the sum of month-saldo balances", async () => {
    const emp = await createEmployeeWithSchedules(app, data.tenant.id, "d04", "2026-01-01", [
      { validFrom: "2026-01-01", weeklyHours: 40, dayHours: 8 },
      { validFrom: "2026-02-01", weeklyHours: 20, dayHours: 4 },
    ]);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-20T10:00:00.000Z"));

    const liveBalance = await getBalanceHours(app, data.adminToken, emp.id);

    // Derivation (NIEDERSACHSEN 2026):
    //   Jan: 22 Mo-Fr days − Neujahr (01.01. Thu) = 21 workdays × 8h = 168h
    //   Feb: 20 Mo-Fr days (no NI holiday in Feb) × 4h = 80h
    //   Mar 1-19 (partial, "today" 20.03. → window end 19.03.): 14 Mo-Fr days × 4h = 56h
    //   Total Soll = 304h, Ist = 0 → balance = -304h
    const expectedTotal = -304;

    const janMinutes = await getMonthSaldoBalanceMinutes(app, data.adminToken, emp.id, 2026, 1);
    const febMinutes = await getMonthSaldoBalanceMinutes(app, data.adminToken, emp.id, 2026, 2);
    const marMinutes = await getMonthSaldoBalanceMinutes(app, data.adminToken, emp.id, 2026, 3);
    const monthSaldoSum = (janMinutes + febMinutes + marMinutes) / 60;

    // RED on the unchanged code: before the fix the live path reuses "today's contract" (row B,
    // 4h) for EVERY evaluated month, including Jan/Feb — collapsing to
    // -(21*4 + 20*4 + 14*4) = -220h. The measured value below is recorded in the SUMMARY table;
    // this assertion is the RED proof (it must currently FAIL against -304).
    expect(liveBalance).toBeCloseTo(expectedTotal, 2);
    expect(liveBalance).toBeCloseTo(monthSaldoSum, 2);
  });

  it("WR-01 (451-REVIEW.md): hire on the 20th (second half of January) — the hire month must use the HIRE schedule, not the tenant-default fallback, and must agree with the sum of month-saldo balances", async () => {
    // January's midpoint (~16.01.) precedes the 20.01. hire date: the pre-fix
    // getEffectiveSchedule(app, employeeId, <month midpoint>) resolution finds no WorkSchedule
    // row for January and silently falls back to the tenant-default FIXED_SCHEDULE (40h/8h
    // Mo-Fr) instead of this employee's real 30h/6h contract — for every day of January from
    // the hire date onward, not just the pre-hire days. month-saldo.ts (unchanged by this
    // phase) resolves via `validFrom: { lte: monthEnd } }`, which DOES find the hire row, so
    // the two diverge for exactly this month.
    const emp = await createEmployeeWithSchedules(app, data.tenant.id, "wr01", "2026-01-20", [
      { validFrom: "2026-01-20", weeklyHours: 30, dayHours: 6 },
    ]);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-05T10:00:00.000Z"));

    const liveBalance = await getBalanceHours(app, data.adminToken, emp.id);

    // Derivation (NIEDERSACHSEN 2026, no holiday Jan 20-31 or in Feb or Mar 1-4):
    //   Jan 20-31 (hire month, hireDate clips the range to 20.-31.): 9 Mo-Fr days (20,21,22,23,
    //     26,27,28,29,30) * 6h = 54h.
    //   Feb (complete, 20 Mo-Fr days) * 6h = 120h.
    //   Mar 1-4 (partial, "today" 05.03. -> window end 04.03."): Mon 02., Tue 03., Wed 04. =
    //     3 Mo-Fr days * 6h = 18h.
    //   Total Soll = 192h, Ist = 0 -> balance = -192h.
    const expectedTotal = -192;

    const janMinutes = await getMonthSaldoBalanceMinutes(app, data.adminToken, emp.id, 2026, 1);
    const febMinutes = await getMonthSaldoBalanceMinutes(app, data.adminToken, emp.id, 2026, 2);
    const marMinutes = await getMonthSaldoBalanceMinutes(app, data.adminToken, emp.id, 2026, 3);
    const monthSaldoSum = (janMinutes + febMinutes + marMinutes) / 60;

    // RED on the unchanged code: the live path's January piece falls back to the tenant default
    // (8h) for the days from the hire date onward -> Jan 9*8=72h instead of 54h, collapsing the
    // total to -(72+120+18) = -210h instead of -192h. month-saldo.ts is unaffected by the bug
    // (it already resolves via monthEnd), so `monthSaldoSum` stays correct at -192h even before
    // the fix — it is the live path that must be brought into agreement with it.
    expect(liveBalance).toBeCloseTo(expectedTotal, 2);
    expect(liveBalance).toBeCloseTo(monthSaldoSum, 2);
  });

  it("OQ1-a: contract change effective THIS month (01.02.) — the partial month alongside one complete prior month", async () => {
    const emp = await createEmployeeWithSchedules(app, data.tenant.id, "oq1a", "2026-01-01", [
      { validFrom: "2026-01-01", weeklyHours: 40, dayHours: 8 },
      { validFrom: "2026-02-01", weeklyHours: 20, dayHours: 4 },
    ]);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-10T10:00:00.000Z"));

    const liveBalance = await getBalanceHours(app, data.adminToken, emp.id);

    // Derivation: Jan (complete, row A 8h) = 21 workdays * 8h = 168h.
    //   Feb 1-9 (partial, row B 4h, "today" 10.02. → window end 09.02.): Mo-Fr days 02.-06. (5)
    //   + 09. (1) = 6 workdays * 4h = 24h. Total = 192h.
    const expectedTotal = -192;
    expect(liveBalance).toBeCloseTo(expectedTotal, 2);
  });

  it("OQ1-b: contract change dated NEXT month (01.03., not yet effective) — partial month + one complete prior month", async () => {
    const emp = await createEmployeeWithSchedules(app, data.tenant.id, "oq1b", "2026-01-01", [
      { validFrom: "2026-01-01", weeklyHours: 40, dayHours: 8 },
      { validFrom: "2026-03-01", weeklyHours: 20, dayHours: 4 },
    ]);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-10T10:00:00.000Z"));

    const liveBalance = await getBalanceHours(app, data.adminToken, emp.id);

    // Derivation: Jan (complete, row A 8h, still the only row in force) = 168h. Feb 1-9
    // (partial, row A 8h — row B is not effective until 01.03.) = 6 workdays * 8h = 48h.
    // Total = 216h.
    const expectedTotal = -216;
    expect(liveBalance).toBeCloseTo(expectedTotal, 2);
  });

  it("D-05 entry: a holiday BEFORE the hire date (Christi Himmelfahrt 14.05.) must not reduce the entry month's Soll", async () => {
    const emp = await createEmployeeWithSchedules(app, data.tenant.id, "d05entry", "2026-05-15", [
      { validFrom: "2026-05-15", weeklyHours: 40, dayHours: 8 },
    ]);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-10T10:00:00.000Z"));

    const liveBalance = await getBalanceHours(app, data.adminToken, emp.id);

    // Derivation: May 15-31 (complete, 11 Mo-Fr days: 15,18-22,25-29) minus Pfingstmontag
    // (25.05., inside the employment window) = 10 workdays * 8h = 80h. Christi Himmelfahrt
    // (14.05.) is BEFORE the hire date and must NOT be subtracted (it is not even a workday for
    // this employee). June 1-9 (partial, 7 Mo-Fr days) * 8h = 56h. Total = 136h.
    const expectedTotal = -136;
    expect(liveBalance).toBeCloseTo(expectedTotal, 2);
  });

  it("D-05 exit: a holiday AFTER the exit date (Pfingstmontag 25.05.) and one BEFORE the hire date (01.05.) must not reduce Soll — one INSIDE the window (14.05.) correctly does", async () => {
    const emp = await createEmployeeWithSchedules(
      app,
      data.tenant.id,
      "d05exit",
      "2026-05-04",
      [{ validFrom: "2026-05-04", weeklyHours: 40, dayHours: 8 }],
      "2026-05-20",
    );

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-10T10:00:00.000Z"));

    const liveBalance = await getBalanceHours(app, data.adminToken, emp.id);

    // Derivation: May 4-20 (13 Mo-Fr days: 4-8, 11-15, 18-20) minus Christi Himmelfahrt (14.05.,
    // INSIDE [04.05., 20.05.] — correctly deducted) = 12 workdays * 8h = 96h. 01.05. (Tag der
    // Arbeit, before the hire) and 25.05. (Pfingstmontag, after the exit) must NOT be subtracted.
    // The employee left before the current month even opens — no partial-month contribution.
    const expectedTotal = -96;
    expect(liveBalance).toBeCloseTo(expectedTotal, 2);
  });
});
