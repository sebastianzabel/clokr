/**
 * Issue #493 (R3/R5, D-08/D-10) — the dashboard counts only its own week and month.
 *
 * `GET /dashboard` read the worked-entry `@db.Date` column with `weekRangeUtc`/`monthRangeUtc`
 * INSTANTS. For a Europe/Berlin tenant the instant of local Monday 00:00 is the previous
 * Sunday 22:00Z (summer), which satisfies `date >= start` for the Sunday row — so the previous
 * week's Sunday leaked into `week.workedHours` (F-11), and the previous month's last day leaked
 * into a MONTHLY_HOURS `month.workedHours`.
 *
 * Fixed clock: Wed 2026-10-07T10:00:00Z (CEST). Only `Date` is faked.
 *
 * Neutrality block (green before AND after the fix, literals captured on the unfixed tree):
 *   - week.workedToDateHours / week.targetHours and the MONTHLY_HOURS month.targetHours (F-12:
 *     the Soll inputs keep their instants on purpose),
 *   - the per-day response of /my-week and /team-week (F-13/F-14: the per-day mapping already
 *     filters by calendar day, so the bound switch is response-neutral).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  reissueTokenNow,
} from "../../__tests__/setup";

const FAKE_NOW = new Date("2026-10-07T10:00:00Z");

describe("Issue #493 — dashboard week/month boundaries", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;
  let monthlyEmployeeId = "";
  let monthlyToken = "";

  async function entry(employeeId: string, day: string, start: string, end: string) {
    await app.prisma.timeEntry.create({
      data: {
        employeeId,
        date: new Date(`${day}T00:00:00Z`),
        startTime: new Date(`${day}T${start}:00Z`),
        endTime: new Date(`${day}T${end}:00Z`),
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
        salonId: d.salonId,
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "dbm493");
    const prisma = app.prisma;

    // FIXED employee (the seeded one): Sun 04.10. belongs to the PREVIOUS week.
    await entry(d.employee.id, "2026-10-04", "08:00", "10:00");
    await entry(d.employee.id, "2026-10-05", "06:00", "08:00");
    await entry(d.employee.id, "2026-10-06", "06:00", "08:00");

    // MONTHLY_HOURS employee: 30.09. belongs to the previous month.
    const passwordHash = await bcrypt.hash("test1234", 10);
    const email = `monthly-dbm493-${Date.now().toString(36)}@test.de`;
    const user = await prisma.user.create({
      data: { email, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await prisma.employee.create({
      data: {
        tenantId: d.tenant.id,
        userId: user.id,
        employeeNumber: `MH-dbm493-${Date.now().toString(36)}`,
        firstName: "Monthly",
        lastName: "Dbm493",
        hireDate: new Date("2025-01-01T00:00:00Z"),
      },
    });
    monthlyEmployeeId = employee.id;
    await prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "MONTHLY_HOURS",
        monthlyHours: 40,
        weeklyHours: null,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2025-01-01T00:00:00Z"),
      } as never,
    });
    await prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    await entry(employee.id, "2026-09-30", "19:44", "20:42");
    await entry(employee.id, "2026-10-01", "06:00", "08:00");

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: "test1234" },
    });
    monthlyToken = JSON.parse(login.body).accessToken;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, d.tenant.id);
    } catch (err) {
      console.error("dashboard-month-boundary-493 cleanup failed:", err);
    }
    await closeTestApp();
  });

  /** Runs one GET inside the faked clock with a token re-issued at the faked "now". */
  async function getAt(url: string, token: string): Promise<Record<string, any>> {
    vi.useFakeTimers({ now: FAKE_NOW, toFake: ["Date"] });
    try {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${reissueTokenNow(app, token)}` },
      });
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body);
    } finally {
      vi.useRealTimers();
    }
  }

  describe("GET /dashboard", () => {
    it("week.workedHours excludes the previous week's Sunday", async () => {
      const body = await getAt("/api/v1/dashboard", d.empToken);
      expect(body.periodType).toBe("week");
      expect(body.week.workedHours).toBe(4);
    });

    it("MONTHLY_HOURS month.workedHours excludes the previous month's last day", async () => {
      const body = await getAt("/api/v1/dashboard", monthlyToken);
      expect(body.periodType).toBe("month");
      expect(body.month.workedHours).toBe(2);
    });

    it("neutrality: week to-date pair and Soll inputs equal the unfixed-tree literals", async () => {
      const body = await getAt("/api/v1/dashboard", d.empToken);
      expect({
        targetHours: body.week.targetHours,
        workedToDateHours: body.week.workedToDateHours,
        targetToDateHours: body.week.targetToDateHours,
      }).toEqual({ targetHours: 40, workedToDateHours: 4, targetToDateHours: 16 });
    });

    it("neutrality: MONTHLY_HOURS month.targetHours equals the unfixed-tree literal", async () => {
      const body = await getAt("/api/v1/dashboard", monthlyToken);
      expect(body.month.targetHours).toBe(40);
      expect(monthlyEmployeeId).not.toBe("");
    });
  });

  // [date, workedHours, expectedHours, status] per weekday — captured on the unfixed tree.
  const MY_WEEK: Record<string, unknown[][]> = {
    "2026-10-07": [
      ["2026-10-05", 2, 8, "partial"],
      ["2026-10-06", 2, 8, "partial"],
      ["2026-10-07", 0, 8, "scheduled"],
      ["2026-10-08", 0, 8, "scheduled"],
      ["2026-10-09", 0, 8, "scheduled"],
      ["2026-10-10", 0, 0, "weekend"],
      ["2026-10-11", 0, 0, "weekend"],
    ],
    "2026-10-04": [
      ["2026-09-28", 0, 8, "missing"],
      ["2026-09-29", 0, 8, "missing"],
      ["2026-09-30", 0, 8, "missing"],
      ["2026-10-01", 0, 8, "missing"],
      ["2026-10-02", 0, 8, "missing"],
      ["2026-10-03", 0, 0, "holiday"],
      ["2026-10-04", 2, 0, "complete"],
    ],
  };
  const TEAM_WEEK: Record<string, unknown[][]> = {
    "2026-10-07": [
      ["2026-10-05", 2, 8, "present"],
      ["2026-10-06", 2, 8, "present"],
      ["2026-10-07", 0, 8, "scheduled"],
      ["2026-10-08", 0, 8, "scheduled"],
      ["2026-10-09", 0, 8, "scheduled"],
      ["2026-10-10", 0, 0, "none"],
      ["2026-10-11", 0, 0, "none"],
    ],
    "2026-10-04": [
      ["2026-09-28", 0, 8, "missing"],
      ["2026-09-29", 0, 8, "missing"],
      ["2026-09-30", 0, 8, "missing"],
      ["2026-10-01", 0, 8, "missing"],
      ["2026-10-02", 0, 8, "missing"],
      ["2026-10-03", 0, 0, "holiday"],
      ["2026-10-04", 2, 0, "present"],
    ],
  };

  describe("GET /dashboard/my-week (neutrality, F-14)", () => {
    for (const date of ["2026-10-07", "2026-10-04"]) {
      it(`per-day values for ?date=${date} equal the unfixed-tree literals`, async () => {
        const body = await getAt(`/api/v1/dashboard/my-week?date=${date}`, d.empToken);
        expect(
          body.days.map((x: any) => [x.date, x.workedHours, x.expectedHours, x.status]),
        ).toEqual(MY_WEEK[date]);
      });
    }
  });

  describe("GET /dashboard/team-week (neutrality, F-13)", () => {
    for (const date of ["2026-10-07", "2026-10-04"]) {
      it(`per-day values of the FIXED employee for ?date=${date} equal the unfixed-tree literals`, async () => {
        const body = await getAt(`/api/v1/dashboard/team-week?date=${date}`, d.adminToken);
        const row = body.team.find((t: any) => t.id === d.employee.id);
        expect(row).toBeDefined();
        expect(
          row.days.map((x: any) => [x.date, x.workedHours, x.expectedHours, x.status]),
        ).toEqual(TEAM_WEEK[date]);
      });
    }
  });
});
