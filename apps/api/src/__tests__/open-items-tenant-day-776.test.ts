/**
 * open-items-tenant-day-776.test.ts — GitHub issue #776.
 *
 * `GET /dashboard/open-items` derived its window with process-local `setDate` arithmetic on a
 * UTC-midnight "tenant-local day" (`todayInTz`). In a Berlin-local process across a DST change
 * the window start landed on 23:00Z of the day before and the day loop (UTC stepping) skipped
 * yesterday. Clock: 00:30 Europe/Berlin (UTC date is still the previous day), 25 Oct DST end
 * inside the window, process TZ pinned to Europe/Berlin. The 7-day window must be exactly the
 * tenant-local days today-7 .. today-1 (no day too many, none missing).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  cleanupTestData,
  createTestSalon,
  grantSystemRole,
} from "./setup";
import { getHolidays, STATE_MAP } from "../contexts/platform/holidays";
import { TEST_TZ as TZ, pastDateStr, dowOf } from "./test-dates";

const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "Europe/Berlin";
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(new Date("2026-10-26T23:30:00Z")); // 2026-10-27 00:30 Berlin

describe("GET /dashboard/open-items — tenant-local window at 00:30 Berlin (issue #776)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let token: string;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const suffix = "oi-776-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const tenant = await prisma.tenant.create({
      data: { name: `OI-776 ${suffix}`, slug: suffix, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await createTestSalon(prisma, tenantId);
    await prisma.tenantConfig.create({
      data: { tenantId, defaultVacationDays: 30, timezone: TZ, missingEntriesDays: 7 },
    });
    const hireDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    const email = `${suffix}@test.de`;
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: suffix,
        firstName: "Case",
        lastName: "TZ776",
        hireDate,
        isTimeTrackingExempt: false,
      },
    });
    await grantSystemRole(prisma, { tenantId, userId: user.id, role: "EMPLOYEE" });
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        workDays: [1, 2, 3, 4, 5],
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: hireDate,
      } as never,
    });
    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: "test1234" },
    });
    token = JSON.parse(login.body).accessToken;
  });

  afterAll(async () => {
    vi.useRealTimers();
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
    try {
      await cleanupTestData(app, tenantId);
      await app.prisma.tenantConfig.deleteMany({ where: { tenantId } });
      await app.prisma.tenant.deleteMany({ where: { id: tenantId } });
    } catch (err) {
      console.error("OI-776 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("lists exactly the tenant-local days today-7 .. today-1 (yesterday included, today-8 excluded)", async () => {
    const days: string[] = [];
    for (let back = 7; back >= 1; back--) days.push(pastDateStr(back));
    expect(days[days.length - 1]).toBe("2026-10-26"); // yesterday, tenant-local
    const years = new Set(days.map((d) => Number(d.slice(0, 4))));
    const holidays = new Set<string>();
    for (const y of years) {
      for (const h of getHolidays(y, STATE_MAP["NIEDERSACHSEN"])) holidays.add(h.date);
    }
    const expected = days.filter((d) => dowOf(d) >= 1 && dowOf(d) <= 5 && !holidays.has(d));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/open-items",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).missingDays).toEqual(expected);
  });
});
