/**
 * Issue #615 — `PATCH /api/v1/employees/:id/deactivate` takes the last working day.
 *
 * The day is a tenant-local calendar day (D-01), never in the future (D-02), never in or before a
 * closed month (D-03/D-16) and never before the hire day (D-22). A deactivation applies the #614
 * employment-exit rule as its second caller with its own marker (D-04), recomputes the exit-year
 * entitlement (D-05) and audits the previous and the new exit day (D-06).
 *
 * Every date is computed relative to the tenant-local today, so the file passes on any day of the
 * year.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { fromZonedTime } from "date-fns-tz";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  seedTestData,
  cleanupTestData,
  seedEntitlementYears,
  grantSystemRole,
  auditRowsFor,
  soleAuditRow,
  numericEmployeeNumber,
  reissueTokenNow,
} from "./setup";
import { getTenantTimezone, monthRangeUtc, todayInTz } from "../contexts/working-time-account";
import { getHolidayMap } from "../contexts/absence/leave-days";

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const utcMidnight = (iso: string) => new Date(`${iso}T00:00:00Z`);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
/** First date on or after `from` whose UTC weekday is `weekday` (0 = Sunday). */
const onOrAfter = (from: Date, weekday: number) =>
  addDays(from, (weekday - from.getUTCDay() + 7) % 7);

describe("Issue #615 — deactivation takes the last working day", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let today: Date;
  let firstOfLastMonth: Date;

  const auth = () => ({ authorization: `Bearer ${data.adminToken}` });

  /** Employee with a fixed contract, a login and entitlement rows for every year touched. */
  async function createWorker(label: string, opts: { hireDate?: Date } = {}) {
    const suffix = crypto.randomUUID().slice(0, 8);
    const user = await app.prisma.user.create({
      data: {
        email: `${label}-${suffix}@example.invalid`,
        passwordHash: await bcrypt.hash("test1234", 10),
        isActive: true,
      },
    });
    const hireDate = opts.hireDate ?? firstOfLastMonth;
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        firstName: "Exit615",
        lastName: "Fixture",
        employeeNumber: numericEmployeeNumber(),
        hireDate,
      },
    });
    await grantSystemRole(app.prisma, {
      tenantId: data.tenant.id,
      userId: user.id,
      role: "EMPLOYEE",
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
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
        validFrom: hireDate,
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    await seedEntitlementYears(app, {
      employeeId: employee.id,
      leaveTypeId: data.vacationType.id,
      years: [today.getUTCFullYear() - 1, today.getUTCFullYear(), today.getUTCFullYear() + 1],
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: user.email, password: "test1234" },
    });
    expect(login.statusCode).toBe(200);
    return { user, employee, token: JSON.parse(login.body).accessToken as string };
  }

  /** Creates a VACATION request as the employee and approves it as the admin (the booking ran). */
  async function approvedVacation(who: { token: string }, start: Date, end: Date) {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${who.token}` },
      payload: {
        type: "VACATION",
        startDate: isoDay(start),
        endDate: isoDay(end),
        note: "Notiz-Zebra-615",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = JSON.parse(created.body).id as string;
    const reviewed = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/review`,
      headers: auth(),
      payload: { status: "APPROVED" },
    });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    return app.prisma.leaveRequest.findUniqueOrThrow({ where: { id } });
  }

  const usedDays = async (employeeId: string, year: number) =>
    Number(
      (
        await app.prisma.leaveEntitlement.findFirstOrThrow({
          where: { employeeId, year, leaveType: { code: "VACATION" } },
          select: { usedDays: true },
        })
      ).usedDays,
    );

  const deactivate = (employeeId: string, payload?: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${employeeId}/deactivate`,
      headers: auth(),
      ...(payload === undefined ? {} : { payload }),
    });

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "deactivate-exit-615");
    const tz = await getTenantTimezone(app.prisma, data.tenant.id);
    expect(tz).toBe("Europe/Berlin");
    today = todayInTz(tz);
    firstOfLastMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("deactivate-exit-day-615 test cleanup failed:", err);
    }
  });

  // ── Tracer ───────────────────────────────────────────────────────────────────────────────────
  describe("tracer: the exit rule ends what lies after the last working day", () => {
    it("stores the day as UTC midnight, cancels the later vacation with its reversal, audits the old and the new exit day", async () => {
      const worker = await createWorker("tracer");
      const start = onOrAfter(addDays(today, 8), 1); // a Monday, wholly after today
      const vacation = await approvedVacation(worker, start, addDays(start, 2));
      expect(vacation.status).toBe("APPROVED");
      const vacationYear = vacation.startDate.getUTCFullYear();
      const usedBefore = await usedDays(worker.employee.id, vacationYear);
      expect(usedBefore).toBeGreaterThanOrEqual(Number(vacation.days));

      const res = await deactivate(worker.employee.id, { exitDate: isoDay(today) });
      expect(res.statusCode, res.body).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ success: true });

      const employee = await app.prisma.employee.findUniqueOrThrow({
        where: { id: worker.employee.id },
        include: { user: true },
      });
      expect(employee.exitDate!.toISOString()).toBe(`${isoDay(today)}T00:00:00.000Z`);
      expect(employee.user.isActive).toBe(false);

      const after = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: vacation.id } });
      expect(after.status).toBe("CANCELLED");
      expect(await usedDays(worker.employee.id, vacationYear)).toBe(
        usedBefore - Number(vacation.days),
      );

      const cancel = await soleAuditRow(app.prisma, {
        where: { entity: "LeaveRequest", entityId: vacation.id, action: "CANCEL" },
      });
      const cancelValue = cancel.newValue as Record<string, unknown>;
      expect(cancelValue.status).toBe("CANCELLED");
      expect(cancelValue.trigger).toBe("DEACTIVATION");
      expect(cancelValue.auditReason).toBe("Deaktivierung");
      expect(cancelValue.exitDate).toBe(isoDay(today));
      const serialized = JSON.stringify(cancel.oldValue) + JSON.stringify(cancel.newValue);
      for (const secret of ["Notiz-Zebra-615", "Exit615", "Fixture", worker.user.email]) {
        expect(serialized).not.toContain(secret);
      }

      const update = await soleAuditRow(app.prisma, {
        where: { entity: "Employee", entityId: worker.employee.id, action: "UPDATE" },
      });
      expect(update.oldValue).toEqual({ isActive: true, exitDate: null });
      expect(update.newValue).toEqual({
        isActive: false,
        exitDate: isoDay(today),
        absencesEnded: { cancelled: 1, shortened: 0, deleted: 0 },
        exitSkipped: [],
      });
    });

    it("refuses a last working day in a closed month with 409 MONTH_LOCKED and accepts today afterwards", async () => {
      const worker = await createWorker("closed");
      const closed = await app.inject({
        method: "POST",
        url: "/api/v1/overtime/close-month",
        headers: auth(),
        payload: {
          employeeId: worker.employee.id,
          year: firstOfLastMonth.getUTCFullYear(),
          month: firstOfLastMonth.getUTCMonth() + 1,
          confirmGaps: true,
        },
      });
      expect(closed.statusCode, closed.body).toBe(201);

      let weekday = firstOfLastMonth;
      while (weekday.getUTCDay() === 0 || weekday.getUTCDay() === 6) weekday = addDays(weekday, 1);

      const refused = await deactivate(worker.employee.id, { exitDate: isoDay(weekday) });
      expect(refused.statusCode, refused.body).toBe(409);
      const body = JSON.parse(refused.body) as { error: string; code: string };
      expect(body.code).toBe("MONTH_LOCKED");
      expect(body.error.length).toBeGreaterThan(10);

      const stillActive = await app.prisma.employee.findUniqueOrThrow({
        where: { id: worker.employee.id },
        include: { user: true },
      });
      expect(stillActive.user.isActive).toBe(true);
      expect(stillActive.exitDate).toBeNull();

      const ok = await deactivate(worker.employee.id, { exitDate: isoDay(today) });
      expect(ok.statusCode, ok.body).toBe(200);
    });
  });

  type Worker = Awaited<ReturnType<typeof createWorker>>;

  /** Plain-JSON copy so Decimal / Date compare by value. */
  const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  /**
   * Everything a deactivation could touch for one person: the login state, the employee row, every
   * leave request, absence and entitlement row, the unrevoked refresh tokens and the audit rows that
   * concern the person (employee, leave requests, entitlements).
   */
  async function writeSnapshot(who: Worker) {
    const employeeId = who.employee.id;
    const leave = await app.prisma.leaveRequest.findMany({
      where: { employeeId },
      orderBy: [{ id: "asc" }],
    });
    const entitlements = await app.prisma.leaveEntitlement.findMany({
      where: { employeeId },
      orderBy: [{ year: "asc" }, { id: "asc" }],
    });
    return plain({
      user: await app.prisma.user.findUniqueOrThrow({ where: { id: who.user.id } }),
      employee: await app.prisma.employee.findUniqueOrThrow({ where: { id: employeeId } }),
      leave,
      absences: await app.prisma.absence.findMany({
        where: { employeeId },
        orderBy: [{ id: "asc" }],
      }),
      entitlements,
      unrevokedTokens: await app.prisma.refreshToken.count({
        where: { userId: who.user.id, revokedAt: null },
      }),
      audits: await app.prisma.auditLog.count({
        where: {
          entityId: {
            in: [employeeId, ...leave.map((l) => l.id), ...entitlements.map((e) => e.id)],
          },
        },
      }),
    });
  }

  /** A worker with an approved vacation wholly after today, so a wrongly written exit is visible. */
  async function workerWithVacation(label: string, opts: { hireDate?: Date } = {}) {
    const worker = await createWorker(label, opts);
    const start = onOrAfter(addDays(today, 8), 1);
    await approvedVacation(worker, start, addDays(start, 2));
    return worker;
  }

  /** The first Monday-Friday day on or after `from`. */
  const firstWeekday = (from: Date) => {
    let day = from;
    while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day = addDays(day, 1);
    return day;
  };

  /** Writes a closed MONTHLY snapshot for the month of `monthStart` the way the closer does. */
  async function closeMonthDirectly(who: Worker, monthStart: Date) {
    const range = monthRangeUtc(
      monthStart.getUTCFullYear(),
      monthStart.getUTCMonth() + 1,
      "Europe/Berlin",
    );
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: who.employee.id,
        periodType: "MONTHLY",
        periodStart: range.start,
        periodEnd: range.end,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
        closedBy: "test-system",
      },
    });
  }

  // ── Refusals write nothing ───────────────────────────────────────────────────────────────────
  describe("refusals write nothing", () => {
    async function expectRefusedWithoutWrite(
      who: Worker,
      payload: Record<string, unknown>,
      status: number,
      code?: string,
    ) {
      const before = await writeSnapshot(who);
      expect(before.unrevokedTokens).toBeGreaterThan(0);
      expect(before.leave).toHaveLength(1);
      const res = await deactivate(who.employee.id, payload);
      expect(res.statusCode, res.body).toBe(status);
      const body = JSON.parse(res.body) as { error: string; code?: string };
      if (code) {
        expect(body.code).toBe(code);
        expect(body.error.length).toBeGreaterThan(10);
      }
      expect(await writeSnapshot(who)).toEqual(before);
    }

    it("a day after the tenant-local today is a 400 EXIT_DATE_IN_FUTURE (D-02)", async () => {
      const worker = await workerWithVacation("future");
      await expectRefusedWithoutWrite(
        worker,
        { exitDate: isoDay(addDays(today, 1)) },
        400,
        "EXIT_DATE_IN_FUTURE",
      );
    });

    it("a day before the tenant-local hire day is a 400 EXIT_DATE_BEFORE_HIRE; the hire day itself is accepted (D-22)", async () => {
      const hireDay = addDays(today, -10);
      const worker = await workerWithVacation("before-hire", {
        hireDate: utcMidnight(isoDay(hireDay)),
      });
      await expectRefusedWithoutWrite(
        worker,
        { exitDate: isoDay(addDays(hireDay, -1)) },
        400,
        "EXIT_DATE_BEFORE_HIRE",
      );
      const ok = await deactivate(worker.employee.id, { exitDate: isoDay(hireDay) });
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it("a day in a closed month is a 409 MONTH_LOCKED (D-03)", async () => {
      const worker = await workerWithVacation("locked");
      const closed = await app.inject({
        method: "POST",
        url: "/api/v1/overtime/close-month",
        headers: auth(),
        payload: {
          employeeId: worker.employee.id,
          year: firstOfLastMonth.getUTCFullYear(),
          month: firstOfLastMonth.getUTCMonth() + 1,
          confirmGaps: true,
        },
      });
      expect(closed.statusCode, closed.body).toBe(201);
      await expectRefusedWithoutWrite(
        worker,
        { exitDate: isoDay(firstWeekday(firstOfLastMonth)) },
        409,
        "MONTH_LOCKED",
      );
    });

    it("moving a STORED exit day out of a closed month is a 409 MONTH_LOCKED, although today's month is open (review CR-01)", async () => {
      const worker = await workerWithVacation("stored-locked");
      const storedDay = firstWeekday(firstOfLastMonth);
      await app.prisma.employee.update({
        where: { id: worker.employee.id },
        data: { exitDate: utcMidnight(isoDay(storedDay)) },
      });
      await closeMonthDirectly(worker, firstOfLastMonth);
      // No body = today: the old guard looked at the current month only and let this move through.
      await expectRefusedWithoutWrite(worker, {}, 409, "MONTH_LOCKED");
      await expectRefusedWithoutWrite(worker, { exitDate: isoDay(today) }, 409, "MONTH_LOCKED");
    });

    it("a day in an OPEN month before a LATER closed month is a 409 MONTH_LOCKED (D-16)", async () => {
      // Two months back, so last month can be closed while the month before it stays open. Across a
      // year boundary the API cannot reach this state (the close is sequential per year), so the
      // closed month is written the way the closer writes it: the converted month start.
      const monthBeforeLast = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 2, 1),
      );
      const worker = await workerWithVacation("later-locked", { hireDate: monthBeforeLast });
      const range = monthRangeUtc(
        firstOfLastMonth.getUTCFullYear(),
        firstOfLastMonth.getUTCMonth() + 1,
        "Europe/Berlin",
      );
      await app.prisma.saldoSnapshot.create({
        data: {
          employeeId: worker.employee.id,
          periodType: "MONTHLY",
          periodStart: range.start,
          periodEnd: range.end,
          workedMinutes: 0,
          expectedMinutes: 0,
          balanceMinutes: 0,
          carryOver: 0,
          closedAt: new Date(),
          closedBy: "test-system",
        },
      });
      await expectRefusedWithoutWrite(
        worker,
        { exitDate: isoDay(firstWeekday(monthBeforeLast)) },
        409,
        "MONTH_LOCKED",
      );
    });

    it("an impossible or foreign date format is a validation 400 (D-19)", async () => {
      const worker = await workerWithVacation("format");
      await expectRefusedWithoutWrite(worker, { exitDate: "31.12.2026" }, 400);
      await expectRefusedWithoutWrite(worker, { exitDate: "2026-02-30" }, 400);
    });
  });

  // ── Accepted days and formats ────────────────────────────────────────────────────────────────
  describe("accepted days and formats", () => {
    it("a past day in an open month is stored as that day's UTC midnight", async () => {
      const worker = await createWorker("yesterday");
      const yesterday = addDays(today, -1);
      const res = await deactivate(worker.employee.id, { exitDate: isoDay(yesterday) });
      expect(res.statusCode, res.body).toBe(200);
      const stored = await app.prisma.employee.findUniqueOrThrow({
        where: { id: worker.employee.id },
      });
      expect(stored.exitDate!.toISOString()).toBe(`${isoDay(yesterday)}T00:00:00.000Z`);
    });

    it("choosing the STORED exit day in a closed month moves nothing and is accepted; the exit day stays (review CR-01)", async () => {
      const worker = await workerWithVacation("stored-same");
      const storedDay = firstWeekday(firstOfLastMonth);
      await app.prisma.employee.update({
        where: { id: worker.employee.id },
        data: { exitDate: utcMidnight(isoDay(storedDay)) },
      });
      await closeMonthDirectly(worker, firstOfLastMonth);

      const res = await deactivate(worker.employee.id, { exitDate: isoDay(storedDay) });
      expect(res.statusCode, res.body).toBe(200);
      const stored = await app.prisma.employee.findUniqueOrThrow({
        where: { id: worker.employee.id },
        include: { user: true },
      });
      expect(stored.exitDate!.toISOString()).toBe(`${isoDay(storedDay)}T00:00:00.000Z`);
      expect(stored.user.isActive).toBe(false);
      const update = await soleAuditRow(app.prisma, {
        where: { entity: "Employee", entityId: worker.employee.id, action: "UPDATE" },
      });
      expect((update.oldValue as { exitDate: string }).exitDate).toBe(isoDay(storedDay));
      expect((update.newValue as { exitDate: string }).exitDate).toBe(isoDay(storedDay));
    });

    it("an ISO datetime is reduced to its tenant-local calendar day (D-19)", async () => {
      const worker = await createWorker("datetime");
      const yesterday = addDays(today, -1);
      const res = await deactivate(worker.employee.id, {
        exitDate: `${isoDay(yesterday)}T00:00:00.000Z`,
      });
      expect(res.statusCode, res.body).toBe(200);
      const stored = await app.prisma.employee.findUniqueOrThrow({
        where: { id: worker.employee.id },
      });
      expect(stored.exitDate!.toISOString()).toBe(`${isoDay(yesterday)}T00:00:00.000Z`);
    });
  });

  // ── A person who has not started yet (review CR-02) ──────────────────────────────────────────
  describe("a person whose hire day lies after today", () => {
    it("is deactivated as a login-only action: login off, tokens revoked, exit day and exit rule untouched, audit says so", async () => {
      const worker = await createWorker("not-hired", {
        hireDate: utcMidnight(isoDay(addDays(today, 10))),
      });
      const vacationDay = onOrAfter(addDays(today, 14), 1);
      const lateRequest = await app.prisma.leaveRequest.create({
        data: {
          employeeId: worker.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: vacationDay,
          endDate: vacationDay,
          days: 1,
          status: "APPROVED",
        },
      });
      const before = await writeSnapshot(worker);
      expect(before.unrevokedTokens).toBeGreaterThan(0);

      // A date in the body does not matter: there is no admissible last working day for this person.
      const res = await deactivate(worker.employee.id, { exitDate: isoDay(today) });
      expect(res.statusCode, res.body).toBe(200);

      const after = await app.prisma.employee.findUniqueOrThrow({
        where: { id: worker.employee.id },
        include: { user: true },
      });
      expect(after.user.isActive).toBe(false);
      expect(after.exitDate).toBeNull();
      expect(
        await app.prisma.refreshToken.count({ where: { userId: worker.user.id, revokedAt: null } }),
      ).toBe(0);
      // The exit rule did not run: the later request is untouched.
      const request = await app.prisma.leaveRequest.findUniqueOrThrow({
        where: { id: lateRequest.id },
      });
      expect(request.status).toBe("APPROVED");
      const update = await soleAuditRow(app.prisma, {
        where: { entity: "Employee", entityId: worker.employee.id, action: "UPDATE" },
      });
      expect(update.oldValue).toEqual({ isActive: true, exitDate: null });
      expect(update.newValue).toEqual({
        isActive: false,
        exitDate: null,
        exitDateUnchanged: "HIRE_IN_FUTURE",
      });
      expect(await app.prisma.auditLog.count({ where: { entityId: lateRequest.id } })).toBe(0);

      // No body works the same way, and a second call is the usual 409.
      const again = await deactivate(worker.employee.id);
      expect(again.statusCode).toBe(409);
    });
  });

  // ── Concurrency (review WR-01) ───────────────────────────────────────────────────────────────
  describe("the checks and the audit old value are read under the Employee row lock", () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    /**
     * Holds the Employee row lock in a transaction of its own, starts the deactivation (it passes its
     * pre-checks and then waits for the lock), lets the holder write `during` and commit, and returns
     * the deactivation's answer.
     */
    async function deactivateBehindLock(
      who: Worker,
      payload: Record<string, unknown>,
      during: (tx: Parameters<Parameters<typeof app.prisma.$transaction>[0]>[0]) => Promise<void>,
    ) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockedPromise = new Promise<void>((resolve) => (locked = resolve));
      const holder = app.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${who.employee.id} FOR UPDATE`;
          locked();
          await gate;
          await during(tx);
        },
        { timeout: 30_000 },
      );
      await lockedPromise;
      const racing = deactivate(who.employee.id, payload);
      await sleep(600); // long enough for the request to reach the lock
      release();
      await holder;
      return racing;
    }

    it("a deactivation that lost the race answers 409 and overwrites nothing", async () => {
      const worker = await createWorker("race-loser");
      const winnerDay = addDays(today, -1);
      const res = await deactivateBehindLock(worker, { exitDate: isoDay(today) }, async (tx) => {
        await tx.user.update({ where: { id: worker.user.id }, data: { isActive: false } });
        await tx.employee.update({
          where: { id: worker.employee.id },
          data: { exitDate: utcMidnight(isoDay(winnerDay)) },
        });
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: "Mitarbeiter ist bereits deaktiviert" });
      const stored = await app.prisma.employee.findUniqueOrThrow({
        where: { id: worker.employee.id },
      });
      expect(stored.exitDate!.toISOString()).toBe(`${isoDay(winnerDay)}T00:00:00.000Z`);
      expect(
        await app.prisma.auditLog.count({
          where: { entity: "Employee", entityId: worker.employee.id, action: "UPDATE" },
        }),
      ).toBe(0);
    });

    it("two concurrent deactivations with different days: one 200, one 409, one audit row with the right old value", async () => {
      const worker = await createWorker("race-pair");
      const [a, b] = await Promise.all([
        deactivate(worker.employee.id, { exitDate: isoDay(today) }),
        deactivate(worker.employee.id, { exitDate: isoDay(addDays(today, -1)) }),
      ]);
      expect([a.statusCode, b.statusCode].sort((x, y) => x - y)).toEqual([200, 409]);
      const winner = a.statusCode === 200 ? isoDay(today) : isoDay(addDays(today, -1));
      const stored = await app.prisma.employee.findUniqueOrThrow({
        where: { id: worker.employee.id },
      });
      expect(isoDay(stored.exitDate!)).toBe(winner);
      const update = await soleAuditRow(app.prisma, {
        where: { entity: "Employee", entityId: worker.employee.id, action: "UPDATE" },
      });
      expect(update.oldValue).toEqual({ isActive: true, exitDate: null });
      expect((update.newValue as { exitDate: string }).exitDate).toBe(winner);
    });

    it("an exit day stored while the deactivation waited is the audit old value, not the stale read", async () => {
      const worker = await createWorker("race-old-value");
      const stored = addDays(today, -3);
      const res = await deactivateBehindLock(worker, { exitDate: isoDay(today) }, async (tx) => {
        await tx.employee.update({
          where: { id: worker.employee.id },
          data: { exitDate: utcMidnight(isoDay(stored)) },
        });
      });
      expect(res.statusCode, res.body).toBe(200);
      const update = await soleAuditRow(app.prisma, {
        where: { entity: "Employee", entityId: worker.employee.id, action: "UPDATE" },
      });
      expect(update.oldValue).toEqual({ isActive: true, exitDate: isoDay(stored) });
      expect((update.newValue as { exitDate: string }).exitDate).toBe(isoDay(today));
    });
  });

  // ── The stored overtime balance follows every deactivation (review WR-02) ─────────────────────
  describe("the persisted overtime balance", () => {
    it("is refreshed after a backdated deactivation even when no absence changed", async () => {
      const worker = await createWorker("balance", {
        hireDate: utcMidnight(isoDay(addDays(today, -14))),
      });
      await app.prisma.overtimeAccount.update({
        where: { employeeId: worker.employee.id },
        data: { balanceHours: 999 },
      });
      const res = await deactivate(worker.employee.id, { exitDate: isoDay(addDays(today, -10)) });
      expect(res.statusCode, res.body).toBe(200);
      // No absence exists, so the exit rule changes nothing and only the balance refresh can run.
      const stored = await app.prisma.overtimeAccount.findUniqueOrThrow({
        where: { employeeId: worker.employee.id },
      });
      expect(Number(stored.balanceHours)).not.toBe(999);
      const got = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${worker.employee.id}`,
        headers: auth(),
      });
      expect(got.statusCode, got.body).toBe(200);
      const live = (JSON.parse(got.body) as { balanceHours: number }).balanceHours;
      expect(Number(stored.balanceHours)).toBeCloseTo(live, 1);
    });
  });

  // ── Europe/Berlin day boundary (AC-615-3) ────────────────────────────────────────────────────
  describe("the default and the bounds follow the tenant-local day, not the UTC day", () => {
    it("at 00:30 Europe/Berlin (the UTC day is still the previous one) no body stores the Berlin day, that day is accepted and the next one refused", async () => {
      const noBody = await createWorker("berlin-default");
      const sameDay = await createWorker("berlin-same");
      const nextDay = await createWorker("berlin-next");
      const instant = fromZonedTime(`${isoDay(today)}T00:30:00`, "Europe/Berlin");
      // Anchor: at this instant the UTC calendar day is the day BEFORE the Berlin day.
      expect(isoDay(instant)).toBe(isoDay(addDays(today, -1)));

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(instant);
      try {
        const headers = { authorization: `Bearer ${reissueTokenNow(app, data.adminToken)}` };
        const patch = (id: string, payload?: Record<string, unknown>) =>
          app.inject({
            method: "PATCH",
            url: `/api/v1/employees/${id}/deactivate`,
            headers,
            ...(payload === undefined ? {} : { payload }),
          });

        const a = await patch(noBody.employee.id);
        expect(a.statusCode, a.body).toBe(200);
        const storedA = await app.prisma.employee.findUniqueOrThrow({
          where: { id: noBody.employee.id },
        });
        // A UTC implementation would store the previous day here.
        expect(storedA.exitDate!.toISOString()).toBe(`${isoDay(today)}T00:00:00.000Z`);

        const b = await patch(sameDay.employee.id, { exitDate: isoDay(today) });
        expect(b.statusCode, b.body).toBe(200);

        const c = await patch(nextDay.employee.id, { exitDate: isoDay(addDays(today, 1)) });
        expect(c.statusCode, c.body).toBe(400);
        expect(JSON.parse(c.body).code).toBe("EXIT_DATE_IN_FUTURE");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── The whole exit rule with its own marker (AC-615-4) ───────────────────────────────────────
  describe("the employment-exit rule with the marker DEACTIVATION", () => {
    it("shortens the spanning vacation, cancels the later pending one, deletes the later Berufsschule row, reports the spanning absence, writes no free text", async () => {
      const NOTE = "Notiz-Zebra-615";
      const worker = await createWorker("rule", {
        hireDate: utcMidnight(`${today.getUTCFullYear() - 2}-01-01`),
      });
      // X: the most recent weekday that is no public holiday (a weekend or holiday exit day would
      // re-price the spanning vacation to 0 days, which is the cancel path of #614, not a shortening).
      let exit = today;
      for (let i = 0; i < 14; i++) {
        const holidays = await getHolidayMap(
          app.prisma,
          data.tenant.id,
          worker.employee.id,
          exit,
          exit,
        );
        if (exit.getUTCDay() >= 1 && exit.getUTCDay() <= 5 && holidays.size === 0) break;
        exit = addDays(exit, -1);
      }
      // Bookings are not part of this case: lift usedDays so a reversal can never run negative.
      await app.prisma.leaveEntitlement.updateMany({
        where: { employeeId: worker.employee.id },
        data: { usedDays: 20 },
      });

      // The past is not creatable through the API: the spanning vacation is written directly.
      const spanning = await app.prisma.leaveRequest.create({
        data: {
          employeeId: worker.employee.id,
          leaveTypeId: data.vacationType.id,
          startDate: exit,
          endDate: addDays(exit, 6),
          days: 5,
          status: "APPROVED",
          reviewedBy: "system",
          reviewedAt: new Date(),
          note: NOTE,
        },
      });
      const pendingStart = onOrAfter(addDays(today, 14), 1);
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${worker.token}` },
        payload: {
          type: "VACATION",
          startDate: isoDay(pendingStart),
          endDate: isoDay(addDays(pendingStart, 1)),
          note: NOTE,
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const pendingId = JSON.parse(created.body).id as string;
      const later = await app.prisma.absence.create({
        data: {
          employeeId: worker.employee.id,
          type: "VOCATIONAL_SCHOOL",
          source: "MANUAL",
          startDate: onOrAfter(addDays(today, 21), 1),
          endDate: onOrAfter(addDays(today, 21), 1),
          days: 1,
          note: NOTE,
          createdBy: "system",
        },
      });
      const across = await app.prisma.absence.create({
        data: {
          employeeId: worker.employee.id,
          type: "MATERNITY",
          source: "MANUAL",
          startDate: addDays(exit, -1),
          endDate: addDays(exit, 1),
          days: 3,
          createdBy: "system",
        },
      });

      const res = await deactivate(worker.employee.id, { exitDate: isoDay(exit) });
      expect(res.statusCode, res.body).toBe(200);

      const shortened = await app.prisma.leaveRequest.findUniqueOrThrow({
        where: { id: spanning.id },
      });
      expect(shortened.status).toBe("APPROVED");
      expect(isoDay(shortened.endDate)).toBe(isoDay(exit));
      const corrected = await soleAuditRow(app.prisma, {
        where: { entity: "LeaveRequest", entityId: spanning.id, action: "LEAVE_CORRECTED" },
      });
      const correctedValue = corrected.newValue as Record<string, unknown>;
      expect(correctedValue.trigger).toBe("DEACTIVATION");
      expect(correctedValue.auditReason).toBe("Deaktivierung");

      expect(
        (await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: pendingId } })).status,
      ).toBe("CANCELLED");
      const cancel = await soleAuditRow(app.prisma, {
        where: { entity: "LeaveRequest", entityId: pendingId, action: "CANCEL" },
      });
      expect((cancel.newValue as Record<string, unknown>).trigger).toBe("DEACTIVATION");

      expect(
        (await app.prisma.absence.findUniqueOrThrow({ where: { id: later.id } })).deletedAt,
      ).not.toBeNull();
      const removed = await soleAuditRow(app.prisma, {
        where: { entity: "Absence", entityId: later.id, action: "DELETE" },
      });
      expect((removed.newValue as Record<string, unknown>).trigger).toBe("DEACTIVATION");
      expect(
        (await app.prisma.absence.findUniqueOrThrow({ where: { id: across.id } })).deletedAt,
      ).toBeNull();
      expect(await auditRowsFor(app, "Absence", across.id)).toHaveLength(0);

      const update = await soleAuditRow(app.prisma, {
        where: { entity: "Employee", entityId: worker.employee.id, action: "UPDATE" },
      });
      const summary = update.newValue as {
        absencesEnded: { cancelled: number; shortened: number; deleted: number };
        exitSkipped: unknown[];
      };
      expect(summary.absencesEnded).toEqual({ cancelled: 1, shortened: 1, deleted: 1 });
      expect(summary.exitSkipped).toEqual([
        { entity: "Absence", id: across.id, reason: "SPANNING_ABSENCE" },
      ]);

      // No audit row the deactivation wrote carries a note, a name or an e-mail.
      const rows = await app.prisma.auditLog.findMany({
        where: {
          entityId: { in: [worker.employee.id, spanning.id, pendingId, later.id, across.id] },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      expect(rows.length).toBeGreaterThanOrEqual(5);
      for (const row of rows) {
        const text = JSON.stringify(row.oldValue) + JSON.stringify(row.newValue);
        for (const secret of [NOTE, "Exit615", "Fixture", worker.user.email]) {
          expect(text).not.toContain(secret);
        }
      }
    });
  });

  // ── § 5 BUrlG after the exit rule, reactivate unchanged (AC-615-5, AC-615-9) ─────────────────
  describe("exit-year entitlement and reactivate", () => {
    it("deactivating equals PATCH exitDate for an identical twin on the exit-year row; reactivate restores the full value and does not restore the cancelled request", async () => {
      const exitYear = today.getUTCFullYear();
      const june30 = utcMidnight(`${exitYear}-06-30`);
      const exitDay = isoDay(today.getTime() < june30.getTime() ? today : june30);
      const hire = utcMidnight("2024-01-01");
      const a = await createWorker("twin-a", { hireDate: hire });
      const b = await createWorker("twin-b", { hireDate: hire });
      // Machine-owned exit-year rows: the sync recomputes those only.
      await app.prisma.leaveEntitlement.updateMany({
        where: { employeeId: { in: [a.employee.id, b.employee.id] }, year: exitYear },
        data: { isAutoCalculated: true, totalDays: 30 },
      });
      const rowOf = (employeeId: string, year = exitYear) =>
        app.prisma.leaveEntitlement.findFirstOrThrow({
          where: { employeeId, year, leaveType: { code: "VACATION" } },
        });

      const start = onOrAfter(addDays(today, 8), 1);
      const vacation = await approvedVacation(a, start, addDays(start, 2));
      const vacationYear = vacation.startDate.getUTCFullYear();
      const usedBefore = await usedDays(a.employee.id, vacationYear);

      const deact = await deactivate(a.employee.id, { exitDate: exitDay });
      expect(deact.statusCode, deact.body).toBe(200);
      const patched = await app.inject({
        method: "PATCH",
        url: `/api/v1/employees/${b.employee.id}`,
        headers: auth(),
        payload: { exitDate: `${exitDay}T00:00:00.000Z` },
      });
      expect(patched.statusCode, patched.body).toBe(200);

      const rowA = await rowOf(a.employee.id);
      const rowB = await rowOf(b.employee.id);
      expect(Number(rowA.totalDays)).toBe(Number(rowB.totalDays));
      expect(Number(rowA.totalDays)).toBeLessThan(30);
      expect(await usedDays(a.employee.id, vacationYear)).toBe(usedBefore - Number(vacation.days));

      const react = await app.inject({
        method: "PATCH",
        url: `/api/v1/employees/${a.employee.id}/reactivate`,
        headers: auth(),
      });
      expect(react.statusCode, react.body).toBe(200);
      const reactivated = await app.prisma.employee.findUniqueOrThrow({
        where: { id: a.employee.id },
        include: { user: true },
      });
      expect(reactivated.exitDate).toBeNull();
      expect(reactivated.user.isActive).toBe(true);
      expect(Number((await rowOf(a.employee.id)).totalDays)).toBe(30);
      expect(
        (await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: vacation.id } })).status,
      ).toBe("CANCELLED");
      const audits = await auditRowsFor(app, "Employee", a.employee.id, "UPDATE");
      expect(audits.at(-1)!.newValue).toEqual({ isActive: true, exitDate: null });
    });
  });
});
