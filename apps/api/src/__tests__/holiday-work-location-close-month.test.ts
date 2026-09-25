/**
 * Phase 71b Plan 05 (issue #71, AC-4/AC-5 at the Monatsabschluss readers) — the gap definition
 * (`detectMonthGaps`, `month-gap-check.ts`) now resolves statutory holidays by WORK LOCATION
 * (§ 2 EFZG) through the Unterbau's central resolver instead of a tenant-wide federal state.
 *
 * Fronleichnam 2026 = Thursday 2026-06-04 (BAYERN, not NIEDERSACHSEN) — June 2026 carries no
 * NIEDERSACHSEN statutory holiday otherwise. Salon B (NIEDERSACHSEN) is created FIRST — the
 * tenant's default salon; salon A (BAYERN) second.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { detectMonthGaps } from "../contexts/working-time-account/month-gap-check";
import { getDeferredMonthCloseState } from "../contexts/working-time-account/deferred-month-close";

const JUNE_2026 = { year: 2026, month: 6 };

describe("Monatsabschluss gap definition by work location (Phase 71b Plan 05, issue #71)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let salonAId: string; // BAYERN
  let salonBId: string; // NIEDERSACHSEN — tenant default (created first)
  let depId: string; // HOME B + DEPLOYMENT A Thursdays, no entry on 06-04
  let ctlId: string; // HOME B only, no entry on 06-04 — control
  let depEntryId: string; // HOME B + DEPLOYMENT A Thursdays, entry present on 06-04 (removed mid-test)

  const schedule = {
    type: "FIXED_SCHEDULE",
    mondayHours: 8,
    tuesdayHours: 8,
    wednesdayHours: 8,
    thursdayHours: 8,
    fridayHours: 8,
    saturdayHours: 0,
    sundayHours: 0,
    workDays: [1, 2, 3, 4, 5],
  };

  // June 2026 workdays (Mo-Fr): 1,2,3,4,5,8,9,10,11,12,15,16,17,18,19,22,23,24,25,26,29,30
  const JUNE_WORKDAYS = [
    "2026-06-01",
    "2026-06-02",
    "2026-06-03",
    "2026-06-04",
    "2026-06-05",
    "2026-06-08",
    "2026-06-09",
    "2026-06-10",
    "2026-06-11",
    "2026-06-12",
    "2026-06-15",
    "2026-06-16",
    "2026-06-17",
    "2026-06-18",
    "2026-06-19",
    "2026-06-22",
    "2026-06-23",
    "2026-06-24",
    "2026-06-25",
    "2026-06-26",
    "2026-06-29",
    "2026-06-30",
  ];

  beforeAll(async () => {
    app = await getTestApp();
    const seed = await seedTestData(app, "hwlcm", { withDefaultSalon: false });
    tenantId = seed.tenant.id;

    const salonB = await createTestSalon(app.prisma, tenantId, { federalState: "NIEDERSACHSEN" });
    salonBId = salonB.id;
    const salonA = await createTestSalon(app.prisma, tenantId, { federalState: "BAYERN" });
    salonAId = salonA.id;

    const passwordHash = await bcrypt.hash("test1234", 10);

    async function createEmployee(label: string) {
      const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const user = await app.prisma.user.create({
        data: {
          email: `hwlcm-${label}-${suffix}@test.de`,
          passwordHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const employee = await app.prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: `HWLCM-${label}-${suffix}`,
          firstName: label,
          lastName: "GapCheck",
          hireDate: new Date("2026-06-01"),
        },
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
          validFrom: new Date("2026-06-01"),
        },
      });
      return employee;
    }

    async function assignHome(employeeId: string, salonId: string) {
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId,
          employeeId,
          salonId,
          kind: "HOME",
          validFrom: new Date("2026-06-01"),
          validUntil: null,
          weekdays: [],
        },
      });
    }
    async function assignDeployment(employeeId: string, salonId: string, weekdays: number[]) {
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId,
          employeeId,
          salonId,
          kind: "DEPLOYMENT",
          validFrom: new Date("2026-06-01"),
          validUntil: null,
          weekdays,
        },
      });
    }
    async function createEntry(employeeId: string, dateStr: string, salonId: string) {
      await app.prisma.timeEntry.create({
        data: {
          employeeId,
          date: new Date(`${dateStr}T00:00:00Z`),
          startTime: new Date(`${dateStr}T08:00:00Z`),
          endTime: new Date(`${dateStr}T16:00:00Z`),
          breakMinutes: 0,
          type: "WORK",
          salonId,
        },
      });
    }

    const dep = await createEmployee("dep");
    depId = dep.id;
    await assignHome(depId, salonBId);
    await assignDeployment(depId, salonAId, [3]); // Thursday (0 = Monday)
    for (const d of JUNE_WORKDAYS) {
      if (d === "2026-06-04") continue; // Fronleichnam — no entry, resolved via DEPLOYMENT
      await createEntry(depId, d, salonBId);
    }

    const ctl = await createEmployee("ctl");
    ctlId = ctl.id;
    await assignHome(ctlId, salonBId);
    for (const d of JUNE_WORKDAYS) {
      if (d === "2026-06-04") continue;
      await createEntry(ctlId, d, salonBId);
    }

    const depEntry = await createEmployee("depentry");
    depEntryId = depEntry.id;
    await assignHome(depEntryId, salonBId);
    await assignDeployment(depEntryId, salonAId, [3]);
    for (const d of JUNE_WORKDAYS) {
      await createEntry(depEntryId, d, salonBId);
    }
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("holiday-work-location-close-month cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("a Thursday DEPLOYMENT to the Bavarian salon closes the Fronleichnam gap — no entry needed", async () => {
    const res = await detectMonthGaps(app.prisma, {
      tenantId,
      employeeId: depId,
      hireDate: new Date("2026-06-01"),
      schedule,
      month: JUNE_2026,
      tz: "Europe/Berlin",
    });
    expect(res.gapRuleApplies).toBe(true);
    expect(res.gapDates).toEqual([]);
  });

  it("without the deployment, 2026-06-04 IS a gap (HOME salon is NIEDERSACHSEN, no statutory holiday)", async () => {
    const res = await detectMonthGaps(app.prisma, {
      tenantId,
      employeeId: ctlId,
      hireDate: new Date("2026-06-01"),
      schedule,
      month: JUNE_2026,
      tz: "Europe/Berlin",
    });
    expect(res.gapRuleApplies).toBe(true);
    expect(res.gapDates).toEqual(["2026-06-04"]);
  });

  it("a closed entry on 2026-06-04 makes the day covered regardless of the holiday question", async () => {
    const res = await detectMonthGaps(app.prisma, {
      tenantId,
      employeeId: depEntryId,
      hireDate: new Date("2026-06-01"),
      schedule,
      month: JUNE_2026,
      tz: "Europe/Berlin",
    });
    expect(res.gapRuleApplies).toBe(true);
    expect(res.gapDates).toEqual([]);
  });

  it("removing that entry: the day becomes a holiday again via the DEPLOYMENT fallback — still no gap (entry-free path)", async () => {
    await app.prisma.timeEntry.deleteMany({
      where: { employeeId: depEntryId, date: new Date("2026-06-04T00:00:00Z") },
    });
    const res = await detectMonthGaps(app.prisma, {
      tenantId,
      employeeId: depEntryId,
      hireDate: new Date("2026-06-01"),
      schedule,
      month: JUNE_2026,
      tz: "Europe/Berlin",
    });
    expect(res.gapRuleApplies).toBe(true);
    expect(res.gapDates).toEqual([]);
  });

  it("getDeferredMonthCloseState lists the non-deployed employee's 2026-06-04 gap and not the deployed one's", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-10T10:00:00.000Z"));
    try {
      const state = await getDeferredMonthCloseState(app.prisma, tenantId, {
        detailed: true,
        now: new Date("2026-07-10T10:00:00.000Z"),
      });
      const ctlEntry = state.employees.find((e) => e.employeeId === ctlId);
      const depEntry = state.employees.find((e) => e.employeeId === depId);
      // Both employees are still unclosed for June (no SaldoSnapshot was created in this
      // fixture), but only the non-deployed one's oldest open month has an actual GAP —
      // the deployed one's Fronleichnam is covered via the work-location resolver.
      expect(ctlEntry?.gapDates).toEqual(["2026-06-04"]);
      expect(ctlEntry?.reason).toBe("GAPS");
      expect(depEntry?.gapDates).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Monatsabschluss close paths by work location (Phase 71b Plan 05 Task 3, issue #71)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let vacationTypeId: string;
  let salonAId: string; // BAYERN
  let salonBId: string; // NIEDERSACHSEN — tenant default (created first)
  let closeDepId: string; // HOME B + DEPLOYMENT A Thursdays, no leave, no entry on 06-04
  let closeDepLeaveId: string; // HOME B + DEPLOYMENT A Thursdays, APPROVED VACATION 06-01..05
  let closeCtlLeaveId: string; // HOME B only, APPROVED VACATION 06-01..05
  let cronDepId: string; // same as closeDepId, closed via the auto-close cron instead

  const JUNE_WORKDAYS_T3 = [
    "2026-06-01",
    "2026-06-02",
    "2026-06-03",
    "2026-06-04",
    "2026-06-05",
    "2026-06-08",
    "2026-06-09",
    "2026-06-10",
    "2026-06-11",
    "2026-06-12",
    "2026-06-15",
    "2026-06-16",
    "2026-06-17",
    "2026-06-18",
    "2026-06-19",
    "2026-06-22",
    "2026-06-23",
    "2026-06-24",
    "2026-06-25",
    "2026-06-26",
    "2026-06-29",
    "2026-06-30",
  ];
  const LEAVE_DAYS_T3 = new Set([
    "2026-06-01",
    "2026-06-02",
    "2026-06-03",
    "2026-06-04",
    "2026-06-05",
  ]);

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-10T10:00:00.000Z"));

    app = await getTestApp();
    const seed = await seedTestData(app, "hwlcm3", { withDefaultSalon: false });
    tenantId = seed.tenant.id;
    adminToken = seed.adminToken;
    vacationTypeId = seed.vacationType.id;

    const salonB = await createTestSalon(app.prisma, tenantId, { federalState: "NIEDERSACHSEN" });
    salonBId = salonB.id;
    const salonA = await createTestSalon(app.prisma, tenantId, { federalState: "BAYERN" });
    salonAId = salonA.id;

    const passwordHash = await bcrypt.hash("test1234", 10);

    async function createEmployee(label: string) {
      const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const user = await app.prisma.user.create({
        data: {
          email: `hwlcm3-${label}-${suffix}@test.de`,
          passwordHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const employee = await app.prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: `HWLCM3-${label}-${suffix}`,
          firstName: label,
          lastName: "CloseByWorkLocation",
          hireDate: new Date("2026-06-01"),
        },
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
          validFrom: new Date("2026-06-01"),
        },
      });
      await app.prisma.overtimeAccount.create({
        data: { employeeId: employee.id, balanceHours: 0 },
      });
      return employee;
    }
    async function assignHome(employeeId: string, salonId: string) {
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId,
          employeeId,
          salonId,
          kind: "HOME",
          validFrom: new Date("2026-06-01"),
          validUntil: null,
          weekdays: [],
        },
      });
    }
    async function assignDeployment(employeeId: string, salonId: string, weekdays: number[]) {
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId,
          employeeId,
          salonId,
          kind: "DEPLOYMENT",
          validFrom: new Date("2026-06-01"),
          validUntil: null,
          weekdays,
        },
      });
    }
    async function createEntry(employeeId: string, dateStr: string, salonId: string) {
      await app.prisma.timeEntry.create({
        data: {
          employeeId,
          date: new Date(`${dateStr}T00:00:00Z`),
          startTime: new Date(`${dateStr}T08:00:00Z`),
          endTime: new Date(`${dateStr}T16:00:00Z`),
          breakMinutes: 0,
          type: "WORK",
          salonId,
        },
      });
    }
    async function createApprovedLeave(employeeId: string, startDate: string, endDate: string) {
      await app.prisma.leaveRequest.create({
        data: {
          employeeId,
          leaveTypeId: vacationTypeId,
          startDate: new Date(`${startDate}T00:00:00Z`),
          endDate: new Date(`${endDate}T00:00:00Z`),
          days: 5,
          halfDay: false,
          status: "APPROVED",
        },
      });
    }

    // closeDepId: deployed to BAYERN Thursdays, no leave, no entry on Fronleichnam.
    const closeDep = await createEmployee("closedep");
    closeDepId = closeDep.id;
    await assignHome(closeDepId, salonBId);
    await assignDeployment(closeDepId, salonAId, [3]);
    for (const d of JUNE_WORKDAYS_T3) {
      if (d === "2026-06-04") continue;
      await createEntry(closeDepId, d, salonBId);
    }

    // closeDepLeaveId: same assignments, plus an APPROVED VACATION spanning Fronleichnam.
    const closeDepLeave = await createEmployee("closedepleave");
    closeDepLeaveId = closeDepLeave.id;
    await assignHome(closeDepLeaveId, salonBId);
    await assignDeployment(closeDepLeaveId, salonAId, [3]);
    await createApprovedLeave(closeDepLeaveId, "2026-06-01", "2026-06-05");
    for (const d of JUNE_WORKDAYS_T3) {
      if (LEAVE_DAYS_T3.has(d)) continue;
      await createEntry(closeDepLeaveId, d, salonBId);
    }

    // closeCtlLeaveId: HOME B only (never deployed), same leave — control for the leave case.
    const closeCtlLeave = await createEmployee("closectlleave");
    closeCtlLeaveId = closeCtlLeave.id;
    await assignHome(closeCtlLeaveId, salonBId);
    await createApprovedLeave(closeCtlLeaveId, "2026-06-01", "2026-06-05");
    for (const d of JUNE_WORKDAYS_T3) {
      if (LEAVE_DAYS_T3.has(d)) continue;
      await createEntry(closeCtlLeaveId, d, salonBId);
    }

    // cronDepId: identical fixture to closeDepId, closed via the auto-close cron instead.
    const cronDep = await createEmployee("crondep");
    cronDepId = cronDep.id;
    await assignHome(cronDepId, salonBId);
    await assignDeployment(cronDepId, salonAId, [3]);
    for (const d of JUNE_WORKDAYS_T3) {
      if (d === "2026-06-04") continue;
      await createEntry(cronDepId, d, salonBId);
    }
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("holiday-work-location-close-month (Task 3) cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function closeMonth(employeeId: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/overtime/close-month",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { employeeId, year: 2026, month: 6 },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body) as { expectedMinutes: number };
  }

  it("POST /close-month: a Thursday DEPLOYMENT to Bavaria closes Fronleichnam — 10080, not 10560", async () => {
    const result = await closeMonth(closeDepId);
    expect(result.expectedMinutes).toBe(10080);
  });

  it("POST /close-month: a leave request spanning the work-location holiday reduces Soll exactly once (8160), whether deployed or not", async () => {
    const depResult = await closeMonth(closeDepLeaveId);
    const ctlResult = await closeMonth(closeCtlLeaveId);
    expect(depResult.expectedMinutes).toBe(8160);
    expect(ctlResult.expectedMinutes).toBe(8160);
  });

  it("the auto-close cron closes June for a deployed employee with the SAME expectedMinutes as the manual close (10080)", async () => {
    vi.setSystemTime(new Date("2026-07-10T10:00:00.000Z"));
    await app.tryAutoCloseMonth();

    const snap = await app.prisma.saldoSnapshot.findFirst({
      where: { employeeId: cronDepId, periodType: "MONTHLY", superseded: false },
      orderBy: { periodStart: "desc" },
    });
    expect(snap).not.toBeNull();
    expect(snap?.expectedMinutes).toBe(10080);
  });
});
