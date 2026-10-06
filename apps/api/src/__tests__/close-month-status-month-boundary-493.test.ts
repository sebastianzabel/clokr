/**
 * Issue #493 (R3/R5, D-02/D-08, F-18) — the close-month status reads the month's own days.
 *
 * `fetchCloseMonthData` fed Q2 (entries), Q3 (leave) and Q4 (absences) — all `@db.Date` reads —
 * with `monthRangeUtc` INSTANTS. The instant of local Oct 1 00:00 in Europe/Berlin is
 * 2025-09-30T22:00Z; Postgres compares a `date` column with the UTC DATE of that instant, so the
 * 30.09. AUTO-break entry showed up in October's `unconfirmedBreakDays`.
 *
 * Q1 (the snapshot lookup on `SaldoSnapshot.periodStart`) stays on the instants on purpose
 * (D-02) — `close-month-status-snapshot-attribution.test.ts` pins that and is unedited.
 *
 * Neutrality block: `missingDates`, `karenzOverrunDays` and the year overview equal the literals
 * captured on the unfixed tree — green before AND after the fix (the Q3 consumers are
 * span-guarded / month-filtered, see the close-month-data.ts comment).
 *
 * Fixture (all dates fixed, 2025):
 *   d.employee      FIXED_SCHEDULE; entries 30.09. AUTO, 01.10. AUTO, 02.10. CONFIRMED (isLocked false)
 *   d.adminEmployee FIXED_SCHEDULE; APPROVED SICK 24.09.-30.09. without attest (Karenz after 3 days)
 * Both employees are hired 01.09.2025, so September is the first month of the year overview that
 * can be open — the one whose gap list depends on the 30.09./01.10. boundary rows.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  salonIdForEmployee,
} from "./setup";
import { leaveTypeFields } from "../contexts/absence/leave-type";

type StatusRow = {
  employeeId: string;
  status: string;
  missingDates?: string[];
  unconfirmedBreakDays?: string[];
  karenzOverrunDays?: string[];
};

describe("Issue #493 — close-month status month boundaries", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;

  async function entry(day: string, breakStatus: "AUTO" | "CONFIRMED") {
    await app.prisma.timeEntry.create({
      data: {
        employeeId: d.employee.id,
        date: new Date(`${day}T00:00:00Z`),
        startTime: new Date(`${day}T07:00:00Z`),
        endTime: new Date(`${day}T15:00:00Z`),
        breakMinutes: 30,
        breakStatus,
        isLocked: false,
        type: "WORK",
        source: "MANUAL",
        salonId: await salonIdForEmployee(app.prisma, d.employee.id),
      },
    });
  }

  async function status(month: number): Promise<StatusRow[]> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/close-month/status?year=2025&month=${month}`,
      headers: { authorization: `Bearer ${d.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).employees as StatusRow[];
  }

  const rowOf = (rows: StatusRow[], employeeId: string) => {
    const row = rows.find((r) => r.employeeId === employeeId);
    expect(row).toBeDefined();
    return row as StatusRow;
  };

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "csb493");
    await app.prisma.tenantConfig.update({
      where: { tenantId: d.tenant.id },
      data: { enforceBreakConfirmation: true, sickNoteRequiredAfterDays: 3 },
    });

    await app.prisma.employee.updateMany({
      where: { id: { in: [d.employee.id, d.adminEmployee.id] } },
      data: { hireDate: new Date("2025-09-01T00:00:00Z") },
    });

    await entry("2025-09-30", "AUTO");
    await entry("2025-10-01", "AUTO");
    await entry("2025-10-02", "CONFIRMED");

    const sickType = await app.prisma.leaveType.create({
      data: { tenantId: d.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: d.adminEmployee.id,
        leaveTypeId: sickType.id,
        startDate: new Date("2025-09-24T00:00:00Z"),
        endDate: new Date("2025-09-30T00:00:00Z"),
        days: 5,
        status: "APPROVED",
        attestPresent: false,
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, d.tenant.id);
    } catch (err) {
      console.error("close-month-status-month-boundary-493 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("October lists only 01.10. as an unconfirmed break day (the 30.09. entry is September's)", async () => {
    expect(rowOf(await status(10), d.employee.id).unconfirmedBreakDays).toEqual(["2025-10-01"]);
  });

  it("September lists only 30.09. as an unconfirmed break day (control)", async () => {
    expect(rowOf(await status(9), d.employee.id).unconfirmedBreakDays).toEqual(["2025-09-30"]);
  });

  it("neutrality: missingDates and karenzOverrunDays equal the unfixed-tree literals", async () => {
    const oct = await status(10);
    const sep = await status(9);
    expect({
      adminOctMissing: rowOf(oct, d.adminEmployee.id).missingDates,
      adminOctKarenz: rowOf(oct, d.adminEmployee.id).karenzOverrunDays,
      adminSepKarenz: rowOf(sep, d.adminEmployee.id).karenzOverrunDays,
      empOctMissing: rowOf(oct, d.employee.id).missingDates,
    }).toEqual({
      adminOctMissing: [
        "2025-10-01",
        "2025-10-02",
        "2025-10-06",
        "2025-10-07",
        "2025-10-08",
        "2025-10-09",
        "2025-10-10",
        "2025-10-13",
        "2025-10-14",
        "2025-10-15",
        "2025-10-16",
        "2025-10-17",
        "2025-10-20",
        "2025-10-21",
        "2025-10-22",
        "2025-10-23",
        "2025-10-24",
        "2025-10-27",
        "2025-10-28",
        "2025-10-29",
        "2025-10-30",
      ],
      adminOctKarenz: [],
      adminSepKarenz: [
        "2025-09-24",
        "2025-09-25",
        "2025-09-26",
        "2025-09-27",
        "2025-09-28",
        "2025-09-29",
        "2025-09-30",
      ],
      empOctMissing: [
        "2025-10-06",
        "2025-10-07",
        "2025-10-08",
        "2025-10-09",
        "2025-10-10",
        "2025-10-13",
        "2025-10-14",
        "2025-10-15",
        "2025-10-16",
        "2025-10-17",
        "2025-10-20",
        "2025-10-21",
        "2025-10-22",
        "2025-10-23",
        "2025-10-24",
        "2025-10-27",
        "2025-10-28",
        "2025-10-29",
        "2025-10-30",
      ],
    });
  });

  it("neutrality: year-status equals the unfixed-tree literal", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/overtime/close-month/year-status?year=2025",
      headers: { authorization: `Bearer ${d.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Names/numbers are fixture-derived; compare status, counts and the missing-date lists only.
    const normalised = body.months.map(
      (m: {
        month: number;
        status: string;
        closedCount: number;
        totalCount: number;
        missing?: { missingDates: string[] }[];
      }) => [
        m.month,
        m.status,
        m.closedCount,
        m.totalCount,
        m.missing?.map((x) => x.missingDates) ?? null,
      ],
    );
    expect(normalised).toEqual([
      [1, "no_data", 0, 0, null],
      [2, "no_data", 0, 0, null],
      [3, "no_data", 0, 0, null],
      [4, "no_data", 0, 0, null],
      [5, "no_data", 0, 0, null],
      [6, "no_data", 0, 0, null],
      [7, "no_data", 0, 0, null],
      [8, "no_data", 0, 0, null],
      [
        9,
        "open",
        0,
        2,
        [
          [
            "2025-09-01",
            "2025-09-02",
            "2025-09-03",
            "2025-09-04",
            "2025-09-05",
            "2025-09-08",
            "2025-09-09",
            "2025-09-10",
            "2025-09-11",
            "2025-09-12",
            "2025-09-15",
            "2025-09-16",
            "2025-09-17",
            "2025-09-18",
            "2025-09-19",
            "2025-09-22",
            "2025-09-23",
          ],
          [
            "2025-09-01",
            "2025-09-02",
            "2025-09-03",
            "2025-09-04",
            "2025-09-05",
            "2025-09-08",
            "2025-09-09",
            "2025-09-10",
            "2025-09-11",
            "2025-09-12",
            "2025-09-15",
            "2025-09-16",
            "2025-09-17",
            "2025-09-18",
            "2025-09-19",
            "2025-09-22",
            "2025-09-23",
            "2025-09-24",
            "2025-09-25",
            "2025-09-26",
            "2025-09-29",
          ],
        ],
      ],
      [10, "blocked", 0, 2, null],
      [11, "blocked", 0, 2, null],
      [12, "blocked", 0, 2, null],
    ]);
  });
});
