/**
 * Issue #450 (D-09) — route-level suite for GET/PUT /api/v1/settings/vacation/:employeeId once
 * both the first-access heal (create path) and the statutory-minimum threshold are segment-aware
 * (per contract segment, EuGH Brandes C-415/12, Greenfield C-219/14) instead of computed from the
 * newest `WorkSchedule` row alone.
 *
 * Fixed dates only, except the GET first-access case which must mirror the handler's own
 * `new Date().getFullYear()` — that one test derives its fixture year the same way. Initials-only
 * fixtures (firstName "T", lastName "T") — no PII per CLAUDE.md.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("GET/PUT /api/v1/settings/vacation/:employeeId — segment-aware (Issue #450, D-09)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  async function mkEmployee(
    label: string,
    hireDate: Date,
    schedules: Array<{ validFrom: Date; workDays: number[] }>,
  ): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `svcc450-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `SVCC450-${label}-${uid}`,
        firstName: "T",
        lastName: "T",
        hireDate,
      },
    });
    for (const { validFrom, workDays } of schedules) {
      await app.prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
          type: "FIXED_SCHEDULE",
          mondayHours: workDays.includes(1) ? 8 : 0,
          tuesdayHours: workDays.includes(2) ? 8 : 0,
          wednesdayHours: workDays.includes(3) ? 8 : 0,
          thursdayHours: workDays.includes(4) ? 8 : 0,
          fridayHours: workDays.includes(5) ? 8 : 0,
          saturdayHours: 0,
          sundayHours: 0,
          workDays,
          validFrom,
        },
      });
    }
    return employee.id;
  }

  const getVacation = async (employeeId: string, year: number) =>
    app.inject({
      method: "GET",
      url: `/api/v1/settings/vacation/${employeeId}?year=${year}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

  const putVacation = async (employeeId: string, body: Record<string, unknown>) =>
    app.inject({
      method: "PUT",
      url: `/api/v1/settings/vacation/${employeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: body,
    });

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "svcc450");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("GET first-access heal (D-09)", () => {
    it("creates the CURRENT year's row at the segment-computed value (24), not the newest-row value (30)", async () => {
      const currentYear = new Date().getFullYear();
      const employeeId = await mkEmployee("heal", new Date(Date.UTC(2024, 0, 1)), [
        { validFrom: new Date(Date.UTC(2024, 0, 1)), workDays: [1, 2, 3] }, // Mo-Mi (3-day)
        { validFrom: new Date(Date.UTC(currentYear, 6, 1)), workDays: [1, 2, 3, 4, 5] }, // Mo-Fr from 01.07.
      ]);

      const res = await getVacation(employeeId, currentYear);
      expect(res.statusCode, `must succeed: ${res.body}`).toBe(200);
      const body = JSON.parse(res.body) as { totalDays: number; regularDays: number };
      // 6x18 (Jan-Jun, wd=3) + 6x30 (Jul-Dec, wd=5) = 288; 288/12=24.
      expect(body.totalDays).toBe(24);
      expect(body.regularDays).toBe(24);

      const row = await app.prisma.leaveEntitlement.findFirst({
        where: { employeeId, year: currentYear },
      });
      expect(Number(row?.totalDays)).toBe(24);
    });
  });
});
