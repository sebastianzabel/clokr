/**
 * Issue #615 (D-09) — `app.absenceExit.preview` is the exit plan as read-only rows: the deactivate
 * dialog shows what the exit rule WILL end before the admin confirms. It decides nothing itself
 * (it projects `planEmploymentExit`, the one decision), so every previewed row must equal what
 * `PATCH /employees/:id/deactivate` then does, and the preview writes nothing and carries no
 * free text.
 *
 * Deterministic weekdays: the exit day X is the most recent holiday-free weekday on or before the
 * tenant-local today; the other requests lie in later weeks.
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
import { getHolidayMap } from "../contexts/absence/leave-days";

const NOTE = "Notiz-Zebra-615-preview";
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const MARKER = { auditReason: "Deaktivierung", trigger: "DEACTIVATION" } as const;
const ROW_KEYS = [
  "action",
  "days",
  "endDate",
  "entity",
  "id",
  "newDays",
  "newEndDate",
  "reason",
  "startDate",
  "status",
  "typeCode",
];

describe("Issue #615 — app.absenceExit.preview", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let today: Date;
  let exitDay: Date;
  let firstOfLastMonth: Date;

  const auth = () => ({ authorization: `Bearer ${data.adminToken}` });

  /** First holiday-free Monday-Friday on or after (direction +1) / on or before (-1) `from`. */
  async function freeWeekday(from: Date, direction: 1 | -1, employeeId: string): Promise<Date> {
    let day = from;
    for (let i = 0; i < 40; i++) {
      const dow = day.getUTCDay();
      if (dow !== 0 && dow !== 6) {
        const holidays = await getHolidayMap(app.prisma, data.tenant.id, employeeId, day, day);
        if (holidays.size === 0) return day;
      }
      day = addDays(day, direction);
    }
    throw new Error("no holiday-free weekday found");
  }

  async function createWorker(label: string) {
    const suffix = crypto.randomUUID().slice(0, 8);
    const user = await app.prisma.user.create({
      data: {
        email: `${label}-${suffix}@example.invalid`,
        passwordHash: await bcrypt.hash("test1234", 10),
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        firstName: "Prev615",
        lastName: "Fixture",
        employeeNumber: numericEmployeeNumber(),
        hireDate: firstOfLastMonth,
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
        validFrom: firstOfLastMonth,
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
  type Worker = Awaited<ReturnType<typeof createWorker>>;

  async function vacation(who: Worker, start: Date, end: Date, approve: boolean) {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${who.token}` },
      payload: { type: "VACATION", startDate: isoDay(start), endDate: isoDay(end), note: NOTE },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = JSON.parse(created.body).id as string;
    if (approve) {
      const reviewed = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${id}/review`,
        headers: auth(),
        payload: { status: "APPROVED" },
      });
      expect(reviewed.statusCode, reviewed.body).toBe(200);
    }
    return app.prisma.leaveRequest.findUniqueOrThrow({ where: { id } });
  }

  const preview = (who: Worker) =>
    app.absenceExit.preview({
      tenantId: data.tenant.id,
      employeeId: who.employee.id,
      exitDay,
      marker: MARKER,
    });

  const deactivate = (who: Worker) =>
    app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${who.employee.id}/deactivate`,
      headers: auth(),
      payload: { exitDate: isoDay(exitDay) },
    });

  const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  /** Every row the exit could touch plus the audit rows concerning the person (the preview must change none). */
  async function writeSnapshot(who: Worker) {
    const employeeId = who.employee.id;
    const leave = await app.prisma.leaveRequest.findMany({
      where: { employeeId },
      orderBy: { id: "asc" },
    });
    const absences = await app.prisma.absence.findMany({
      where: { employeeId },
      orderBy: { id: "asc" },
    });
    const entitlements = await app.prisma.leaveEntitlement.findMany({
      where: { employeeId },
      orderBy: [{ year: "asc" }, { id: "asc" }],
    });
    return plain({
      leave,
      absences,
      entitlements,
      section9: await app.prisma.section9Credit.count({ where: { employeeId } }),
      employee: await app.prisma.employee.findUniqueOrThrow({ where: { id: employeeId } }),
      audits: await app.prisma.auditLog.count({
        where: {
          entityId: {
            in: [
              employeeId,
              ...leave.map((l) => l.id),
              ...absences.map((a) => a.id),
              ...entitlements.map((e) => e.id),
            ],
          },
        },
      }),
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "employment-exit-preview-615");
    const tz = await getTenantTimezone(app.prisma, data.tenant.id);
    today = todayInTz(tz);
    firstOfLastMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    exitDay = await freeWeekday(today, -1, data.adminEmployee.id);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("employment-exit-preview-615 test cleanup failed:", err);
    }
  });

  it("projects every action of the exit plan, writes nothing, carries no free text, and equals what the deactivation then does", async () => {
    const worker = await createWorker("full");
    const spanning = await vacation(worker, exitDay, addDays(exitDay, 6), true);
    const pendingStart = await freeWeekday(addDays(exitDay, 14), 1, worker.employee.id);
    const pending = await vacation(worker, pendingStart, addDays(pendingStart, 2), false);
    const approvedStart = await freeWeekday(addDays(exitDay, 28), 1, worker.employee.id);
    const approved = await vacation(worker, approvedStart, addDays(approvedStart, 2), true);
    const school = await app.prisma.absence.create({
      data: {
        employeeId: worker.employee.id,
        type: "VOCATIONAL_SCHOOL",
        source: "MANUAL",
        startDate: addDays(exitDay, 10),
        endDate: addDays(exitDay, 10),
        days: 1,
        note: NOTE,
        createdBy: "system",
      },
    });
    const maternity = await app.prisma.absence.create({
      data: {
        employeeId: worker.employee.id,
        type: "MATERNITY",
        source: "MANUAL",
        startDate: addDays(exitDay, -1),
        endDate: addDays(exitDay, 1),
        days: 3,
        note: NOTE,
        createdBy: "system",
      },
    });
    expect(spanning.status).toBe("APPROVED");
    expect(pending.status).toBe("PENDING");
    expect(approved.status).toBe("APPROVED");

    const before = await writeSnapshot(worker);
    const rows = await preview(worker);
    expect(await writeSnapshot(worker)).toEqual(before);

    // Whitelist: ids, codes, YYYY-MM-DD and numbers only; never a note.
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
      for (const value of Object.values(row)) {
        if (typeof value === "string") expect(value).not.toContain("Zebra");
      }
      expect(row.reason).toMatch(/^[A-Z_]+$/);
    }
    expect(JSON.stringify(rows)).not.toContain(NOTE);
    expect(JSON.stringify(rows)).not.toContain("Prev615");
    expect(JSON.stringify(rows)).not.toContain(worker.user.email);

    // Sorted by start date, then id.
    const keys = rows.map((r) => `${r.startDate}|${r.id}`);
    expect(keys).toEqual([...keys].sort());

    const byId = new Map(rows.map((r) => [r.id, r]));
    const shorten = byId.get(spanning.id)!;
    expect(shorten).toMatchObject({
      entity: "LeaveRequest",
      action: "SHORTEN",
      typeCode: "VACATION",
      status: "APPROVED",
      startDate: isoDay(spanning.startDate),
      endDate: isoDay(spanning.endDate),
      newEndDate: isoDay(exitDay),
      days: Number(spanning.days),
    });
    expect(shorten.newDays).toBeGreaterThan(0);
    expect(shorten.newDays).toBeLessThan(Number(spanning.days));

    expect(byId.get(pending.id)).toMatchObject({
      entity: "LeaveRequest",
      action: "CANCEL",
      status: "PENDING",
      typeCode: "VACATION",
      newEndDate: null,
      newDays: null,
      days: Number(pending.days),
    });
    expect(byId.get(approved.id)).toMatchObject({
      entity: "LeaveRequest",
      action: "CANCEL",
      status: "APPROVED",
      typeCode: "VACATION",
      days: Number(approved.days),
    });
    expect(byId.get(school.id)).toMatchObject({
      entity: "Absence",
      action: "DELETE",
      typeCode: "VOCATIONAL_SCHOOL",
      status: null,
      startDate: isoDay(school.startDate),
      endDate: isoDay(school.endDate),
      days: 1,
    });
    expect(byId.get(maternity.id)).toMatchObject({
      entity: "Absence",
      action: "SKIP",
      reason: "SPANNING_ABSENCE",
      typeCode: "MATERNITY",
      startDate: isoDay(maternity.startDate),
      endDate: isoDay(maternity.endDate),
      days: 3,
    });

    // Parity: the deactivation does exactly what the rows said.
    const res = await deactivate(worker);
    expect(res.statusCode, res.body).toBe(200);
    const reload = (id: string) => app.prisma.leaveRequest.findUniqueOrThrow({ where: { id } });

    const shortened = await reload(spanning.id);
    expect(isoDay(shortened.endDate)).toBe(shorten.newEndDate);
    expect(Number(shortened.days)).toBe(shorten.newDays);
    expect(shortened.status).toBe("APPROVED");
    expect((await reload(pending.id)).status).toBe("CANCELLED");
    expect((await reload(approved.id)).status).toBe("CANCELLED");
    expect(
      (await app.prisma.absence.findUniqueOrThrow({ where: { id: school.id } })).deletedAt,
    ).not.toBeNull();
    const kept = await app.prisma.absence.findUniqueOrThrow({ where: { id: maternity.id } });
    expect(kept.deletedAt).toBeNull();
    expect(isoDay(kept.endDate)).toBe(isoDay(maternity.endDate));

    const update = await soleAuditRow(app.prisma, {
      where: { entity: "Employee", entityId: worker.employee.id, action: "UPDATE" },
    });
    const newValue = update.newValue as { exitSkipped: Array<{ id: string; reason: string }> };
    expect(newValue.exitSkipped).toEqual([
      { entity: "Absence", id: maternity.id, reason: "SPANNING_ABSENCE" },
    ]);
  });

  it("a PENDING request spanning the exit day previews as SHORTEN with its re-priced days", async () => {
    const worker = await createWorker("pending");
    const pending = await vacation(worker, exitDay, addDays(exitDay, 6), false);
    expect(pending.status).toBe("PENDING");

    const before = await writeSnapshot(worker);
    const rows = await preview(worker);
    expect(await writeSnapshot(worker)).toEqual(before);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: pending.id,
      action: "SHORTEN",
      status: "PENDING",
      newEndDate: isoDay(exitDay),
      days: Number(pending.days),
    });
    expect(rows[0].newDays).toBeGreaterThan(0);

    expect((await deactivate(worker)).statusCode).toBe(200);
    const after = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: pending.id } });
    expect(after.status).toBe("PENDING");
    expect(isoDay(after.endDate)).toBe(isoDay(exitDay));
    expect(Number(after.days)).toBe(rows[0].newDays);
  });

  it("a person with nothing after the exit day previews an empty list", async () => {
    const worker = await createWorker("empty");
    expect(await preview(worker)).toEqual([]);
  });
});
