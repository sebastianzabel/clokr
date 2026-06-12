import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import type { FastifyInstance } from "fastify";
import { AbsenceType } from "@clokr/db";

/**
 * v1.7.4 hotfix — GET /api/v1/shifts/week emits schoolHoliday[] per cell.
 *
 * Covers:
 *  - Test A: AZUBI employee in a week that overlaps a SchoolHolidayPeriod gets
 *    schoolHoliday entries emitted for every (employee × in-range day).
 *  - Test B: When BOTH a VOCATIONAL_SCHOOL Absence AND a SchoolHolidayPeriod cover
 *    the same day, the BS-Absence wins the availability bucket; the schoolHoliday
 *    array still emits the holiday info so the UI's BS-wins priority is
 *    enforced on the rendering side (matches API contract: holiday data is
 *    advisory, availability classification is authoritative).
 *  - Test C (regression): Non-AZUBI employee MUST NOT receive schoolHoliday entries
 *    even when a SchoolHolidayPeriod covers the week (BBiG §15 — Schulferien are
 *    only relevant for apprentices).
 *
 * User report: "ferien sollten im schichtplan sichtbar sein".
 * v1.7.5 fix: "schulferien shown for all employees" — emit only for AZUBI.
 */
describe("GET /shifts/week — SchoolHolidayPeriod (v1.7.4 hotfix)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // Pick an arbitrary future week to avoid Phase 47.2 past-immutable gates in
  // any code paths that look at it (week math itself is past-safe; this is
  // just defensive). Mo=2026-09-14..So=2026-09-20.
  const TEST_WEEK_START = "2026-09-14";
  const HOLIDAY_TUESDAY = "2026-09-15";
  const HOLIDAY_WEDNESDAY = "2026-09-16";

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "sh-week");

    // Phase 47.1 — shift endpoints filter to SHIFT_BASED employees only.
    await app.prisma.workSchedule.create({
      data: {
        employeeId: data.employee.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        validFrom: new Date("2024-02-01"),
      },
    });

    // v1.7.5 fix — schoolHoliday is only emitted for AZUBI employees (BBiG §15).
    // Mark the default test employee as AZUBI so Tests A + B can assert emission.
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { classification: "AZUBI" },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // Cleanup any holiday + absence rows between tests so the cases stay isolated.
  beforeEach(async () => {
    await app.prisma.schoolHolidayPeriod.deleteMany({ where: { tenantId: data.tenant.id } });
    await app.prisma.absence.deleteMany({ where: { employeeId: data.employee.id } });
  });

  // ── Test A: SchoolHolidayPeriod surfaces in /week response ─────────────────
  it("emits schoolHoliday entries for every cell inside the cached holiday range", async () => {
    // Seed a 2-day holiday period (Tue + Wed of TEST_WEEK_START's week) for the
    // tenant's default Bundesland (NIEDERSACHSEN — see setup.ts).
    await app.prisma.schoolHolidayPeriod.create({
      data: {
        tenantId: data.tenant.id,
        federalState: "NIEDERSACHSEN",
        startDate: new Date(HOLIDAY_TUESDAY + "T00:00:00Z"),
        endDate: new Date(HOLIDAY_WEDNESDAY + "T00:00:00Z"),
        name: "Herbstferien-Test",
        source: "MANUAL",
        fetchedAt: new Date(),
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${TEST_WEEK_START}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as {
      schoolHoliday: Array<{
        employeeId: string;
        date: string;
        name: string;
        federalState: string;
      }>;
    };
    expect(Array.isArray(body.schoolHoliday)).toBe(true);

    // The employee row should have schoolHoliday entries on Tue + Wed.
    const empEntries = body.schoolHoliday.filter((e) => e.employeeId === data.employee.id);
    const tueEntry = empEntries.find((e) => e.date === HOLIDAY_TUESDAY);
    const wedEntry = empEntries.find((e) => e.date === HOLIDAY_WEDNESDAY);

    expect(tueEntry).toBeDefined();
    expect(tueEntry?.name).toBe("Herbstferien-Test");
    expect(tueEntry?.federalState).toBe("NIEDERSACHSEN");

    expect(wedEntry).toBeDefined();
    expect(wedEntry?.name).toBe("Herbstferien-Test");

    // Days OUTSIDE the holiday range must NOT carry a schoolHoliday entry.
    const monEntry = empEntries.find((e) => e.date === "2026-09-14");
    const thuEntry = empEntries.find((e) => e.date === "2026-09-17");
    expect(monEntry).toBeUndefined();
    expect(thuEntry).toBeUndefined();
  });

  // ── Test B: BS-Absence wins availability; holiday data still surfaces ──────
  it("BS-Absence + SchoolHolidayPeriod on same day: availability stays vocational_school", async () => {
    // Seed both: a VOCATIONAL_SCHOOL Absence AND a SchoolHolidayPeriod covering
    // the same Tuesday. The BS-Absence is the manual/managed signal so it must
    // continue to drive the availability classification (UI uses this to render
    // the BS-cell instead of the Ferien marker — display priority lives on the
    // client).
    await app.prisma.absence.create({
      data: {
        employeeId: data.employee.id,
        type: AbsenceType.VOCATIONAL_SCHOOL,
        startDate: new Date(HOLIDAY_TUESDAY + "T00:00:00Z"),
        endDate: new Date(HOLIDAY_TUESDAY + "T00:00:00Z"),
        days: 1,
        createdBy: data.adminUser.id,
      },
    });
    await app.prisma.schoolHolidayPeriod.create({
      data: {
        tenantId: data.tenant.id,
        federalState: "NIEDERSACHSEN",
        startDate: new Date(HOLIDAY_TUESDAY + "T00:00:00Z"),
        endDate: new Date(HOLIDAY_TUESDAY + "T00:00:00Z"),
        name: "Herbstferien-Test",
        source: "MANUAL",
        fetchedAt: new Date(),
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${TEST_WEEK_START}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as {
      availability: Array<{ employeeId: string; date: string; availability: string }>;
      schoolHoliday: Array<{
        employeeId: string;
        date: string;
        name: string;
        federalState: string;
      }>;
    };

    // Availability classification: BS wins.
    const avEntry = body.availability.find(
      (a) => a.employeeId === data.employee.id && a.date === HOLIDAY_TUESDAY,
    );
    expect(avEntry?.availability).toBe("vocational_school");

    // schoolHoliday data is STILL emitted (advisory) — the API contract is that
    // the UI decides which marker to render. The current frontend renders BS on
    // this cell and never enters the empty-cell branch where the Ferien badge
    // lives, so users see "Berufsschule" (not "Ferien"). That priority is
    // covered by the frontend snapshot/visual test layer, not here.
    const hEntry = body.schoolHoliday.find(
      (e) => e.employeeId === data.employee.id && e.date === HOLIDAY_TUESDAY,
    );
    expect(hEntry).toBeDefined();
    expect(hEntry?.name).toBe("Herbstferien-Test");
  });

  // ── Test C: Non-AZUBI employees MUST NOT receive schoolHoliday entries ──────
  it("does not emit schoolHoliday for non-AZUBI employees (BBiG §15 regression)", async () => {
    // Temporarily reclassify the employee to VOLLZEIT (non-AZUBI) to verify
    // the guard. VOLLZEIT is the schema default and a representative non-AZUBI
    // classification (BBiG §15 only applies to AZUBI).
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { classification: "VOLLZEIT" },
    });

    await app.prisma.schoolHolidayPeriod.create({
      data: {
        tenantId: data.tenant.id,
        federalState: "NIEDERSACHSEN",
        startDate: new Date(HOLIDAY_TUESDAY + "T00:00:00Z"),
        endDate: new Date(HOLIDAY_WEDNESDAY + "T00:00:00Z"),
        name: "Herbstferien-Test",
        source: "MANUAL",
        fetchedAt: new Date(),
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?date=${TEST_WEEK_START}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as {
      schoolHoliday: Array<{ employeeId: string; date: string }>;
    };
    // Non-AZUBI employee must produce zero schoolHoliday entries.
    const empEntries = body.schoolHoliday.filter((e) => e.employeeId === data.employee.id);
    expect(empEntries).toHaveLength(0);

    // Restore AZUBI classification for subsequent tests.
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { classification: "AZUBI" },
    });
  });
});
