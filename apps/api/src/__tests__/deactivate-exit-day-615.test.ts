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
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  seedTestData,
  cleanupTestData,
  seedEntitlementYears,
  grantSystemRole,
  soleAuditRow,
  numericEmployeeNumber,
} from "./setup";
import { getTenantTimezone, todayInTz } from "../contexts/working-time-account";

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
});

// Helper kept referenced for the cases added in Task 2.
void utcMidnight;
