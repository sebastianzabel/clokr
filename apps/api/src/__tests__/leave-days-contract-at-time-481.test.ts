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
});
