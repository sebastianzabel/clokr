/**
 * Issue #614 — DSGVO anonymization ends the employment.
 *
 * D-01: `DELETE /api/v1/employees/:id` stores the tenant-local day of the anonymization as the exit
 * date when none is set (an existing one, past or future, is never changed) and brings the
 * exit-year VACATION entitlement to its § 5 BUrlG value exactly like `PATCH /:id/deactivate`
 * (Issue #447 invariant).
 *
 * Every date is computed relative to the tenant-local today, so the file passes on any day of the
 * year.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import iconv from "iconv-lite";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  seedTestData,
  cleanupTestData,
  seedEntitlementYears,
  configureDatevKanzlei,
  grantSystemRole,
  auditRowsFor,
  soleAuditRow,
  numericEmployeeNumber,
} from "./setup";
import { getTenantTimezone, todayInTz } from "../contexts/working-time-account";
import { DATEV_STUNDEN_SATZ_ID, DATEV_TAGE_SATZ_ID } from "../composition/reports";

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const utcMidnight = (iso: string) => new Date(`${iso}T00:00:00Z`);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
/** First date on or after `from` whose UTC weekday is `weekday` (0 = Sunday). */
const onOrAfter = (from: Date, weekday: number) =>
  addDays(from, (weekday - from.getUTCDay() + 7) % 7);

describe("Issue #614 — anonymization ends the employment", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let today: Date;

  const auth = () => ({ authorization: `Bearer ${data.adminToken}` });

  /** Creates a plain employee row (no API round trip) with an active user. */
  async function createEmployee(label: string, extra: { exitDate?: Date | null } = {}) {
    const suffix = crypto.randomUUID().slice(0, 8);
    const user = await app.prisma.user.create({
      data: {
        email: `${label}-${suffix}@example.invalid`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        firstName: "Exit614",
        lastName: "Fixture",
        employeeNumber: numericEmployeeNumber(),
        hireDate: utcMidnight(`${today.getUTCFullYear() - 2}-01-01`),
        exitDate: extra.exitDate ?? null,
      },
    });
    return { user, employee };
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "anon-exit-614");
    const tz = await getTenantTimezone(app.prisma, data.tenant.id);
    today = todayInTz(tz);
    await configureDatevKanzlei(app, data.tenant.id);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("anonymization-ends-employment-614 test cleanup failed:", err);
    }
  });

  describe("D-01 exit date", () => {
    it("sets the exit date to the tenant-local today when none is stored, and says so in the ANONYMIZE audit", async () => {
      const { employee } = await createEmployee("set");
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${employee.id}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(204);

      const after = await app.prisma.employee.findUniqueOrThrow({ where: { id: employee.id } });
      expect(after.exitDate).not.toBeNull();
      expect(isoDay(after.exitDate!)).toBe(isoDay(today));

      const audit = await soleAuditRow(app.prisma, {
        where: { entity: "Employee", entityId: employee.id, action: "ANONYMIZE" },
      });
      const newValue = audit.newValue as { exitDate: string; exitDateSet: boolean };
      expect(newValue.exitDate).toBe(isoDay(today));
      expect(newValue.exitDateSet).toBe(true);
    });

    it("never changes an exit date that is already stored (future day, entered as UTC midnight like the web)", async () => {
      const future = utcMidnight(
        isoDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 2, 0))),
      );
      const { employee } = await createEmployee("keep", { exitDate: future });
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${employee.id}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(204);

      const after = await app.prisma.employee.findUniqueOrThrow({ where: { id: employee.id } });
      expect(after.exitDate!.toISOString()).toBe(future.toISOString());

      const audit = await soleAuditRow(app.prisma, {
        where: { entity: "Employee", entityId: employee.id, action: "ANONYMIZE" },
      });
      const newValue = audit.newValue as { exitDate: string; exitDateSet: boolean };
      expect(newValue.exitDate).toBe(isoDay(future));
      expect(newValue.exitDateSet).toBe(false);
    });

    it("leaves the exit-year VACATION entitlement exactly as PATCH /:id/deactivate leaves it for an identical twin (Issue #447)", async () => {
      // Hired on the first of the month three months ago, so the § 5 BUrlG sync has a Teilurlaub
      // to compute for the exit year (Wartezeit not fulfilled).
      const hire = utcMidnight(
        isoDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 3, 1))),
      );
      const twins: string[] = [];
      for (const label of ["twin-a", "twin-b"]) {
        const email = `${label}-${crypto.randomUUID().slice(0, 8)}@example.invalid`;
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/employees",
          headers: auth(),
          payload: {
            usualWorkDays: [1, 2, 3, 4, 5],
            email,
            firstName: "Twin614",
            lastName: "Fixture",
            employeeNumber: numericEmployeeNumber(),
            hireDate: hire.toISOString(),
            role: "EMPLOYEE",
            weeklyHours: 40,
            password: "Test@1234567!",
          },
        });
        expect(res.statusCode).toBe(201);
        twins.push(JSON.parse(res.body).id);
      }
      const [anonymized, deactivated] = twins;
      const exitYear = today.getUTCFullYear();
      const rowOf = (employeeId: string) =>
        app.prisma.leaveEntitlement.findFirst({
          where: { employeeId, year: exitYear, leaveType: { code: "VACATION" } },
          select: { totalDays: true, isAutoCalculated: true, usedDays: true },
        });

      // Same booked state before either exit: the creation path wrote identical rows.
      const beforeA = await rowOf(anonymized);
      const beforeB = await rowOf(deactivated);
      expect(beforeA).not.toBeNull();
      expect(beforeB).not.toBeNull();
      expect(Number(beforeA!.totalDays)).toBe(Number(beforeB!.totalDays));

      const deact = await app.inject({
        method: "PATCH",
        url: `/api/v1/employees/${deactivated}/deactivate`,
        headers: auth(),
        payload: { exitDate: today.toISOString() },
      });
      expect(deact.statusCode).toBe(200);
      const del = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${anonymized}`,
        headers: auth(),
      });
      expect(del.statusCode).toBe(204);

      const afterA = await rowOf(anonymized);
      const afterB = await rowOf(deactivated);
      expect(afterA).not.toBeNull();
      expect(afterB).not.toBeNull();
      expect(Number(afterA!.totalDays)).toBe(Number(afterB!.totalDays));
      expect(afterA!.isAutoCalculated).toBe(afterB!.isAutoCalculated);
      expect(Number(afterA!.usedDays)).toBe(Number(afterB!.usedDays));
    });
  });
  // ── Tracer: an approved vacation after the exit ──────────────────────────────────────────────
  describe("tracer: absence after the exit", () => {
    const F_PNR = 1;
    const F_LOHNART = 3;

    /** Employee with a fixed contract, a login and entitlement rows for every year touched. */
    async function createWorker(
      tenantId: string,
      label: string,
      opts: { exitDate?: Date | null } = {},
    ) {
      const suffix = crypto.randomUUID().slice(0, 8);
      const user = await app.prisma.user.create({
        data: {
          email: `${label}-${suffix}@example.invalid`,
          passwordHash: await bcrypt.hash("test1234", 10),
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const employee = await app.prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          firstName: "Exit614",
          lastName: "Fixture",
          employeeNumber: numericEmployeeNumber(),
          hireDate: utcMidnight(`${today.getUTCFullYear() - 2}-01-01`),
          exitDate: opts.exitDate ?? null,
        },
      });
      await grantSystemRole(app.prisma, { tenantId, userId: user.id, role: "EMPLOYEE" });
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
          validFrom: utcMidnight(`${today.getUTCFullYear() - 2}-01-01`),
        },
      });
      await app.prisma.overtimeAccount.create({
        data: { employeeId: employee.id, balanceHours: 0 },
      });
      await seedEntitlementYears(app, {
        employeeId: employee.id,
        leaveTypeId: data.vacationType.id,
        years: [today.getUTCFullYear(), today.getUTCFullYear() + 1],
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
    async function approvedVacation(
      who: { token: string },
      start: Date,
      end: Date,
      adminToken = data.adminToken,
    ) {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${who.token}` },
        payload: {
          type: "VACATION",
          startDate: isoDay(start),
          endDate: isoDay(end),
          note: "Notiz-Zebra-614",
        },
      });
      expect(created.statusCode).toBe(201);
      const id = JSON.parse(created.body).id as string;
      const reviewed = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${id}/review`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { status: "APPROVED" },
      });
      expect(reviewed.statusCode).toBe(200);
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

    /** Bewegungsdaten rows (split by ";") of the company DATEV export of a month. */
    async function datevRows(year: number, month: number): Promise<string[][]> {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/datev?year=${year}&month=${month}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      return iconv
        .decode(res.rawPayload, "win1252")
        .split("[Bewegungsdaten]")[1]
        .split("\r\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => l.split(";"))
        .filter((f) => [DATEV_STUNDEN_SATZ_ID, DATEV_TAGE_SATZ_ID].map(String).includes(f[0]!));
    }

    it("cancels the approved vacation after the exit, books it back, audits it without free text, and drops the person from next month's DATEV export", async () => {
      const worker = await createWorker(data.tenant.id, "tracer");
      // Issue #304: the DATEV file lists a person only with something to book, so the exit month
      // needs one worked entry for the person to appear in it (closed, today's UTC date).
      const workedDay = isoDay(today);
      await app.prisma.timeEntry.create({
        data: {
          employeeId: worker.employee.id,
          date: new Date(`${workedDay}T00:00:00.000Z`),
          startTime: new Date(`${workedDay}T05:00:00.000Z`),
          endTime: new Date(`${workedDay}T06:00:00.000Z`),
          breakMinutes: 0,
          type: "WORK",
          source: "MANUAL",
          salonId: data.salonId,
        },
      });
      const nextMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
      // Issue #304: next month's file must still list somebody (the seeded employee has worked time).
      const nextDay = isoDay(nextMonth);
      await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: new Date(`${nextDay}T00:00:00.000Z`),
          startTime: new Date(`${nextDay}T05:00:00.000Z`),
          endTime: new Date(`${nextDay}T06:00:00.000Z`),
          breakMinutes: 0,
          type: "WORK",
          source: "MANUAL",
          salonId: data.salonId,
        },
      });
      const start = onOrAfter(addDays(nextMonth, 7), 1); // first Monday on or after the 8th
      const vacation = await approvedVacation(worker, start, addDays(start, 2));
      expect(vacation.status).toBe("APPROVED");

      // A closed WORK entry today, so the exit month's export has a line for the person.
      await app.prisma.timeEntry.create({
        data: {
          employeeId: worker.employee.id,
          date: today,
          startTime: new Date(`${isoDay(today)}T06:00:00Z`),
          endTime: new Date(`${isoDay(today)}T08:00:00Z`),
          breakMinutes: 0,
          type: "WORK",
          source: "MANUAL",
          salonId: data.salonId,
        },
      });

      const vacationYear = vacation.startDate.getUTCFullYear();
      const usedBefore = await usedDays(worker.employee.id, vacationYear);
      expect(usedBefore).toBeGreaterThanOrEqual(Number(vacation.days));
      const originalNumber = worker.employee.employeeNumber;

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${worker.employee.id}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(204);

      const after = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: vacation.id } });
      expect(after.status).toBe("CANCELLED");
      expect(after.deletedAt).toBeNull();
      expect(await usedDays(worker.employee.id, vacationYear)).toBe(
        usedBefore - Number(vacation.days),
      );

      const cancel = await soleAuditRow(app.prisma, {
        where: { entity: "LeaveRequest", entityId: vacation.id, action: "CANCEL" },
      });
      const newValue = cancel.newValue as Record<string, unknown>;
      expect(newValue.status).toBe("CANCELLED");
      expect(newValue.auditReason).toBe("Anonymisierung");
      expect(newValue.trigger).toBe("ANONYMIZATION");
      expect(newValue.exitDate).toBe(isoDay(today));
      const serialized = JSON.stringify(cancel.oldValue) + JSON.stringify(cancel.newValue);
      for (const secret of ["Notiz-Zebra-614", "Exit614", "Fixture", worker.user.email]) {
        expect(serialized).not.toContain(secret);
      }

      const anonymize = await soleAuditRow(app.prisma, {
        where: { entity: "Employee", entityId: worker.employee.id, action: "ANONYMIZE" },
      });
      const summary = anonymize.newValue as {
        absencesEnded: { cancelled: number; shortened: number; deleted: number };
        skipped: unknown[];
      };
      expect(summary.absencesEnded.cancelled).toBe(1);
      expect(summary.skipped).toEqual([]);

      // DATEV: the exit month still lists the person, the following month does not.
      const anonymizedNumber = (
        await app.prisma.employee.findUniqueOrThrow({ where: { id: worker.employee.id } })
      ).employeeNumber;
      const pnrs = new Set([originalNumber, anonymizedNumber]);
      const exitMonthRows = await datevRows(today.getUTCFullYear(), today.getUTCMonth() + 1);
      expect(exitMonthRows.some((r) => pnrs.has(r[F_PNR]) && r[F_LOHNART] === "100")).toBe(true);
      const nextRows = await datevRows(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1);
      expect(nextRows.length).toBeGreaterThan(0); // the other employees are still exported
      expect(nextRows.some((r) => pnrs.has(r[F_PNR]))).toBe(false);
    });

    it("keeps a vacation up to a stored exit day and cancels the one starting the day after it", async () => {
      // Exit on a Tuesday at least a week ahead: V1 Mon-Tue ends ON the exit day, V2 Wed-Thu starts after it.
      const exitDay = onOrAfter(addDays(today, 8), 2);
      const worker = await createWorker(data.tenant.id, "stored", { exitDate: exitDay });
      const v1 = await approvedVacation(worker, addDays(exitDay, -1), exitDay);
      const v2 = await approvedVacation(worker, addDays(exitDay, 1), addDays(exitDay, 2));

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${worker.employee.id}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(204);

      expect(
        (await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: v1.id } })).status,
      ).toBe("APPROVED");
      expect(
        (await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: v2.id } })).status,
      ).toBe("CANCELLED");
      expect(await auditRowsFor(app, "LeaveRequest", v1.id, "CANCEL")).toHaveLength(0);
      expect(await auditRowsFor(app, "LeaveRequest", v2.id, "CANCEL")).toHaveLength(1);

      const anonymize = await soleAuditRow(app.prisma, {
        where: { entity: "Employee", entityId: worker.employee.id, action: "ANONYMIZE" },
      });
      const nv = anonymize.newValue as { absencesEnded: { cancelled: number }; exitDate: string };
      expect(nv.absencesEnded.cancelled).toBe(1);
      expect(nv.exitDate).toBe(isoDay(exitDay)); // the stored exit day, not a tenant-local shift of it
    });

    it("rolls everything back when the role lockout refuses the anonymization", async () => {
      // Own tenant: the seed admin is the only role:manage holder, anonymizing their own record is refused.
      const other = await seedTestData(app, "anon-exit-614-lockout");
      try {
        await seedEntitlementYears(app, {
          employeeId: other.adminEmployee.id,
          leaveTypeId: other.vacationType.id,
          years: [today.getUTCFullYear(), today.getUTCFullYear() + 1],
        });
        const nextMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
        const start = onOrAfter(addDays(nextMonth, 7), 1);
        // The admin cannot approve their own request, so the approved row is written directly
        // together with the booking the approval would have made (usedDays below).
        await app.prisma.leaveRequest.create({
          data: {
            employeeId: other.adminEmployee.id,
            leaveTypeId: other.vacationType.id,
            startDate: start,
            endDate: addDays(start, 2),
            days: 3,
            status: "APPROVED",
          },
        });
        const vacation = await app.prisma.leaveRequest.findFirstOrThrow({
          where: { employeeId: other.adminEmployee.id },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        await app.prisma.leaveEntitlement.updateMany({
          where: { employeeId: other.adminEmployee.id, year: start.getUTCFullYear() },
          data: { usedDays: 3 },
        });
        const usedBefore = await usedDays(other.adminEmployee.id, start.getUTCFullYear());

        const res = await app.inject({
          method: "DELETE",
          url: `/api/v1/employees/${other.adminEmployee.id}`,
          headers: { authorization: `Bearer ${other.adminToken}` },
        });
        expect(res.statusCode).toBe(409);

        const emp = await app.prisma.employee.findUniqueOrThrow({
          where: { id: other.adminEmployee.id },
        });
        expect(emp.exitDate).toBeNull();
        expect(emp.firstName).not.toBe("Gelöscht");
        expect(
          (await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: vacation.id } })).status,
        ).toBe("APPROVED");
        expect(await usedDays(other.adminEmployee.id, start.getUTCFullYear())).toBe(usedBefore);
        expect(await auditRowsFor(app, "LeaveRequest", vacation.id, "CANCEL")).toHaveLength(0);
      } finally {
        try {
          await cleanupTestData(app, other.tenant.id);
        } catch (err) {
          console.error("anonymization-ends-employment-614 lockout cleanup failed:", err);
        }
      }
    });
  });
});
