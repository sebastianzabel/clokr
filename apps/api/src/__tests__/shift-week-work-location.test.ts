/**
 * Phase 71b Plan 03 Task 2 (issue #71, D-07/AC-11) — the shift week view's LEGAL holidays
 * (`contractSollMinutesByEmp`) now follow the employee's WORK LOCATION (§ 2 EFZG) per day, not
 * the Berufsschule `federalStateOverride`. School holidays (Block A, `schoolHoliday` output,
 * `resolveHoliday`) are UNCHANGED — they stay governed by `federalStateOverride`.
 *
 * Fronleichnam 2026 = Thursday 2026-06-04 (BAYERN, not NIEDERSACHSEN) — June 2026 carries no
 * NIEDERSACHSEN statutory holiday. Week of 2026-06-01 = Mon 06-01 .. Sun 06-07.
 *
 * Shared SHIFT_BASED schedule (38h, Mon–Fri, 7.6h/day) — same shape and numbers as
 * soll-korrelation-display.test.ts's AZUBI_SCHEDULE: full week Soll = 2280 min, one day = 456 min.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";

const WEEK_MONDAY = "2026-06-01";
const FRONLEICHNAM = "2026-06-04"; // Thursday

const SHIFT_BASED_SCHEDULE = {
  type: "SHIFT_BASED" as const,
  weeklyHours: 38,
  mondayHours: 7.6,
  tuesdayHours: 7.6,
  wednesdayHours: 7.6,
  thursdayHours: 7.6,
  fridayHours: 7.6,
  saturdayHours: 0,
  sundayHours: 0,
  workDays: [1, 2, 3, 4, 5],
  validFrom: new Date("2024-01-01"),
};

const FULL_WEEK_SOLL_MIN = 2280;
const REDUCED_BY_ONE_DAY_SOLL_MIN = 1824;

describe("GET /shifts/week — legal holidays by work location (Phase 71b Plan 03 Task 2, issue #71, D-07/AC-11)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let salonNiId: string; // NIEDERSACHSEN, created FIRST — the tenant's default salon
  let salonById: string; // BAYERN
  let azubiId: string; // SHIFT_BASED, HOME NI, federalStateOverride BAYERN
  let deployedId: string; // SHIFT_BASED, HOME NI + DEPLOYMENT BY on Thursdays
  let entryBeatsId: string; // SHIFT_BASED, HOME BY, closed WORK entry on Fronleichnam AT NI

  async function createShiftBasedEmployee(label: string, suffix: string) {
    const user = await app.prisma.user.create({
      data: {
        email: `swwl-${label}-${suffix}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `SWWL-${label}-${suffix}`,
        firstName: label,
        lastName: "WorkLocation",
        hireDate: new Date("2024-01-01"),
        classification: "AZUBI",
        breakOver6hOverride: 0,
        breakOver9hOverride: 0,
      },
    });
    await app.prisma.workSchedule.create({
      data: { employeeId: employee.id, ...SHIFT_BASED_SCHEDULE },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    return employee;
  }

  beforeAll(async () => {
    app = await getTestApp();
    const seed = await seedTestData(app, "swwl", { withDefaultSalon: false });
    tenantId = seed.tenant.id;
    adminToken = seed.adminToken;

    salonNiId = (await createTestSalon(app.prisma, tenantId, { federalState: "NIEDERSACHSEN" })).id;
    salonById = (await createTestSalon(app.prisma, tenantId, { federalState: "BAYERN" })).id;

    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    // ── azubi: HOME NI, federalStateOverride BAYERN (Berufsschule only — must NOT drive the
    // legal-holiday reduction any more) ────────────────────────────────────────────────────
    const azubi = await createShiftBasedEmployee("azubi", suffix);
    azubiId = azubi.id;
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId: azubiId,
        salonId: salonNiId,
        kind: "HOME",
        validFrom: new Date("2024-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: azubiId,
        federalStateOverride: "BAYERN",
        isActive: true,
        validFrom: new Date("2024-01-01"),
        validUntil: null,
        daysOfWeek: [2], // Tue — placeholder, only federalStateOverride/school holidays matter here
        blockWeeks: [],
      },
    });

    // ── deployed: HOME NI + DEPLOYMENT BY on Thursdays — no TimeEntry at all (a future/roster
    // day resolves purely through the salon assignment, D-07's literal fallback chain) ──────
    const deployed = await createShiftBasedEmployee("deployed", suffix);
    deployedId = deployed.id;
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId: deployedId,
        salonId: salonNiId,
        kind: "HOME",
        validFrom: new Date("2024-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId: deployedId,
        salonId: salonById,
        kind: "DEPLOYMENT",
        validFrom: new Date("2024-01-01"),
        validUntil: null,
        weekdays: [3], // Thursday (0 = Monday)
      },
    });

    // ── entryBeats: HOME BY (would otherwise see Fronleichnam), but a CLOSED work entry on
    // Fronleichnam itself is recorded on the NI salon — the entry must beat the assignment ──
    const entryBeats = await createShiftBasedEmployee("entrybeats", suffix);
    entryBeatsId = entryBeats.id;
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId: entryBeatsId,
        salonId: salonById,
        kind: "HOME",
        validFrom: new Date("2024-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
    await app.prisma.timeEntry.create({
      data: {
        employeeId: entryBeatsId,
        date: new Date(FRONLEICHNAM),
        startTime: new Date(`${FRONLEICHNAM}T08:00:00Z`),
        endTime: new Date(`${FRONLEICHNAM}T16:00:00Z`),
        type: "WORK",
        salonId: salonNiId,
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("shift-week-work-location cleanup failed:", err);
    }
  });

  async function getWeek() {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${WEEK_MONDAY}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as {
      contractSollMinutesByEmp?: Record<string, number>;
      schoolHoliday?: Array<{
        employeeId: string;
        date: string;
        name: string;
        federalState: string;
      }>;
    };
  }

  it("D-07/AC-11: an AZUBI's federalStateOverride no longer drives legal-holiday reduction — their HOME salon (NIEDERSACHSEN) does, so the week's Soll is the FULL week", async () => {
    const body = await getWeek();
    expect(body.contractSollMinutesByEmp?.[azubiId]).toBe(FULL_WEEK_SOLL_MIN);
  });

  it("Block A untouched: a BAYERN SchoolHolidayPeriod covering the week still resolves via federalStateOverride for the AZUBI", async () => {
    await app.prisma.schoolHolidayPeriod.create({
      data: {
        tenantId,
        federalState: "BAYERN",
        startDate: new Date("2026-05-25"),
        endDate: new Date("2026-06-05"),
        name: "Pfingstferien (WR test)",
        source: "MANUAL",
        fetchedAt: new Date(),
      },
    });
    try {
      const body = await getWeek();
      const azubiSchoolDays = (body.schoolHoliday ?? []).filter((e) => e.employeeId === azubiId);
      expect(azubiSchoolDays.length).toBeGreaterThan(0);
      expect(azubiSchoolDays.every((e) => e.federalState === "BAYERN")).toBe(true);
    } finally {
      await app.prisma.schoolHolidayPeriod.deleteMany({
        where: { tenantId, name: "Pfingstferien (WR test)" },
      });
    }
  });

  it("a DEPLOYMENT to BAYERN on Thursdays reduces the week's Soll by one day, with no TimeEntry needed", async () => {
    const body = await getWeek();
    expect(body.contractSollMinutesByEmp?.[deployedId]).toBe(REDUCED_BY_ONE_DAY_SOLL_MIN);
  });

  it("D-07 literal: a closed work entry on the holiday itself beats the HOME salon assignment", async () => {
    const body = await getWeek();
    expect(body.contractSollMinutesByEmp?.[entryBeatsId]).toBe(FULL_WEEK_SOLL_MIN);
  });
});
