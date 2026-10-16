/**
 * Phase 71b Plan 03 (issue #71, D-04/AC-5/AC-7) — leave-day counting (`getHolidayMap`,
 * `contexts/absence`) now resolves statutory holidays by WORK LOCATION (§ 2 EFZG) through the
 * Unterbau's central resolver (`holidaysAtWorkLocation`/`holidaysForSalon`), not a single
 * tenant-wide federal state.
 *
 * Fronleichnam 2026 = Thursday 2026-06-04 (BAYERN, not NIEDERSACHSEN) — June 2026 carries no
 * NIEDERSACHSEN statutory holiday.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import {
  getTestApp,
  seedTestData,
  seedEntitlementYears,
  cleanupTestData,
  createTestSalon,
  grantSystemRole,
} from "./setup";
import { TENANT_REQUIRED_ERROR } from "../contexts/platform/tenant-status";

describe("Leave days by work location (Phase 71b Plan 03, issue #71, AC-5/AC-7)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let salonAId: string; // BAYERN
  let salonBId: string; // NIEDERSACHSEN, created FIRST — the tenant's default salon
  let depToken: string; // HOME B + DEPLOYMENT A on Thursdays
  let ctlToken: string; // HOME B only
  let homeAToken: string; // HOME A only
  let apiKeyToken: string; // no Employee row at all: an API key of the tenant (Issue #551)
  let adminNoProfileLoginStatus: number; // a profile-less admin can no longer sign in (Issue #551)
  let adminNoProfileLoginBody: unknown;
  let profileLessUserId: string;

  beforeAll(async () => {
    app = await getTestApp();
    const seed = await seedTestData(app, "lwl", { withDefaultSalon: false });
    tenantId = seed.tenant.id;

    const salonB = await createTestSalon(app.prisma, tenantId, { federalState: "NIEDERSACHSEN" });
    salonBId = salonB.id;
    const salonA = await createTestSalon(app.prisma, tenantId, { federalState: "BAYERN" });
    salonAId = salonA.id;

    const passwordHash = await bcrypt.hash("test1234", 10);

    async function createFixedEmployee(label: string) {
      const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const email = `lwl-${label}-${suffix}@test.de`;
      const user = await app.prisma.user.create({
        data: { email, passwordHash, role: "EMPLOYEE", isActive: true },
      });
      const employee = await app.prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: `LWL-${label}-${suffix}`,
          firstName: label,
          lastName: "WorkLocation",
          hireDate: new Date("2026-01-01"),
        },
      });
      await grantSystemRole(app.prisma, { tenantId, userId: user.id, role: "EMPLOYEE" });
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
          validFrom: new Date("2026-01-01"),
        },
      });
      await app.prisma.overtimeAccount.create({
        data: { employeeId: employee.id, balanceHours: 0 },
      });
      await seedEntitlementYears(app, {
        employeeId: employee.id,
        leaveTypeId: seed.vacationType.id,
        years: [2026],
      });

      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password: "test1234" },
      });
      const { accessToken } = JSON.parse(loginRes.body);
      return { employee, accessToken: accessToken as string };
    }

    const dep = await createFixedEmployee("dep");
    depToken = dep.accessToken;
    const ctl = await createFixedEmployee("ctl");
    ctlToken = ctl.accessToken;
    const homeA = await createFixedEmployee("homeA");
    homeAToken = homeA.accessToken;

    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId: dep.employee.id,
        salonId: salonBId,
        kind: "HOME",
        validFrom: new Date("2026-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId: dep.employee.id,
        salonId: salonAId,
        kind: "DEPLOYMENT",
        validFrom: new Date("2026-01-01"),
        validUntil: null,
        weekdays: [3], // Thursday (0 = Monday)
      },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId: ctl.employee.id,
        salonId: salonBId,
        kind: "HOME",
        validFrom: new Date("2026-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId: homeA.employee.id,
        salonId: salonAId,
        kind: "HOME",
        validFrom: new Date("2026-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });

    // Manual holiday, salon A only — must not reduce ctl's (NIEDERSACHSEN) leave days, and must
    // reduce dep's only on a day dep is actually deployed to A (Wednesday is not a Thursday).
    await app.prisma.publicHoliday.create({
      data: {
        tenantId,
        salonId: salonAId,
        date: new Date("2026-06-10"), // Wednesday
        name: "Stadtfest A",
        federalState: "BAYERN",
        year: 2026,
      },
    });

    // Manual holiday on the DEFAULT salon (B) only, on a June-2026 Wednesday no other assertion of
    // this file uses (the vacation ranges cover 06-01..05 and 06-08..12). It makes the default-salon
    // fallback assertion below non-vacuous: the fallback caller must SEE this day.
    await app.prisma.publicHoliday.create({
      data: {
        tenantId,
        salonId: salonBId,
        date: new Date("2026-06-17"), // Wednesday
        name: "Stadtfest B",
        federalState: "NIEDERSACHSEN",
        year: 2026,
      },
    });

    // Requester without an Employee (GET /leave/calendar's requester-work-location fallback), so the
    // tenant's default salon (B) stands in for every day. Since Issue #551 a profile-less USER can no
    // longer sign in (403 TENANT_REQUIRED); the only principal that still reaches that fallback is an
    // API key of the tenant, which carries no employeeId.
    const adminEmail = `lwl-admin-noprofile-${Date.now().toString(36)}@test.de`;
    const profileLessUser = await app.prisma.user.create({
      data: { email: adminEmail, passwordHash, role: "ADMIN", isActive: true },
    });
    profileLessUserId = profileLessUser.id;
    const adminLoginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: adminEmail, password: "test1234" },
    });
    adminNoProfileLoginStatus = adminLoginRes.statusCode;
    adminNoProfileLoginBody = JSON.parse(adminLoginRes.body);

    apiKeyToken = `clk_${randomBytes(24).toString("hex")}`;
    await app.prisma.apiKey.create({
      data: {
        tenantId,
        name: `lwl-551-${Date.now().toString(36)}`,
        keyHash: createHash("sha256").update(apiKeyToken).digest("hex"),
        keyPrefix: apiKeyToken.slice(0, 8),
        scopes: ["admin"],
        createdBy: seed.adminUser.id,
      },
    });
  });

  afterAll(async () => {
    try {
      // The profile-less user is not reachable through an Employee, so cleanupTestData misses it; its
      // refused login left a LOGIN_REFUSED audit row (Issue #551).
      if (profileLessUserId) {
        await app.prisma.auditLog.deleteMany({
          where: { OR: [{ userId: profileLessUserId }, { entityId: profileLessUserId }] },
        });
        await app.prisma.user.deleteMany({ where: { id: profileLessUserId } });
      }
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("leave-days-work-location cleanup failed:", err);
    }
  });

  async function postVacation(token: string, startDate: string, endDate: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${token}` },
      payload: { type: "VACATION", startDate, endDate },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body) as { days: string | number };
  }

  it("AC-5: the week containing Fronleichnam (Thursday) — dep (deployed to BAYERN that day) gets 4 days, ctl (NIEDERSACHSEN only) gets 5, homeA (BAYERN HOME) gets 4", async () => {
    const depDays = await postVacation(depToken, "2026-06-01", "2026-06-05");
    expect(Number(depDays.days)).toBe(4);

    const ctlDays = await postVacation(ctlToken, "2026-06-01", "2026-06-05");
    expect(Number(ctlDays.days)).toBe(5);

    const homeADays = await postVacation(homeAToken, "2026-06-01", "2026-06-05");
    expect(Number(homeADays.days)).toBe(4);
  });

  it("AC-7: the week containing the salon-A-only manual holiday (Wednesday) — dep is HOME B that day, so 5; homeA is reduced to 4; ctl is unaffected at 5", async () => {
    const depDays = await postVacation(depToken, "2026-06-08", "2026-06-12");
    expect(Number(depDays.days)).toBe(5);

    const homeADays = await postVacation(homeAToken, "2026-06-08", "2026-06-12");
    expect(Number(homeADays.days)).toBe(4);

    const ctlDays = await postVacation(ctlToken, "2026-06-08", "2026-06-12");
    expect(Number(ctlDays.days)).toBe(5);
  });

  it("GET /leave/hours-preview reports the same day count as POST /leave/requests for the same employee and range", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/leave/hours-preview?startDate=2026-06-01&endDate=2026-06-05",
      headers: { authorization: `Bearer ${depToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { days: number };
    expect(Number(body.days)).toBe(4);
  });

  it("GET /leave/calendar resolves day by day at the REQUESTER's own work location, never tenant-wide", async () => {
    async function holidayDatesFor(token: string): Promise<string[]> {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/leave/calendar?year=2026&month=6",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Array<{ typeCode: string | null; startDate: string }>;
      return body.filter((e) => e.typeCode === "HOLIDAY").map((e) => e.startDate);
    }

    // dep: deployed to A on Thursdays -> sees Fronleichnam, but is HOME B on the Wednesday of
    // Stadtfest A -> does not see it.
    const depHolidays = await holidayDatesFor(depToken);
    expect(depHolidays).toContain("2026-06-04");
    expect(depHolidays).not.toContain("2026-06-10");

    // homeA: HOME A every day -> sees both.
    const homeAHolidays = await holidayDatesFor(homeAToken);
    expect(homeAHolidays).toContain("2026-06-04");
    expect(homeAHolidays).toContain("2026-06-10");

    // ctl: HOME B every day -> sees neither.
    const ctlHolidays = await holidayDatesFor(ctlToken);
    expect(ctlHolidays).not.toContain("2026-06-04");
    expect(ctlHolidays).not.toContain("2026-06-10");

    // A requester without an Employee (an API key — a profile-less user cannot sign in since
    // Issue #551): no employee to resolve a work location for -> the tenant's default salon (B,
    // NIEDERSACHSEN) stands in, same as ctl -> sees neither Bavarian day, but DOES see B's own
    // manual holiday (non-vacuous: proves the fallback resolves to B and not to "nothing").
    const keyHolidays = await holidayDatesFor(apiKeyToken);
    expect(keyHolidays).toContain("2026-06-17");
    expect(keyHolidays).not.toContain("2026-06-04");
    expect(keyHolidays).not.toContain("2026-06-10");
  });

  it("a profile-less user can no longer sign in: 403 TENANT_REQUIRED (Issue #551)", () => {
    expect(adminNoProfileLoginStatus).toBe(403);
    expect(adminNoProfileLoginBody).toEqual(TENANT_REQUIRED_ERROR);
  });
});
