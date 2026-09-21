/**
 * Issue #220 — Überstundenausgleich must actually debit the Arbeitszeitkonto.
 *
 * WHAT WAS BROKEN. `closeEmployeeMonth()` did not distinguish absence KINDS: its
 * `approvedLeave` input carried no type discriminator, so an approved OVERTIME_COMP request
 * reduced the Soll exactly like Urlaub. The unworked day's minus therefore disappeared and the
 * stored balance ROSE by the day's hours, while the `OvertimeTransaction` journal row claimed it
 * fell. Measured over the real endpoints on an 8h-Monday fixture before the fix: approval moved
 * the stored balance by +8 h against a journal row of −8 h; the cancellation by −8 h against
 * +8 h. Every delta had the wrong sign.
 *
 * WHAT THE FIX DOES (model B, owner decision 2026-09-21). The Ausgleichstag stays Soll-free —
 * it is a PAID day and must not reappear as a gap — and the withdrawal is booked on top of that,
 * taken from the SAME `calcLeaveAbsenceMinutesTz()` return value that granted the credit.
 *
 * HOW THIS FILE MEASURES IT. For a day with no time entry the two summands cancel by
 * construction: crediting the Soll (+8 h) and withdrawing the compensation (−8 h) leave the
 * balance where "nothing was requested at all" would have left it, because the employee still
 * did not work those hours. That is CORRECT and it is also why an isolated before/after delta on
 * an untouched day proves nothing. The withdrawal is therefore measured DIFFERENTIALLY, against
 * an identical VACATION request on an identical employee and day: Urlaub credits the Soll and
 * withdraws nothing, Überstundenausgleich credits the same Soll and withdraws it. The gap
 * between the two balances IS the withdrawal, and it is exactly the day's scheduled hours (half
 * of them for a half day). Under the pre-fix code that gap was 0.00 h.
 *
 * Every assertion below was seen RED against the pre-fix implementation (the withdrawal summand
 * reverted in `close-employee-month.ts`), except the § 18 case, which is a non-regression guard
 * for a path the fix deliberately does not touch — see its own comment.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
} from "../../../../__tests__/setup";
import { holidayFreeMondayStr } from "../../../../__tests__/test-dates";
import { leaveTypeFields } from "../../leave-type";
import type { FastifyInstance } from "fastify";

/** Tolerance for the Decimal(…)-backed `balanceHours` round trip. */
const H = 5;

describe("Überstundenausgleich debits the Arbeitszeitkonto (issue #220)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let overtimeCompTypeId: string;
  /** Second approver — the 4-eyes rule blocks the original approver from approving the storno. */
  let secondManagerToken: string;
  let fixtureCounter = 0;

  /** A Monday in the PAST: the live recompute window ends at today/yesterday, so a future day
   *  would sit outside it and the whole measurement would read 0 on every branch. */
  const DAY = holidayFreeMondayStr(-6);

  /**
   * One fresh employee per scenario: the balance is a lifetime figure, so two scenarios sharing
   * an employee would read each other's leave rows.
   */
  async function makeEmployee(opts: { exempt?: boolean; balanceHours?: number } = {}) {
    const n = ++fixtureCounter;
    const s = `${Date.now().toString(36)}-${n}`;
    const user = await app.prisma.user.create({
      data: {
        email: `otc-${s}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    // hireDate = the 1st of the month three months before DAY — long enough to cover the day
    // under test with complete open months, short enough to keep the recompute cheap.
    const hire = new Date(DAY + "T00:00:00Z");
    hire.setUTCDate(1);
    hire.setUTCMonth(hire.getUTCMonth() - 3);
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `OTC-${s}`,
        firstName: "Test",
        lastName: `Fixture${n}`,
        hireDate: hire,
        isTimeTrackingExempt: Boolean(opts.exempt),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: hire,
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: employee.id, balanceHours: opts.balanceHours ?? 0 },
    });
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: employee.id,
        leaveTypeId: data.vacationType.id,
        year: Number(DAY.slice(0, 4)),
        totalDays: 30,
        usedDays: 0,
      },
    });
    return employee;
  }

  async function createRequest(
    employeeId: string,
    leaveTypeId: string,
    opts: { halfDay?: boolean } = {},
  ) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId,
        startDate: new Date(DAY),
        endDate: new Date(DAY),
        days: opts.halfDay ? 0.5 : 1,
        halfDay: Boolean(opts.halfDay),
        status: "PENDING",
      },
    });
  }

  async function review(id: string, token: string) {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/review`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: "APPROVED" },
    });
    return res;
  }

  async function balanceOf(employeeId: string): Promise<number> {
    const acct = await app.prisma.overtimeAccount.findUnique({ where: { employeeId } });
    return Number(acct!.balanceHours);
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "otc-saldo");

    const otc = await app.prisma.leaveType.create({
      data: { tenantId: data.tenant.id, ...leaveTypeFields("OVERTIME_COMP"), color: "#8B5CF6" },
    });
    overtimeCompTypeId = otc.id;

    // Second approver for the cancellation (4-eyes, COMP-V1814-02).
    const pw = data.adminUser.passwordHash;
    const mgrUser = await app.prisma.user.create({
      data: {
        email: `mgr2-${Date.now().toString(36)}@test.de`,
        passwordHash: pw,
        role: "MANAGER",
        isActive: true,
      },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: mgrUser.id,
        employeeNumber: `M2-${Date.now().toString(36)}`,
        firstName: "Zweiter",
        lastName: "Pruefer",
        hireDate: new Date("2024-01-01"),
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: mgrUser.email, password: "test1234" },
    });
    secondManagerToken = JSON.parse(login.body).accessToken;
    expect(secondManagerToken, "second approver must be able to log in").toBeTruthy();
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("approval of a full-day OVERTIME_COMP request leaves the balance a full day's hours BELOW the same day approved as Urlaub — that gap is the withdrawal (#220)", async () => {
    const compEmp = await makeEmployee();
    const vacEmp = await makeEmployee();

    const compReq = await createRequest(compEmp.id, overtimeCompTypeId);
    const vacReq = await createRequest(vacEmp.id, data.vacationType.id);

    expect((await review(compReq.id, data.adminToken)).statusCode).toBe(200);
    expect((await review(vacReq.id, data.adminToken)).statusCode).toBe(200);

    const compBalance = await balanceOf(compEmp.id);
    const vacBalance = await balanceOf(vacEmp.id);

    // Both employees are byte-identical fixtures on the same calendar day; the ONLY difference is
    // the leave type. Urlaub credits the Soll and withdraws nothing; Überstundenausgleich credits
    // the same Soll and withdraws it again. Pre-fix this difference was 0.
    expect(
      vacBalance - compBalance,
      "the Überstundenausgleich withdrawal: exactly the day's scheduled hours (8h)",
    ).toBeCloseTo(8, H);

    // And the journal says the same thing the balance now does.
    const acct = await app.prisma.overtimeAccount.findUnique({
      where: { employeeId: compEmp.id },
    });
    const tx = await app.prisma.overtimeTransaction.findMany({
      where: { overtimeAccountId: acct!.id },
    });
    expect(tx.map((t) => t.type)).toEqual(["REDUCTION"]);
    expect(Number(tx[0].hours), "journal row and balance effect agree in sign AND size").toBe(-8);
  });

  it("approval of a HALF-day OVERTIME_COMP request withdraws exactly HALF a day — the withdrawal tracks the credit, it is not recomputed (#220)", async () => {
    const compEmp = await makeEmployee();
    const vacEmp = await makeEmployee();

    const compReq = await createRequest(compEmp.id, overtimeCompTypeId, { halfDay: true });
    const vacReq = await createRequest(vacEmp.id, data.vacationType.id, { halfDay: true });

    expect((await review(compReq.id, data.adminToken)).statusCode).toBe(200);
    expect((await review(vacReq.id, data.adminToken)).statusCode).toBe(200);

    const compBalance = await balanceOf(compEmp.id);
    const vacBalance = await balanceOf(vacEmp.id);

    // The half-day case is where two independently-derived figures would silently drift apart.
    // They cannot here: the withdrawal IS the credit's return value, so halving one halves both.
    expect(
      vacBalance - compBalance,
      "half a day's scheduled hours (4h), not a full day",
    ).toBeCloseTo(4, H);
  });

  it("Urlaub stays free of the Arbeitszeitkonto — negative control: an approved VACATION writes no OvertimeTransaction and withdraws nothing (#220)", async () => {
    const vacEmp = await makeEmployee();
    const plainEmp = await makeEmployee(); // nothing requested at all

    const vacReq = await createRequest(vacEmp.id, data.vacationType.id);
    expect((await review(vacReq.id, data.adminToken)).statusCode).toBe(200);

    // Force the untouched employee's balance to be computed from the same inputs.
    const { computeOvertimeBalanceHours } = await import("../../../working-time-account");
    const plainBalance = await computeOvertimeBalanceHours(app, plainEmp.id);
    const vacBalance = await balanceOf(vacEmp.id);

    expect(
      vacBalance - plainBalance!,
      "Urlaub removes the day's Soll and nothing else — the balance RISES by the day's hours",
    ).toBeCloseTo(8, H);

    const acct = await app.prisma.overtimeAccount.findUnique({ where: { employeeId: vacEmp.id } });
    const txCount = await app.prisma.overtimeTransaction.count({
      where: { overtimeAccountId: acct!.id },
    });
    expect(txCount, "VACATION never touches the Überstundenkonto").toBe(0);
  });

  it("cancelling the compensation WITHOUT working the day: the withdrawal is taken back, but the unworked day's own minus stays — the balance does not move (#220)", async () => {
    const emp = await makeEmployee();
    const req = await createRequest(emp.id, overtimeCompTypeId);
    expect((await review(req.id, data.adminToken)).statusCode).toBe(200);
    const afterApproval = await balanceOf(emp.id);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/leave/requests/${req.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { reason: "Ausgleich nicht mehr gewuenscht" },
    });
    expect(del.statusCode).toBe(200);
    expect(JSON.parse(del.body).status).toBe("CANCELLATION_REQUESTED");

    const res = await review(req.id, secondManagerToken);
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).status).toBe("CANCELLED");

    const afterCancel = await balanceOf(emp.id);

    // Two opposite movements of the same size: the day's Soll comes back (−8h, the employee owes
    // those hours again because nobody worked them) and the withdrawal is released (+8h).
    // Pre-fix this delta was −8h: there had never been a withdrawal to release.
    expect(
      afterCancel - afterApproval,
      "Soll returns and withdrawal is released — net zero while the day stays unworked",
    ).toBeCloseTo(0, H);

    const acct = await app.prisma.overtimeAccount.findUnique({ where: { employeeId: emp.id } });
    const tx = await app.prisma.overtimeTransaction.findMany({
      where: { overtimeAccountId: acct!.id },
      orderBy: { createdAt: "asc" },
    });
    expect(tx.map((t) => t.type)).toEqual(["REDUCTION", "CORRECTION"]);
    expect(Number(tx[1].hours)).toBe(8);
  });

  it("cancelling the compensation AFTER working the day: the balance rises by the full day's hours — the withdrawal is released and the day is now worked (#220)", async () => {
    const emp = await makeEmployee();
    const req = await createRequest(emp.id, overtimeCompTypeId);
    expect((await review(req.id, data.adminToken)).statusCode).toBe(200);
    const afterApproval = await balanceOf(emp.id);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/leave/requests/${req.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { reason: "Doch gearbeitet an dem Tag" },
    });
    expect(del.statusCode).toBe(200);

    // CLAUDE.md § ArbZG "CANCELLATION_REQUESTED leave": a time entry during a pending
    // cancellation is allowed but created invalid, and is revalidated when the cancellation is
    // approved. Same fixture shape as leave-characterization.test.ts.
    const entry = await app.prisma.timeEntry.create({
      data: {
        employeeId: emp.id,
        date: new Date(DAY),
        startTime: new Date(`${DAY}T07:00:00Z`),
        endTime: new Date(`${DAY}T15:00:00Z`),
        isInvalid: true,
        invalidReasonCode: "LEAVE_CANCELLATION_PENDING",
        invalidReason: "Urlaubsstornierung ausstehend",
      },
    });

    const res = await review(req.id, secondManagerToken);
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).status).toBe("CANCELLED");

    const reloaded = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
    expect(reloaded?.isInvalid, "the entry is revalidated by the cancellation approval").toBe(
      false,
    );

    const afterCancel = await balanceOf(emp.id);

    // The withdrawal is released (+8h) and the day's returning Soll (−8h) is now covered by 8h of
    // actual work (+8h). Pre-fix the delta was 0: there was no withdrawal to release.
    expect(
      afterCancel - afterApproval,
      "the originally withdrawn hours are genuinely back on the account",
    ).toBeCloseTo(8, H);
  });

  it("SHIFT_BASED CHARACTERIZATION (pre-existing, NOT fixed here): the journal row is the ROSTER netto while the saldo withdrawal is the Ø-Methode day — the two disagree (#220 follow-up, issue #293)", async () => {
    // Two different answers to "how long is this day?" meet here, and neither is wrong on its
    // own terms:
    //   - the OvertimeTransaction amount comes from getScheduledHours() (leave.ts), which for
    //     SHIFT_BASED sums the ROSTER (Shift netto, Phase 100 / OTC-04);
    //   - the saldo withdrawal comes from calcLeaveAbsenceMinutesTz(), the Ø-Methode
    //     (weeklyHours / contracted workdays, BAG 9 AZR 406/17) — the same figure that granted
    //     the day's Soll credit, which is exactly what #220 requires it to be.
    // For an under-rostered day the journal therefore books less than the account loses.
    // This is the pre-existing two-Soll-concepts question, not a regression introduced by #220's
    // fix, and it is filed separately as issue #293. Pinned here so the size of the gap is a
    // measured number rather than an argument.
    const n = ++fixtureCounter;
    const s = `${Date.now().toString(36)}-sb${n}`;
    const user = await app.prisma.user.create({
      data: { email: `otc-sb-${s}@test.de`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
    });
    const hire = new Date(DAY + "T00:00:00Z");
    hire.setUTCDate(1);
    hire.setUTCMonth(hire.getUTCMonth() - 3);
    const emp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `OTC-${s}`,
        firstName: "Test",
        lastName: `ShiftFixture${n}`,
        hireDate: hire,
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        type: "SHIFT_BASED",
        weeklyHours: 40, // Ø-Methode: 40h / 5 contracted workdays = 8.00 h per day
        contractWorkDaysPerWeek: 5,
        workDays: [1, 2, 3, 4, 5],
        validFrom: hire,
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: emp.id, balanceHours: 0 },
    });
    // Roster the day SHORT: 07:00-13:00 is 6h brutto and, being not MORE than 6h, carries no
    // mandatory break (§ 4 ArbZG) — netto 6.00 h against an Ø-Methode day of 8.00 h.
    await app.prisma.shift.create({
      data: { employeeId: emp.id, date: new Date(DAY), startTime: "07:00", endTime: "13:00" },
    });

    const req = await createRequest(emp.id, overtimeCompTypeId);
    expect((await review(req.id, data.adminToken)).statusCode).toBe(200);

    const acct = await app.prisma.overtimeAccount.findUnique({ where: { employeeId: emp.id } });
    const tx = await app.prisma.overtimeTransaction.findMany({
      where: { overtimeAccountId: acct!.id },
    });
    expect(tx).toHaveLength(1);
    expect(
      Number(tx[0].hours),
      "journal amount = roster netto (getScheduledHours, SHIFT_BASED branch)",
    ).toBeCloseTo(-6, H);

    // The saldo side, measured the same differential way as the FIXED_SCHEDULE cases above.
    const vacEmp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: (
          await app.prisma.user.create({
            data: {
              email: `otc-sbv-${s}@test.de`,
              passwordHash: "x",
              role: "EMPLOYEE",
              isActive: true,
            },
          })
        ).id,
        employeeNumber: `OTC-V-${s}`,
        firstName: "Test",
        lastName: `ShiftControl${n}`,
        hireDate: hire,
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: vacEmp.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        contractWorkDaysPerWeek: 5,
        workDays: [1, 2, 3, 4, 5],
        validFrom: hire,
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: vacEmp.id, balanceHours: 0 },
    });
    await app.prisma.shift.create({
      data: { employeeId: vacEmp.id, date: new Date(DAY), startTime: "07:00", endTime: "13:00" },
    });
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: vacEmp.id,
        leaveTypeId: data.vacationType.id,
        year: Number(DAY.slice(0, 4)),
        totalDays: 30,
        usedDays: 0,
      },
    });
    const vacReq = await createRequest(vacEmp.id, data.vacationType.id);
    expect((await review(vacReq.id, data.adminToken)).statusCode).toBe(200);

    const withdrawal = (await balanceOf(vacEmp.id)) - (await balanceOf(emp.id));
    expect(
      withdrawal,
      "saldo withdrawal = Ø-Methode day (8.00h), NOT the 6.00h the journal row booked",
    ).toBeCloseTo(8, H);
    expect(
      withdrawal - Math.abs(Number(tx[0].hours)),
      "MEASURED DIVERGENCE between journal amount and saldo effect for SHIFT_BASED: 2.00 h",
    ).toBeCloseTo(2, H);
  });

  it("§ 18-exempt employees: the manual booking stays the only writer and still works — the recompute never touches their balance (#220)", async () => {
    // NON-REGRESSION GUARD, not a change detector: for an exempt employee
    // computeOvertimeBalanceBreakdown() returns null and updateOvertimeAccount() leaves the
    // stored value alone, so this path is identical before and after the fix and cannot be seen
    // red against the pre-fix code. It is here because model B's correctness argument rests on
    // the manual bookings remaining intact for exactly these employees.
    const emp = await makeEmployee({ exempt: true, balanceHours: 20 });
    const req = await createRequest(emp.id, overtimeCompTypeId);

    expect((await review(req.id, data.adminToken)).statusCode).toBe(200);
    expect(
      await balanceOf(emp.id),
      "the manual REDUCTION survives: 20h − 8h, not an Ist-Soll recompute",
    ).toBeCloseTo(12, H);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/leave/requests/${req.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { reason: "Ausgleich zurueckgenommen" },
    });
    expect(del.statusCode).toBe(200);

    const res = await review(req.id, secondManagerToken);
    expect(res.statusCode, res.body).toBe(200);

    expect(await balanceOf(emp.id), "the manual CORRECTION restores the original 20h").toBeCloseTo(
      20,
      H,
    );
  });
});
