/**
 * Issue #849 (1) — a new employee whose hire date lies in an earlier year sees their current-year
 * Resturlaub on the dashboard right away, not "0 / 0" until the first leave request.
 *
 * The year is computed from the clock (never a fixed date): the hire date is 1 January of the
 * previous calendar year, so the current year's entitlement is a full year.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { todayStr } from "./test-dates";

describe("Issue #849 (1) — current-year entitlement exists from creation", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const currentYear = Number(todayStr().slice(0, 4));

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "nev849");
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  it("dashboard Resturlaub is the full entitlement, not 0 / 0", async () => {
    const uid = Date.now().toString(36);
    const email = `nev849-${uid}@test.de`;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        email,
        firstName: "Neu",
        lastName: "Eintritt",
        employeeNumber: `NEV849-${uid}`,
        hireDate: new Date(`${currentYear - 1}-01-01T12:00:00Z`).toISOString(),
        role: "EMPLOYEE",
        scheduleType: "FIXED_SCHEDULE",
        weeklyHours: 40,
        password: "Test1234!secure",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const employeeId = (JSON.parse(res.body) as { id: string }).id;

    const years = (
      await app.prisma.leaveEntitlement.findMany({
        where: { employeeId },
        select: { year: true },
        orderBy: { year: "asc" },
      })
    ).map((r) => r.year);
    expect(years).toEqual([currentYear - 1, currentYear]);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: "Test1234!secure" },
    });
    expect(login.statusCode, login.body).toBe(200);
    const { accessToken } = JSON.parse(login.body) as { accessToken: string };
    const dash = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(dash.statusCode, dash.body).toBe(200);
    const vacation = (JSON.parse(dash.body) as { vacation: { remaining: number; total: number } })
      .vacation;
    expect(vacation.total).toBeGreaterThan(0);
    expect(vacation.remaining).toBe(vacation.total);
  });
});
