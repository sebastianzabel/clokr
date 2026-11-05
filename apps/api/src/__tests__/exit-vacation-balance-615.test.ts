/**
 * Issue #615 (D-11/D-18) — `app.exitVacationBalance` answers, WITHOUT a write, what the exit-year
 * Resturlaub will be after a deactivation on a chosen last working day. It prices the hypothetical
 * exit date through the one § 5 BUrlG rule the #447 sync writes with (an `exitDate` override on the
 * same functions plus the sync's read-only planner), so the projection must equal what the
 * deactivation then stores and what `GET /leave/entitlements/:employeeId` then shows.
 *
 * Every date is relative to the tenant-local today. The exit day E is `min(today, 30 June)` of the
 * current year: an exit in the current year, never in the future, always a part-year (Teilurlaub).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  seedTestData,
  cleanupTestData,
  numericEmployeeNumber,
  grantSystemRole,
  soleAuditRow,
} from "./setup";
import { getTenantTimezone, todayInTz } from "../contexts/working-time-account";
import { getHolidayMap } from "../contexts/absence/leave-days";

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("Issue #615 — exit-year Resturlaub for a hypothetical last working day", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let today: Date;
  let year: number;
  let exitDay: Date;
  let exitIso: string;

  const auth = () => ({ authorization: `Bearer ${data.adminToken}` });

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

  async function mkEmployee(label: string) {
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
        employeeNumber: numericEmployeeNumber(),
        firstName: "Rest615",
        lastName: "Fixture",
        hireDate: new Date(Date.UTC(2024, 0, 1)),
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
        validFrom: new Date(Date.UTC(2024, 0, 1)),
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: user.email, password: "test1234" },
    });
    expect(login.statusCode).toBe(200);
    return { ...employee, token: JSON.parse(login.body).accessToken as string };
  }

  /** A machine-owned (never human-written) VACATION row. */
  const machineRow = (employeeId: string, rowYear: number, totalDays: number) =>
    app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: rowYear,
        totalDays,
        isAutoCalculated: true,
      },
    });

  const project = (employeeId: string, day = exitIso) =>
    app.exitVacationBalance(employeeId, data.tenant.id, day);

  /** Every entitlement column, the exit date and the audit rows of the person: a projection changes none. */
  async function writeSnapshot(employeeId: string) {
    const entitlements = await app.prisma.leaveEntitlement.findMany({
      where: { employeeId },
      orderBy: [{ year: "asc" }, { id: "asc" }],
    });
    return plain({
      entitlements,
      employee: await app.prisma.employee.findUniqueOrThrow({ where: { id: employeeId } }),
      audits: await app.prisma.auditLog.count({
        where: { entityId: { in: [employeeId, ...entitlements.map((e) => e.id)] } },
      }),
    });
  }

  async function vacation(token: string, start: Date) {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${token}` },
      payload: { type: "VACATION", startDate: isoDay(start), endDate: isoDay(start) },
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
    return id;
  }

  const deactivate = (employeeId: string) =>
    app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${employeeId}/deactivate`,
      headers: auth(),
      payload: { exitDate: exitIso },
    });

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "exit-vacation-balance-615");
    const tz = await getTenantTimezone(app.prisma, data.tenant.id);
    today = todayInTz(tz);
    year = today.getUTCFullYear();
    const june30 = new Date(Date.UTC(year, 5, 30));
    exitDay = today < june30 ? today : june30;
    exitIso = isoDay(exitDay);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("exit-vacation-balance-615 test cleanup failed:", err);
    }
  });

  it("the projected entitlement is exactly what the deactivation then stores, and nothing is written to know it", async () => {
    const employee = await mkEmployee("proj");
    const row = await machineRow(employee.id, year, 30);

    const before = await writeSnapshot(employee.id);
    const projected = await project(employee.id);
    expect(await writeSnapshot(employee.id)).toEqual(before);

    expect(projected).not.toBeNull();
    expect(projected!.year).toBe(year);
    expect(projected!.asOf).toBe(exitIso);
    expect(projected!.storedEntitlementDays).toBe(30);
    expect(projected!.entitlementRecomputed).toBe(true);
    expect(projected!.entitlementDays).toBeLessThan(30);
    expect(projected!.entitlementDays).toBeGreaterThan(0);

    const res = await deactivate(employee.id);
    expect(res.statusCode, res.body).toBe(200);
    const stored = await app.prisma.leaveEntitlement.findUniqueOrThrow({ where: { id: row.id } });
    expect(Number(stored.totalDays)).toBe(projected!.entitlementDays);

    // The same call after the deactivation: the stored value already is the § 5 value.
    const after = await project(employee.id);
    expect(after!.entitlementDays).toBe(projected!.entitlementDays);
    expect(after!.storedEntitlementDays).toBe(projected!.entitlementDays);
    expect(after!.entitlementRecomputed).toBe(false);
  });

  it("remainingAtExitDays equals the Resturlaub the account shows after the deactivation (days up to and including the exit day count, later ones are ended)", async () => {
    const employee = await mkEmployee("rest");
    await machineRow(employee.id, year, 30);
    // A taken day on or before the exit day (the exit day itself is included) ...
    const taken = await freeWeekday(exitDay, -1, employee.id);
    await vacation(employee.token, taken);
    // ... and one after it, which the exit rule cancels.
    const later = await freeWeekday(addDays(exitDay, 7), 1, employee.id);
    await vacation(employee.token, later);

    const before = await writeSnapshot(employee.id);
    const projected = await project(employee.id);
    expect(await writeSnapshot(employee.id)).toEqual(before);
    expect(projected!.takenDays).toBe(taken.getUTCFullYear() === year ? 1 : 0);
    expect(projected!.remainingAtExitDays).toBe(
      Math.round((projected!.availableDays - projected!.takenDays) * 100) / 100,
    );

    expect((await deactivate(employee.id)).statusCode).toBe(200);
    const got = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${employee.id}?year=${year}`,
      headers: auth(),
    });
    expect(got.statusCode, got.body).toBe(200);
    const vacationRow = (
      JSON.parse(got.body) as Array<{ vacationBalance: { remainingDays: number } | null }>
    ).find((r) => r.vacationBalance !== null)!;
    expect(vacationRow.vacationBalance!.remainingDays).toBe(projected!.remainingAtExitDays);
  });

  it("a past exit year keeps the stored row (the sync never recomputes a past year): entitlementRecomputed false", async () => {
    const employee = await mkEmployee("past");
    await machineRow(employee.id, year - 1, 30);
    const before = await writeSnapshot(employee.id);
    const projected = await project(employee.id, `${year - 1}-03-31`);
    expect(await writeSnapshot(employee.id)).toEqual(before);
    expect(projected).toMatchObject({
      year: year - 1,
      entitlementDays: 30,
      storedEntitlementDays: 30,
      entitlementRecomputed: false,
    });
  });

  it("a human-written row keeps its value (the sync never overwrites a human write)", async () => {
    const employee = await mkEmployee("human");
    const put = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/vacation/${employee.id}`,
      headers: auth(),
      payload: { year, totalDays: 25 },
    });
    expect(put.statusCode, put.body).toBe(200);
    const before = await writeSnapshot(employee.id);
    const projected = await project(employee.id);
    expect(await writeSnapshot(employee.id)).toEqual(before);
    expect(projected).toMatchObject({
      entitlementDays: 25,
      storedEntitlementDays: 25,
      entitlementRecomputed: false,
    });

    // The deactivation agrees: the human value stays.
    expect((await deactivate(employee.id)).statusCode).toBe(200);
    const stored = await app.prisma.leaveEntitlement.findFirstOrThrow({
      where: { employeeId: employee.id, year },
    });
    expect(Number(stored.totalDays)).toBe(25);
  });

  it("an exit year without a VACATION row has no projection", async () => {
    const employee = await mkEmployee("norow");
    expect(await project(employee.id)).toBeNull();
    const audits = await app.prisma.auditLog.count({ where: { entityId: employee.id } });
    expect(audits).toBe(0);
  });

  it("another tenant's employee id has no projection (tenant-scoped)", async () => {
    const employee = await mkEmployee("tenant");
    await machineRow(employee.id, year, 30);
    expect(await app.exitVacationBalance(employee.id, crypto.randomUUID(), exitIso)).toBeNull();
  });

  it("the deactivation writes the same single exit audit as before the split into plan and write", async () => {
    const employee = await mkEmployee("audit");
    const row = await machineRow(employee.id, year, 30);
    expect((await deactivate(employee.id)).statusCode).toBe(200);
    const audit = await soleAuditRow(app.prisma, {
      where: { entity: "LeaveEntitlement", entityId: row.id, action: "UPDATE" },
    });
    expect(audit.oldValue).toEqual({ totalDays: 30 });
    expect((audit.newValue as Record<string, unknown>).isAutoCalculated).toBe(true);
    expect((audit.newValue as Record<string, unknown>).reason).toBe(
      "Austritt — anteiliger Anspruch (§ 5 BUrlG)",
    );
  });
});
