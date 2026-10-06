/**
 * Issue #493 (R1/R3, D-05/D-08/D-10/D-11) — the DATEV export carries only the hours and sick days of
 * its own month.
 *
 * Before the fix both DATEV handlers passed `monthRangeUtc` INSTANTS to the `@db.Date` filters of the
 * time-entry include and the leave overlap filter, and `buildDatevLodas` walked its Krank workday keys
 * from the start INSTANT. For a Europe/Berlin tenant the instant of local Oct 1 00:00 is
 * 2026-09-30T22:00Z, so
 *   - the previous month's last-day entry was summed into the Normalstunden line (F-05), and
 *   - every key of a leave that began before the month was one day early (F-04).
 *
 * Fixture seasons — all dates fixed, nothing is "now"-relative:
 *   summer  30.09. / 01.10.2026 (CEST, UTC+2)
 *   winter  31.01. / 01.02.2026 (CET, UTC+1)
 *   DST     28.02. / 01.03. and 31.03. / 01.04.2026 (CET→CEST switch on 29.03.2026)
 *
 * Employees:
 *   U   1 h on 31.01., 1 h on 01.02., 58 min on 30.09., 2 h on 01.10.
 *   U2  1 h each on 28.02., 01.03., 31.03., 01.04.
 *   T   the seeded employee with APPROVED SICK leave Mon 28.09.-Sat 03.10.2026
 *   X1  hireDate 2026-10-31T23:30:00Z (= 01.11. 00:30 Berlin) — hired AFTER October
 *   X2  exitDate 2026-09-30T22:00:00Z (= 01.10. 00:00 Berlin) — still inside October
 *
 * The neutrality block pins what MUST stay on instants: the payroll-period predicate on the
 * `@db.Timestamptz` columns Employee.hireDate/exitDate, the skipped counts and the EXPORT audit row.
 * Its literals were captured on the unfixed tree and are green before AND after the fix (D-10).
 * D-11: the DATEV time-entry include has no work-type filter — pre-existing, not changed here.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import iconv from "iconv-lite";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  configureDatevKanzlei,
} from "../../__tests__/setup";
import { leaveTypeFields } from "../../contexts/absence/leave-type";
import { DATEV_BWD_SATZ_ID } from "../reports";

// Named offsets of a Bewegungsdaten row (Satz-ID + 12 values), as in datev-export.test.ts.
const F_PNR = 1;
const F_LOHNART = 5;
const F_STUNDEN = 6;
const F_TAGE = 7;

describe("Issue #493 — DATEV month boundaries", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;
  let U = { id: "", number: "" };
  let U2 = { id: "", number: "" };
  let X1 = { id: "", number: "" };
  let X2 = { id: "", number: "" };

  async function createEmp(
    label: string,
    opts: { hireDate?: Date; exitDate?: Date; fixed?: boolean } = {},
  ): Promise<{ id: string; number: string }> {
    const prisma = app.prisma;
    const passwordHash = await bcrypt.hash("test1234", 10);
    const suffix = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await prisma.user.create({
      data: { email: `${suffix}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await prisma.employee.create({
      data: {
        tenantId: d.tenant.id,
        userId: user.id,
        employeeNumber: `N-${suffix}`,
        firstName: label,
        lastName: "Dmb493",
        hireDate: opts.hireDate ?? new Date("2025-01-01T00:00:00Z"),
        exitDate: opts.exitDate ?? null,
      },
    });
    await prisma.workSchedule.create({
      data: opts.fixed
        ? {
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
            validFrom: new Date("2025-01-01T00:00:00Z"),
          }
        : ({
            employeeId: employee.id,
            type: "MONTHLY_HOURS",
            monthlyHours: null,
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
          } as never),
    });
    await prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    return { id: employee.id, number: employee.employeeNumber };
  }

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
    d = await seedTestData(app, "dmb493");
    await configureDatevKanzlei(app, d.tenant.id);

    const cfg = await app.prisma.tenantConfig.findUnique({ where: { tenantId: d.tenant.id } });
    expect(cfg?.timezone ?? "Europe/Berlin").toBe("Europe/Berlin");

    U = await createEmp("untracked");
    await entry(U.id, "2026-01-31", "19:00", "20:00");
    await entry(U.id, "2026-02-01", "09:00", "10:00");
    await entry(U.id, "2026-09-30", "19:44", "20:42");
    await entry(U.id, "2026-10-01", "06:00", "08:00");

    U2 = await createEmp("dstmonths");
    await entry(U2.id, "2026-02-28", "10:00", "11:00");
    await entry(U2.id, "2026-03-01", "10:00", "11:00");
    await entry(U2.id, "2026-03-31", "10:00", "11:00");
    await entry(U2.id, "2026-04-01", "10:00", "11:00");

    // T: SICK Mon 28.09. - Sat 03.10.2026 — the leave begins before October and ends inside it.
    const sickType = await app.prisma.leaveType.create({
      data: { tenantId: d.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: d.employee.id,
        leaveTypeId: sickType.id,
        startDate: new Date("2026-09-28T00:00:00Z"),
        endDate: new Date("2026-10-03T00:00:00Z"),
        days: 1,
        status: "APPROVED",
      },
    });

    X1 = await createEmp("hiredafter", {
      fixed: true,
      hireDate: new Date("2026-10-31T23:30:00Z"),
    });
    X2 = await createEmp("leftatstart", {
      fixed: true,
      exitDate: new Date("2026-09-30T22:00:00Z"),
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, d.tenant.id);
    } catch (err) {
      console.error("datev-month-boundary-493 cleanup failed:", err);
    }
    await closeTestApp();
  });

  /** Decoded Bewegungsdaten rows (split by ";") of a DATEV call. */
  async function datevRows(url: string): Promise<string[][]> {
    const res = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${d.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const text = iconv.decode(res.rawPayload, "win1252");
    return text
      .split("[Bewegungsdaten]")[1]
      .split("\r\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => l.split(";"))
      .filter((f) => f[0] === String(DATEV_BWD_SATZ_ID));
  }

  const companyRows = (year: number, month: number) =>
    datevRows(`/api/v1/reports/datev?year=${year}&month=${month}`);

  function cell(rows: string[][], pnr: string, lohnart: number, field: number): string | undefined {
    return rows.find((r) => r[F_PNR] === pnr && r[F_LOHNART] === String(lohnart))?.[field];
  }

  describe("company export — Normalstunden (Lohnart 100) of the month's own days", () => {
    it.each([
      ["U", 2026, 10, "2,00"], // red "2,97": the 30.09. entry (58 min) leaked into October
      ["U", 2026, 9, "0,97"],
      ["U", 2026, 2, "1,00"], // red "2,00": the 31.01. entry leaked into February
      ["U", 2026, 1, "1,00"],
      ["U2", 2026, 3, "2,00"], // red "3,00": the 28.02. entry leaked into March
      ["U2", 2026, 4, "1,00"], // red "2,00": the 31.03. entry leaked into April
      ["U2", 2026, 2, "1,00"],
    ] as const)("%s %i-%i Normalstunden = %s", async (who, year, month, expected) => {
      const rows = await companyRows(year, month);
      const e = who === "U" ? U : U2;
      expect(cell(rows, e.number, 100, F_STUNDEN)).toBe(expected);
    });
  });

  describe("company export — Krank (Lohnart 200) of a leave crossing a month end (employee T)", () => {
    it.each([
      [2026, 10, "2,0"], // red "3,0": every key of a leave begun before the month was one day early
      [2026, 9, "3,0"],
    ] as const)("%i-%i Krank Tage = %s", async (year, month, expected) => {
      const rows = await companyRows(year, month);
      expect(cell(rows, d.employee.employeeNumber, 200, F_TAGE)).toBe(expected);
    });
  });

  describe("neutrality — the payroll-period predicate stays on the Timestamptz instants (D-10)", () => {
    it("X2 (exitDate = Oct 1 00:00 Berlin) is IN the October file, X1 (hired Nov 1 00:30 Berlin) is not", async () => {
      const rows = await companyRows(2026, 10);
      const pnrs = new Set(rows.map((r) => r[F_PNR]));
      expect(pnrs.has(X2.number)).toBe(true);
      expect(pnrs.has(X1.number)).toBe(false);
    });

    it("the EXPORT audit row of the October call keeps its counts", async () => {
      await companyRows(2026, 10);
      const entry = await app.prisma.auditLog.findFirst({
        where: { action: "EXPORT", entity: "Report", userId: d.adminUser.id },
        orderBy: { createdAt: "desc" },
      });
      expect(entry).not.toBeNull();
      expect(entry!.newValue).toEqual({
        type: "DATEV",
        year: "2026",
        month: "10",
        employeesIncluded: 5,
        skippedNotYetHired: 1,
        skippedAlreadyLeft: 0,
      });
    });
  });
});
