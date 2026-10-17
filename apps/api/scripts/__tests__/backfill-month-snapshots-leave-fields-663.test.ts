/**
 * Issue #663 - the backfill script must store the SAME SaldoSnapshot as the regular Monatsabschluss.
 *
 * Before the fix `backfill-month-snapshots.ts` read its leave rows with its own query and handed
 * `closeEmployeeMonth` rows without `isOvertimeCompensation` / `creditBasis`, so a month with an
 * Ueberstundenausgleich leave (#468) was backfilled WITHOUT the withdrawal the regular close books.
 *
 * Two identical employees in one tenant, one past month (June 2026, fixed - the real run date only
 * moves forward): one is closed through the regular `POST /overtime/close-month`, the other through
 * the backfill script. Every figure of the two snapshots must match, and the figure must carry the
 * withdrawal (an absolute anchor, so "both wrong in the same way" cannot pass).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  createTestSalon,
  salonIdForEmployee,
  grantSystemRole,
  cleanupTestData,
  soleAuditRow,
} from "../../src/__tests__/setup";
import { leaveTypeFields } from "../../src/contexts/absence/leave-type";
import { snapshotMonthOf } from "../../src/contexts/working-time-account";
import { main } from "../backfill-month-snapshots";

const TZ = "Europe/Berlin";
const YEAR = 2026;
const MONTH = 6;
const COMP_DAY = "2026-06-10"; // Wednesday - Ueberstundenausgleich, 480 min booked at approval
const SICK_DAY = "2026-06-11"; // Thursday - sick (roster-credit type)
const OVERTIME_COMP_MINUTES = 480;

function workdaysOfJune(): string[] {
  const out: string[] = [];
  for (let d = 1; d <= 30; d++) {
    const date = new Date(Date.UTC(YEAR, MONTH - 1, d));
    const dow = date.getUTCDay();
    if (dow >= 1 && dow <= 5) out.push(date.toISOString().slice(0, 10));
  }
  return out;
}

describe("backfill-month-snapshots stores the regular close's snapshot (Issue #663)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let regularEmpId: string;
  let backfillEmpId: string;
  let compTypeId: string;
  let sickTypeId: string;

  async function createEmployee(suffix: string): Promise<string> {
    const prisma = app.prisma;
    const user = await prisma.user.create({
      data: {
        email: `p663-${suffix}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `P663-${suffix}`,
        firstName: "X.",
        lastName: suffix.toUpperCase(),
        hireDate: new Date("2026-06-01T00:00:00Z"),
        breakOver6hOverride: 0,
        breakOver9hOverride: 0,
      },
    });
    await grantSystemRole(prisma, { tenantId, userId: user.id, role: "EMPLOYEE" });
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
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
        validFrom: new Date("2026-06-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    const salonId = await salonIdForEmployee(prisma, emp.id);
    for (const day of workdaysOfJune()) {
      if (day === COMP_DAY || day === SICK_DAY) continue;
      await prisma.timeEntry.create({
        data: {
          employeeId: emp.id,
          date: new Date(day + "T00:00:00Z"),
          startTime: new Date(day + "T07:00:00Z"),
          endTime: new Date(day + "T15:30:00Z"),
          breakMinutes: 30,
          type: "WORK",
          salonId,
        },
      });
    }
    const leave = (leaveTypeId: string, day: string, overtimeCompMinutes: number | null) =>
      prisma.leaveRequest.create({
        data: {
          employeeId: emp.id,
          leaveTypeId,
          startDate: new Date(day + "T00:00:00Z"),
          endDate: new Date(day + "T00:00:00Z"),
          days: 1,
          status: "APPROVED",
          overtimeCompMinutes,
        },
      });
    await leave(compTypeId, COMP_DAY, OVERTIME_COMP_MINUTES);
    await leave(sickTypeId, SICK_DAY, null);
    return emp.id;
  }

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const s = `p663-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const tenant = await prisma.tenant.create({
      data: { name: `P663 ${s}`, slug: s, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await createTestSalon(prisma, tenantId);
    await prisma.tenantConfig.create({
      data: {
        tenantId,
        defaultVacationDays: 30,
        timezone: TZ,
        defaultBreakOver6h: 30,
        defaultBreakOver9h: 45,
      },
    });
    compTypeId = (
      await prisma.leaveType.create({
        data: { tenantId, ...leaveTypeFields("OVERTIME_COMP"), color: "#8B5CF6" },
      })
    ).id;
    sickTypeId = (
      await prisma.leaveType.create({
        data: { tenantId, ...leaveTypeFields("SICK"), color: "#EF4444" },
      })
    ).id;

    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "ADMIN",
        isActive: true,
      },
    });
    await prisma.employee.create({
      data: {
        tenantId,
        userId: adminUser.id,
        employeeNumber: `ADM-${s}`,
        firstName: "A.",
        lastName: "D.",
        hireDate: new Date("2024-01-01T00:00:00Z"),
        isTimeTrackingExempt: true,
      },
    });
    await grantSystemRole(prisma, { tenantId, userId: adminUser.id, role: "ADMIN" });

    regularEmpId = await createEmployee(`reg-${s}`);
    backfillEmpId = await createEmployee(`bkf-${s}`);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `admin-${s}@test.de`, password: "test1234" },
    });
    adminToken = JSON.parse(login.body).accessToken;
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("backfill-663 cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function activeJuneSnapshot(employeeId: string) {
    const rows = await app.prisma.saldoSnapshot.findMany({
      where: { employeeId, periodType: "MONTHLY", superseded: false },
    });
    const june = rows.filter((r) => {
      const named = snapshotMonthOf(r.periodStart, TZ);
      return named?.year === YEAR && named.month === MONTH;
    });
    expect(june).toHaveLength(1);
    return june[0];
  }

  it("a month with an Ueberstundenausgleich leave backfills to the regular close's snapshot", async () => {
    const closeRes = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/close-month",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { employeeId: regularEmpId, year: YEAR, month: MONTH },
    });
    expect(closeRes.statusCode, closeRes.body).toBeLessThan(300);

    const summary = await main(app, {
      apply: true,
      tenantId,
      employeeIds: [backfillEmpId],
      until: { year: YEAR, month: MONTH },
    });
    expect(summary.errors).toEqual([]);
    expect(summary.totalMonthsClosed).toBe(1);

    const regular = await activeJuneSnapshot(regularEmpId);
    const backfilled = await activeJuneSnapshot(backfillEmpId);

    const figures = (r: typeof regular) => ({
      periodType: r.periodType,
      workedMinutes: r.workedMinutes,
      expectedMinutes: r.expectedMinutes,
      balanceMinutes: r.balanceMinutes,
      carryOver: r.carryOver,
      superseded: r.superseded,
      periodStart: r.periodStart.toISOString(),
      periodEnd: r.periodEnd.toISOString(),
    });
    expect(figures(backfilled)).toEqual(figures(regular));

    // Absolute anchor: 20 worked days (9600 min) against a Soll of 22 days minus the 2 leave
    // days (9600 min) is a gross balance of 0; the Ausgleich withdraws its booked 480 minutes.
    expect(regular.workedMinutes).toBe(9600);
    expect(regular.expectedMinutes).toBe(9600);
    expect(regular.balanceMinutes).toBe(-OVERTIME_COMP_MINUTES);
    expect(backfilled.balanceMinutes).toBe(-OVERTIME_COMP_MINUTES);
  }, 120_000);

  it("the backfill is recognisable by its audit row (origin BACKFILL, employee id, month)", async () => {
    const row = await soleAuditRow(app.prisma, {
      where: { entity: "SaldoSnapshot", action: "CREATE", entityId: backfillEmpId },
    });
    expect(row.newValue).toMatchObject({ origin: "BACKFILL", year: YEAR, month: MONTH });
  });
});
