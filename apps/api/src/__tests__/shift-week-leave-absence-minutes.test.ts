/**
 * Phase 76.11 regression tests — SOLL-V19-01.
 *
 * Verifies that `GET /api/v1/shifts/week` emits per-employee leave and absence
 * minute aggregates clipped to the visible Mon-Sun week. The shift-planner UI
 * subtracts these from the weekly Soll so the Soll-Korrelation row is correct
 * during vacation/sickness weeks.
 *
 * Pattern mirrors shifts-arbzg-break-override.test.ts (Phase 76.10 sibling):
 *  - Shared singleton Fastify app via getTestApp()
 *  - Fresh tenant per suite, ADMIN user for the GET /week call
 *  - Fixed future Monday so the visible-week math is deterministic across runs
 *
 * D-09 test matrix:
 *  A. FIXED_WEEKLY 40h Mo-Fr employee with 2 days APPROVED VACATION leave
 *     (Mo+Tu) in the visible week → leaveMinutesByEmp[empId] === 960 (16h × 60).
 *  B. Same employee, leave status PENDING → leaveMinutesByEmp[empId] is
 *     undefined or 0 (status filter excludes non-APPROVED/CANCELLATION_REQUESTED).
 *  C. Same employee, 1 weekend day (Sa) APPROVED leave → leaveMinutesByEmp[empId]
 *     is undefined or 0 because saturdayHours=0 in the schedule (weekend
 *     exclusion via per-day hours).
 *  D. Absence (deletedAt: null) covering Mo-Tu → absenceMinutesByEmp[empId]
 *     === 960. Soft-deleted Absence in the same window → undefined or 0
 *     (deletedAt:null soft-delete filter).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";

const TZ = "Europe/Berlin";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve the Monday of the week N weeks in the future (no Sunday/holiday
 * interference). Returns ISO "YYYY-MM-DD" for that Monday.
 */
function futureMondayIso(weeksAhead: number): string {
  const today = new Date(todayIso() + "T00:00:00Z");
  const dow = today.getUTCDay(); // 0=Sun..6=Sat
  // mondayOffset matches the GET /week resolver (shifts.ts L701-L704):
  // dow === 0 ? -6 : 1 - dow
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(today);
  monday.setUTCDate(monday.getUTCDate() + mondayOffset + weeksAhead * 7);
  return monday.toISOString().slice(0, 10);
}

describe("Phase 76.11 — /shifts/week emits leaveMinutesByEmp + absenceMinutesByEmp (SOLL-V19-01)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let vacationTypeId: string;
  let suiteSuffix: string;
  // A future Monday far enough in the future that nothing else collides with it.
  let weekMonday: string;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    suiteSuffix = "soll-v19-01-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    weekMonday = futureMondayIso(8); // 8 weeks ahead — safely in the future

    const tenant = await prisma.tenant.create({
      data: {
        name: `Phase 76.11 Test ${suiteSuffix}`,
        slug: `phase-76-11-${suiteSuffix}`,
        federalState: "NIEDERSACHSEN",
      },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: {
        tenantId,
        defaultVacationDays: 30,
        timezone: TZ,
      },
    });

    // Admin user for the GET /week request (any role with read access works,
    // ADMIN keeps the fixture consistent with the 76.10 sibling).
    const adminPasswordHash = await bcrypt.hash("test1234", 10);
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${suiteSuffix}@test.de`,
        passwordHash: adminPasswordHash,
        role: "ADMIN",
        isActive: true,
      },
    });
    await prisma.employee.create({
      data: {
        tenantId,
        userId: adminUser.id,
        employeeNumber: `ADM-${suiteSuffix}`,
        firstName: "Admin",
        lastName: "WeekSoll",
        hireDate: new Date("2024-01-01"),
      },
    });

    const vacationType = await prisma.leaveType.create({
      data: {
        tenantId,
        name: "Urlaub",
        isPaid: true,
        requiresApproval: true,
        color: "#3B82F6",
      },
    });
    vacationTypeId = vacationType.id;

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: adminUser.email, password: "test1234" },
    });
    adminToken = JSON.parse(loginRes.body).accessToken;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  /**
   * Helper: create a fresh FIXED_WEEKLY Mo-Fr 40h employee.
   */
  async function createFixedWeeklyEmployee(label: string): Promise<string> {
    const prisma = app.prisma;
    const empUser = await prisma.user.create({
      data: {
        email: `emp-${label}-${suiteSuffix}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: empUser.id,
        employeeNumber: `FW-${label}-${suiteSuffix}`,
        firstName: `Emp${label}`,
        lastName: "WeekSoll",
        hireDate: new Date("2024-01-01"),
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        // Schema-canonical name is FIXED_SCHEDULE; the comment at apps/api/src
        // /utils/calc-expected-minutes-tz.ts treats it as "default" branch
        // (per-day {day}Hours summation) — exactly what we need for Mo-Fr 8h.
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        monthlyHours: null,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    return emp.id;
  }

  /**
   * Helper: GET /api/v1/shifts/week?date=<weekMonday>
   */
  async function getWeek(): Promise<Record<string, unknown>> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${weekMonday}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body);
  }

  // ── Test A: APPROVED Mo+Tu leave aggregates to 960 minutes ──
  it("SOLL-V19-01 A — APPROVED 2-day leave (Mo+Tu) → 960 minutes (16h × 60)", async () => {
    const employeeId = await createFixedWeeklyEmployee("A");

    // Visible week Monday + Tuesday — UTC midnight is what shifts.ts compares against.
    const monday = new Date(weekMonday + "T00:00:00Z");
    const tuesday = new Date(weekMonday + "T00:00:00Z");
    tuesday.setUTCDate(tuesday.getUTCDate() + 1);

    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: vacationTypeId,
        startDate: monday,
        endDate: tuesday,
        status: "APPROVED",
        days: 2,
        // deletedAt: null is the default
      },
    });

    const body = await getWeek();
    const leaveMap = body.leaveMinutesByEmp as Record<string, number>;
    const absenceMap = body.absenceMinutesByEmp as Record<string, number>;

    expect(leaveMap).toBeTruthy();
    expect(leaveMap[employeeId]).toBe(960); // 16h × 60 minutes
    // No absences seeded for this employee.
    expect(absenceMap[employeeId] ?? 0).toBe(0);
  });

  // ── Test B: PENDING leave is NOT counted ──
  it("SOLL-V19-01 B — PENDING leave does not reduce Soll (status filter)", async () => {
    const employeeId = await createFixedWeeklyEmployee("B");

    const monday = new Date(weekMonday + "T00:00:00Z");
    const tuesday = new Date(weekMonday + "T00:00:00Z");
    tuesday.setUTCDate(tuesday.getUTCDate() + 1);

    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: vacationTypeId,
        startDate: monday,
        endDate: tuesday,
        status: "PENDING",
        days: 2,
      },
    });

    const body = await getWeek();
    const leaveMap = body.leaveMinutesByEmp as Record<string, number>;

    // PENDING leave must NOT appear in the aggregation.
    expect(leaveMap[employeeId] ?? 0).toBe(0);
  });

  // ── Test C: Weekend (Saturday) leave does not reduce Soll ──
  it("SOLL-V19-01 C — APPROVED weekend leave (Sa) → 0 minutes (workDays excludes Sat)", async () => {
    const employeeId = await createFixedWeeklyEmployee("C");

    // Saturday = monday + 5 days
    const saturday = new Date(weekMonday + "T00:00:00Z");
    saturday.setUTCDate(saturday.getUTCDate() + 5);

    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: vacationTypeId,
        startDate: saturday,
        endDate: saturday,
        status: "APPROVED",
        days: 1,
      },
    });

    const body = await getWeek();
    const leaveMap = body.leaveMinutesByEmp as Record<string, number>;

    // saturdayHours=0 in the schedule → calcExpectedMinutesTz returns 0.
    expect(leaveMap[employeeId] ?? 0).toBe(0);
  });

  // ── Test D: Absence (deletedAt:null) counts; soft-deleted Absence does not ──
  it("SOLL-V19-01 D — Absence Mo-Tu → 960 minutes; soft-deleted Absence excluded", async () => {
    const employeeId = await createFixedWeeklyEmployee("D");

    const monday = new Date(weekMonday + "T00:00:00Z");
    const tuesday = new Date(weekMonday + "T00:00:00Z");
    tuesday.setUTCDate(tuesday.getUTCDate() + 1);

    // Live absence Mo-Tu (16h on schedule).
    await app.prisma.absence.create({
      data: {
        employeeId,
        type: "SICK",
        startDate: monday,
        endDate: tuesday,
        days: 2,
        createdBy: "SYSTEM",
      },
    });

    // Soft-deleted absence covering Wed-Thu — MUST be excluded from the aggregate.
    const wednesday = new Date(weekMonday + "T00:00:00Z");
    wednesday.setUTCDate(wednesday.getUTCDate() + 2);
    const thursday = new Date(weekMonday + "T00:00:00Z");
    thursday.setUTCDate(thursday.getUTCDate() + 3);
    await app.prisma.absence.create({
      data: {
        employeeId,
        type: "SICK",
        startDate: wednesday,
        endDate: thursday,
        days: 2,
        createdBy: "SYSTEM",
        deletedAt: new Date(),
      },
    });

    const body = await getWeek();
    const absenceMap = body.absenceMinutesByEmp as Record<string, number>;

    // Only the live Mo-Tu absence counts → 16h × 60 = 960 minutes.
    expect(absenceMap[employeeId]).toBe(960);
  });
});
