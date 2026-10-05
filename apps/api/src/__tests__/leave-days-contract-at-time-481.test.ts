/**
 * Issue #481 (R1, D-01, D-02, D-07, PD-01) — tracer regression (plan 481-01, Task 1): the
 * owner's golden Contract A prod case, priced by the contract valid in each ISO week instead of
 * the newest `WorkSchedule` row, end-to-end through `GET /api/v1/leave/hours-preview`.
 *
 * Fixed dates only (`new Date(Date.UTC(...))` / literal ISO strings) — no calendar-relative
 * anchors, no time bomb. Initials-only fixtures (firstName "A4", lastName "81") — no PII per
 * CLAUDE.md. Own seeded tenant per `seedTestData`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import {
  getHolidayMap,
  getShiftBasedLeaveDaysForWeek,
  resolveLeaveDays,
} from "../contexts/absence";
import { splitLeaveDaysByYear, workDaysSetFrom } from "../contexts/absence/leave-days";
import { countShiftBasedLeaveDays } from "../contexts/absence/vacation-calc";
import { calculateWorkDays } from "../contexts/platform";

describe("GET /leave/hours-preview priced by contract-at-time (Issue #481, R1)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  async function mkShiftBasedEmployee(
    label: string,
    rows: Array<{
      validFrom: Date;
      contractWorkDaysPerWeek: number;
      usualWorkDays: number[];
      workDays: number[];
    }>,
  ): Promise<{ employeeId: string; token: string }> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const email = `lc481-${label}-${uid}@test.de`;
    const user = await app.prisma.user.create({
      data: {
        email,
        passwordHash: await (await import("bcryptjs")).default.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `LC481-${label}-${uid}`,
        firstName: "A4",
        lastName: "81",
        hireDate: rows[0].validFrom,
      },
    });
    for (const row of rows) {
      await app.prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
          type: "SHIFT_BASED",
          weeklyHours: row.contractWorkDaysPerWeek * 8,
          contractWorkDaysPerWeek: row.contractWorkDaysPerWeek,
          usualWorkDays: row.usualWorkDays,
          workDays: row.workDays,
          mondayHours: row.workDays.includes(1) ? 8 : 0,
          tuesdayHours: row.workDays.includes(2) ? 8 : 0,
          wednesdayHours: row.workDays.includes(3) ? 8 : 0,
          thursdayHours: row.workDays.includes(4) ? 8 : 0,
          fridayHours: row.workDays.includes(5) ? 8 : 0,
          saturdayHours: row.workDays.includes(6) ? 8 : 0,
          sundayHours: row.workDays.includes(0) ? 8 : 0,
          validFrom: row.validFrom,
        },
      });
    }
    await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: "test1234" },
    });
    return { employeeId: employee.id, token: JSON.parse(login.body).accessToken as string };
  }

  async function preview(token: string, startDate: string, endDate: string, withType: boolean) {
    const qs = withType
      ? `startDate=${startDate}&endDate=${endDate}&type=VACATION`
      : `startDate=${startDate}&endDate=${endDate}`;
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/hours-preview?${qs}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body);
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "lc481");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("leave-days-contract-at-time-481 cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("Contract A (with usualWorkDays Angabe on both rows)", () => {
    let token: string;

    beforeAll(async () => {
      const emp = await mkShiftBasedEmployee("a", [
        {
          validFrom: new Date(Date.UTC(2025, 8, 1)), // 2025-09-01
          contractWorkDaysPerWeek: 5,
          usualWorkDays: [1, 2, 3, 4, 5],
          workDays: [1, 2, 3, 4, 5],
        },
        {
          validFrom: new Date(Date.UTC(2026, 7, 1)), // 2026-08-01
          contractWorkDaysPerWeek: 4,
          usualWorkDays: [2, 3, 4, 5],
          workDays: [2, 3, 4, 5],
        },
      ]);
      token = emp.token;
    });

    it("Do 23.07.-Mi 29.07.2026 prices 5 days (not 4, the newest-row answer)", async () => {
      const withType = await preview(token, "2026-07-23", "2026-07-29", true);
      expect(Number(withType.days)).toBe(5);
      const isolated = await preview(token, "2026-07-23", "2026-07-29", false);
      expect(Number(isolated.days)).toBe(5);
    });

    it("Fr 11.09.-Mo 14.09.2026 prices 1 day", async () => {
      const withType = await preview(token, "2026-09-11", "2026-09-14", true);
      expect(Number(withType.days)).toBe(1);
      const isolated = await preview(token, "2026-09-11", "2026-09-14", false);
      expect(Number(isolated.days)).toBe(1);
    });

    it("Mo 13.07.-Sa 18.07.2026 (whole week fully under the OLD 5-day segment) prices 5", async () => {
      const withType = await preview(token, "2026-07-13", "2026-07-18", true);
      expect(Number(withType.days)).toBe(5);
      const isolated = await preview(token, "2026-07-13", "2026-07-18", false);
      expect(Number(isolated.days)).toBe(5);
    });
  });

  describe("Contract A0 (twin, usualWorkDays [] on both rows)", () => {
    let token: string;

    beforeAll(async () => {
      const emp = await mkShiftBasedEmployee("a0", [
        {
          validFrom: new Date(Date.UTC(2025, 8, 1)),
          contractWorkDaysPerWeek: 5,
          usualWorkDays: [],
          workDays: [1, 2, 3, 4, 5],
        },
        {
          validFrom: new Date(Date.UTC(2026, 7, 1)),
          contractWorkDaysPerWeek: 4,
          usualWorkDays: [],
          workDays: [2, 3, 4, 5],
        },
      ]);
      token = emp.token;
    });

    it("Do 23.07.-Mi 29.07.2026 prices 6 days (no Angabe -> Sa counts)", async () => {
      const withType = await preview(token, "2026-07-23", "2026-07-29", true);
      expect(Number(withType.days)).toBe(6);
    });

    it("Fr 11.09.-Mo 14.09.2026 prices 3 days", async () => {
      const withType = await preview(token, "2026-09-11", "2026-09-14", true);
      expect(Number(withType.days)).toBe(3);
    });
  });

  // ── Task 2 (plan 481-01): every schedule type per date (R2), type change inside one request,
  // #436 marginal and #448 BS across a straddle, scheduling consumer, cross-year split ──────────

  type RowSpec = {
    type: "SHIFT_BASED" | "FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS";
    validFrom: string; // YYYY-MM-DD
    workDays: number[];
    /** Index 0=Sun..6=Sat; defaults to 8 on every workDays entry, 0 elsewhere. */
    dayHours?: number[];
    contractWorkDaysPerWeek?: number | null;
    usualWorkDays?: number[];
  };

  async function mkEmployee(
    label: string,
    rows: RowSpec[],
  ): Promise<{ employeeId: string; token: string }> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const email = `lc481-${label}-${uid}@test.de`;
    const user = await app.prisma.user.create({
      data: {
        email,
        passwordHash: await (await import("bcryptjs")).default.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `LC481-${label}-${uid}`,
        firstName: "A4",
        lastName: "81",
        hireDate: new Date(`${rows[0].validFrom}T00:00:00.000Z`),
      },
    });
    for (const row of rows) {
      const h =
        row.dayHours ?? [0, 1, 2, 3, 4, 5, 6].map((wd) => (row.workDays.includes(wd) ? 8 : 0));
      await app.prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
          type: row.type,
          weeklyHours: row.type === "MONTHLY_HOURS" ? null : h.reduce((a, b) => a + b, 0),
          monthlyHours: row.type === "MONTHLY_HOURS" ? 40 : null,
          contractWorkDaysPerWeek: row.contractWorkDaysPerWeek ?? null,
          usualWorkDays: row.usualWorkDays ?? [],
          workDays: row.workDays,
          sundayHours: h[0],
          mondayHours: h[1],
          tuesdayHours: h[2],
          wednesdayHours: h[3],
          thursdayHours: h[4],
          fridayHours: h[5],
          saturdayHours: h[6],
          validFrom: new Date(`${row.validFrom}T00:00:00.000Z`),
        },
      });
    }
    await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: "test1234" },
    });
    return { employeeId: employee.id, token: JSON.parse(login.body).accessToken as string };
  }

  const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  async function holidaysFor(employeeId: string, startIso: string, endIso: string) {
    const map = await getHolidayMap(app.prisma, data.tenant.id, employeeId, d(startIso), d(endIso));
    return new Set(map.keys());
  }

  async function approvedVacation(
    employeeId: string,
    startIso: string,
    endIso: string,
    days: number,
  ) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        startDate: d(startIso),
        endDate: d(endIso),
        halfDay: false,
        status: "APPROVED",
        days,
        reviewedBy: null,
      },
    });
  }

  const SHIFT_A_ROWS: RowSpec[] = [
    {
      type: "SHIFT_BASED",
      validFrom: "2025-09-01",
      workDays: [1, 2, 3, 4, 5],
      contractWorkDaysPerWeek: 5,
      usualWorkDays: [1, 2, 3, 4, 5],
    },
    {
      type: "SHIFT_BASED",
      validFrom: "2026-08-01",
      workDays: [2, 3, 4, 5],
      contractWorkDaysPerWeek: 4,
      usualWorkDays: [2, 3, 4, 5],
    },
  ];
  const SHIFT_A0_ROWS: RowSpec[] = SHIFT_A_ROWS.map((r) => ({ ...r, usualWorkDays: [] }));

  describe("R2 — non-SHIFT_BASED types count each date against the contract valid on it", () => {
    it("FIXED_SCHEDULE Mo-Fr -> Di-Sa from 01.08.2026: 27.07.-07.08.2026 prices 10 (newest row: 9)", async () => {
      const emp = await mkEmployee("fx", [
        { type: "FIXED_SCHEDULE", validFrom: "2025-09-01", workDays: [1, 2, 3, 4, 5] },
        { type: "FIXED_SCHEDULE", validFrom: "2026-08-01", workDays: [2, 3, 4, 5, 6] },
      ]);
      const body = await preview(emp.token, "2026-07-27", "2026-08-07", false);
      expect(Number(body.days)).toBe(10);
    });

    it("FLEXTIME [Mo-Do] -> [Mo-Fr] from 01.08.2026: 27.07.-07.08.2026 prices 9 (newest row: 10)", async () => {
      const emp = await mkEmployee("fl", [
        { type: "FLEXTIME", validFrom: "2025-09-01", workDays: [1, 2, 3, 4] },
        { type: "FLEXTIME", validFrom: "2026-08-01", workDays: [1, 2, 3, 4, 5] },
      ]);
      const body = await preview(emp.token, "2026-07-27", "2026-08-07", false);
      expect(Number(body.days)).toBe(9);
    });
  });

  describe("Schedule-TYPE change inside one request (RESEARCH Pitfall 2)", () => {
    it("FIXED Mo-Fr -> SHIFT_BASED 4/[Di-Fr] from 01.08.2026: 27.07.-07.08.2026 prices 9", async () => {
      const emp = await mkEmployee("tc1", [
        { type: "FIXED_SCHEDULE", validFrom: "2025-09-01", workDays: [1, 2, 3, 4, 5] },
        {
          type: "SHIFT_BASED",
          validFrom: "2026-08-01",
          workDays: [2, 3, 4, 5],
          contractWorkDaysPerWeek: 4,
          usualWorkDays: [2, 3, 4, 5],
        },
      ]);
      expect(Number((await preview(emp.token, "2026-07-27", "2026-08-07", false)).days)).toBe(9);
      expect(Number((await preview(emp.token, "2026-07-27", "2026-08-07", true)).days)).toBe(9);
    });

    it("SHIFT_BASED 4/[Di-Fr] -> FIXED Mo-Fr from 01.08.2026: 27.07.-07.08.2026 prices 9", async () => {
      const emp = await mkEmployee("tc2", [
        {
          type: "SHIFT_BASED",
          validFrom: "2025-09-01",
          workDays: [2, 3, 4, 5],
          contractWorkDaysPerWeek: 4,
          usualWorkDays: [2, 3, 4, 5],
        },
        { type: "FIXED_SCHEDULE", validFrom: "2026-08-01", workDays: [1, 2, 3, 4, 5] },
      ]);
      expect(Number((await preview(emp.token, "2026-07-27", "2026-08-07", false)).days)).toBe(9);
      expect(Number((await preview(emp.token, "2026-07-27", "2026-08-07", true)).days)).toBe(9);
    });
  });

  describe("#436 marginal pricing across a straddling week (D-01)", () => {
    it("Contract A0: B = 30.07.-01.08.2026 next to APPROVED A = 27.-29.07. prices 3 (request and isolated)", async () => {
      const emp = await mkEmployee("mg", SHIFT_A0_ROWS);
      await approvedVacation(emp.employeeId, "2026-07-27", "2026-07-29", 3);
      expect(Number((await preview(emp.token, "2026-07-30", "2026-08-01", true)).days)).toBe(3);
      expect(Number((await preview(emp.token, "2026-07-30", "2026-08-01", false)).days)).toBe(3);
    });

    it("single 5-day row without Angabe: the same A/B pair prices B at 2 (whole week 5 - 3)", async () => {
      const emp = await mkEmployee("mg1", [
        {
          type: "SHIFT_BASED",
          validFrom: "2025-09-01",
          workDays: [1, 2, 3, 4, 5],
          contractWorkDaysPerWeek: 5,
        },
      ]);
      await approvedVacation(emp.employeeId, "2026-07-27", "2026-07-29", 3);
      expect(Number((await preview(emp.token, "2026-07-30", "2026-08-01", true)).days)).toBe(2);
    });
  });

  describe("#448 Berufsschule exclusion against two segments", () => {
    let emp: { employeeId: string; token: string };

    beforeAll(async () => {
      emp = await mkEmployee("bs", SHIFT_A_ROWS);
      await app.prisma.absence.create({
        data: {
          employeeId: emp.employeeId,
          type: "VOCATIONAL_SCHOOL",
          source: "PATTERN",
          startDate: d("2026-07-28"),
          endDate: d("2026-07-28"),
          days: 1,
          halfDay: false,
          createdBy: "system",
        },
      });
    });

    it("VACATION 27.07.-31.07.2026 with a BS day on 28.07. prices 4 (newest row: 3)", async () => {
      const body = await preview(emp.token, "2026-07-27", "2026-07-31", true);
      expect(Number(body.days)).toBe(4);
    });

    it("a request covering only the BS day prices 0 and is vocationalSchoolOnly", async () => {
      const body = await preview(emp.token, "2026-07-28", "2026-07-28", true);
      expect(Number(body.days)).toBe(0);
      expect(body.vocationalSchoolOnly).toBe(true);
    });
  });

  describe("Scheduling consumer getShiftBasedLeaveDaysForWeek (Pitfall 4)", () => {
    let employeeId: string;

    beforeAll(async () => {
      const emp = await mkEmployee("sc", SHIFT_A_ROWS);
      employeeId = emp.employeeId;
      await approvedVacation(employeeId, "2026-07-23", "2026-07-29", 5);
    });

    it("week 27.07.-02.08.2026 -> 3 days Mo/Di/Mi (newest row: 2, Di/Mi)", async () => {
      const result = await getShiftBasedLeaveDaysForWeek(
        app.prisma,
        employeeId,
        data.tenant.id,
        d("2026-07-27"),
        d("2026-08-02"),
      );
      expect(result).toEqual({ days: 3, weekdays: ["Mo", "Di", "Mi"] });
    });

    it("week 20.07.-26.07.2026 -> 2 days Do/Fr", async () => {
      const result = await getShiftBasedLeaveDaysForWeek(
        app.prisma,
        employeeId,
        data.tenant.id,
        d("2026-07-20"),
        d("2026-07-26"),
      );
      expect(result).toEqual({ days: 2, weekdays: ["Do", "Fr"] });
    });
  });

  describe("Cross-year split follows the contract of the time (prefixLeaveDays, transitively)", () => {
    it("5/[Mo-Fr] -> 4/[Di-Fr] from 01.01.2027: 28.12.2026-08.01.2027 prices 8, split 4/4", async () => {
      const emp = await mkEmployee("cy", [
        {
          type: "SHIFT_BASED",
          validFrom: "2025-09-01",
          workDays: [1, 2, 3, 4, 5],
          contractWorkDaysPerWeek: 5,
          usualWorkDays: [1, 2, 3, 4, 5],
        },
        {
          type: "SHIFT_BASED",
          validFrom: "2027-01-01",
          workDays: [2, 3, 4, 5],
          contractWorkDaysPerWeek: 4,
          usualWorkDays: [2, 3, 4, 5],
        },
      ]);
      const start = d("2026-12-28");
      const end = d("2027-01-08");
      const holidays = await holidaysFor(emp.employeeId, "2026-12-28", "2027-01-08");
      const priced = await resolveLeaveDays(
        app.prisma,
        emp.employeeId,
        data.tenant.id,
        start,
        end,
        false,
        holidays,
        { mode: "isolated" },
      );
      expect(priced.days).toBe(8);
      const split = await splitLeaveDaysByYear(
        app.prisma,
        emp.employeeId,
        data.tenant.id,
        start,
        end,
        8,
        holidays,
      );
      expect(split.year1Days).toBe(4);
      expect(split.year2Days).toBe(4);
    });
  });

  describe("Single-row employees of every type price exactly as their kernel (R3 at the DB edge)", () => {
    const RANGES: Array<[string, string, boolean]> = [
      ["2026-09-21", "2026-10-11", false], // three weeks incl. Sa 03.10. (holiday)
      ["2026-09-22", "2026-09-22", true], // half day on a Tuesday
      ["2026-09-21", "2026-09-21", true], // half day on a Monday
    ];
    const SINGLE_ROWS: Array<[string, RowSpec]> = [
      [
        "fixed-di-sa",
        { type: "FIXED_SCHEDULE", validFrom: "2025-09-01", workDays: [2, 3, 4, 5, 6] },
      ],
      ["flex-mo-do", { type: "FLEXTIME", validFrom: "2025-09-01", workDays: [1, 2, 3, 4] }],
      [
        "monthly-default",
        {
          type: "MONTHLY_HOURS",
          validFrom: "2025-09-01",
          workDays: [],
          dayHours: [0, 0, 0, 0, 0, 0, 0],
        },
      ],
      [
        "shift-4-di-fr",
        {
          type: "SHIFT_BASED",
          validFrom: "2025-09-01",
          workDays: [2, 3, 4, 5],
          contractWorkDaysPerWeek: 4,
          usualWorkDays: [2, 3, 4, 5],
        },
      ],
    ];

    for (const [label, row] of SINGLE_ROWS) {
      it(`${label}: resolveLeaveDays equals the single-contract kernel`, async () => {
        const emp = await mkEmployee(`sr-${label}`, [row]);
        const cfg = await app.prisma.tenantConfig.findUnique({
          where: { tenantId: data.tenant.id },
          select: { defaultWorkDays: true },
        });
        const stored = await app.prisma.workSchedule.findFirstOrThrow({
          where: { employeeId: emp.employeeId },
        });
        let checked = 0;
        for (const [s, e, half] of RANGES) {
          const holidays = await holidaysFor(emp.employeeId, s, e);
          const priced = await resolveLeaveDays(
            app.prisma,
            emp.employeeId,
            data.tenant.id,
            d(s),
            d(e),
            half,
            holidays,
            { mode: "isolated" },
          );
          const expected =
            row.type === "SHIFT_BASED"
              ? countShiftBasedLeaveDays(
                  d(s),
                  d(e),
                  half,
                  row.contractWorkDaysPerWeek as number,
                  holidays,
                  row.usualWorkDays ?? [],
                ).days
              : calculateWorkDays(
                  d(s),
                  d(e),
                  half,
                  workDaysSetFrom(stored, cfg?.defaultWorkDays),
                  holidays,
                );
          expect({ label, s, e, half, days: priced.days }).toEqual({
            label,
            s,
            e,
            half,
            days: expected,
          });
          checked++;
        }
        expect(checked).toBe(RANGES.length);
      });
    }
  });
});
