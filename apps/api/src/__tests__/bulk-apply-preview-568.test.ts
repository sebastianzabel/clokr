/**
 * Issue #568 — the bulk apply of the tenant's default working time is a two-step flow: a read-only,
 * server-computed preview with a fingerprint, then an apply that accepts only a selection inside
 * the server's own candidate set, only with the matching fingerprint, never retroactively.
 *
 * Why: on 04.10.2026 the one-step apply turned an individual 16 h Mo-Do contract into 40 h Mo-Fr,
 * retroactively and without confirmation. Agreed working time is contract content (§ 611a BGB); a
 * change must be communicated at the latest on the day it takes effect (§ 3 Satz 1 NachwG).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { dbDateStr, todayStr } from "./test-dates";

const DEFAULTS_40 = {
  defaultWeeklyHours: 40,
  defaultMondayHours: 8,
  defaultTuesdayHours: 8,
  defaultWednesdayHours: 8,
  defaultThursdayHours: 8,
  defaultFridayHours: 8,
  defaultSaturdayHours: 0,
  defaultSundayHours: 0,
};

interface PreviewBody {
  effectiveFrom: string;
  earliestEffectiveFrom: string;
  latestEffectiveFrom: string;
  allowedEffectiveFrom: string[];
  fingerprint: string;
  candidates: Array<{
    employeeId: string;
    name: string;
    employeeNumber: string;
    category: "MATCHES_DEFAULTS" | "INDIVIDUAL" | "NO_CONTRACT";
    defaultSelected: boolean;
    before: { weeklyHours: number | null; workDays: number[]; type: string } | null;
    after: { weeklyHours: number | null; workDays: number[] };
  }>;
  nonCandidates: Array<{
    reason: string;
    count: number;
    employees: Array<{ employeeId: string }>;
  }>;
}

describe("Issue #568 — bulk apply preview", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let individualId = "";
  let noContractId = "";
  let shiftId = "";

  async function mkEmployee(
    label: string,
    schedule: "individual16" | "shift" | "none",
  ): Promise<string> {
    const uid = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `bulk568-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `B568-${uid}`,
        firstName: `Vor${label}`,
        lastName: `Schau${label}`,
        hireDate: new Date("2024-01-01"),
      },
    });
    if (schedule === "individual16") {
      await app.prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
          weeklyHours: 16,
          mondayHours: 4,
          tuesdayHours: 4,
          wednesdayHours: 4,
          thursdayHours: 4,
          fridayHours: 0,
          saturdayHours: 0,
          sundayHours: 0,
          workDays: [1, 2, 3, 4],
          validFrom: new Date("2024-01-01"),
        },
      });
    } else if (schedule === "shift") {
      await app.prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
          type: "SHIFT_BASED",
          weeklyHours: 30,
          contractWorkDaysPerWeek: 4,
          validFrom: new Date("2024-01-01"),
        },
      });
    }
    return employee.id;
  }

  async function preview(token: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/settings/work/apply-defaults/preview",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, `bulk568-${Date.now()}`);
    individualId = await mkEmployee("Ind", "individual16");
    noContractId = await mkEmployee("Non", "none");
    shiftId = await mkEmployee("Shf", "shift");
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  describe("preview", () => {
    it("P1: classifies the workforce and answers the response contract", async () => {
      const res = await preview(data.adminToken, DEFAULTS_40);
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body) as PreviewBody;

      const individual = body.candidates.find((c) => c.employeeId === individualId);
      expect(individual?.category).toBe("INDIVIDUAL");
      expect(individual?.defaultSelected).toBe(false);
      expect(individual?.before?.weeklyHours).toBe(16);
      expect(individual?.before?.workDays).toEqual([1, 2, 3, 4]);
      expect(individual?.after.weeklyHours).toBe(40);
      expect(individual?.after.workDays).toEqual([1, 2, 3, 4, 5]);

      const none = body.candidates.find((c) => c.employeeId === noContractId);
      expect(none?.category).toBe("NO_CONTRACT");
      expect(none?.defaultSelected).toBe(true);
      expect(none?.before).toBeNull();

      // The seeded admin and employee have a 40 h Mo-Fr contract = the proposal: not candidates.
      expect(body.candidates.map((c) => c.employeeId)).not.toContain(data.employee.id);

      expect(body.candidates.map((c) => c.employeeId)).not.toContain(shiftId);
      const other = body.nonCandidates.find((g) => g.reason === "OTHER_SCHEDULE_TYPE");
      expect(other?.employees.map((e) => e.employeeId)).toContain(shiftId);
      expect(other?.count).toBe(other?.employees.length);

      expect(body.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(body.effectiveFrom).toBe(body.earliestEffectiveFrom);
      expect(body.allowedEffectiveFrom[0]).toBe(body.earliestEffectiveFrom);
      expect(body.earliestEffectiveFrom.endsWith("-01")).toBe(true);
      expect(body.earliestEffectiveFrom >= todayStr()).toBe(true);
      expect(body.latestEffectiveFrom).toBe(
        body.allowedEffectiveFrom[body.allowedEffectiveFrom.length - 1],
      );
    });

    it("P2: writes no TenantConfig, WorkSchedule or AuditLog row (D-09 g)", async () => {
      const employeeIds = (
        await app.prisma.employee.findMany({
          where: { tenantId: data.tenant.id },
          select: { id: true },
        })
      ).map((e) => e.id);
      const snapshot = async () => ({
        schedules: await app.prisma.workSchedule.count({
          where: { employeeId: { in: employeeIds } },
        }),
        audits: await app.prisma.auditLog.count({ where: { userId: data.adminUser.id } }),
        config: await app.prisma.tenantConfig.findUnique({
          where: { tenantId: data.tenant.id },
          select: { updatedAt: true, defaultWeeklyHours: true },
        }),
      });
      const before = await snapshot();
      expect(
        (await preview(data.adminToken, { ...DEFAULTS_40, defaultWeeklyHours: 36 })).statusCode,
      ).toBe(200);
      expect((await preview(data.adminToken, DEFAULTS_40)).statusCode).toBe(200);
      expect(await snapshot()).toEqual(before);
    });

    it("P3: an effectiveFrom that is not a month-first answers 400 BULK_APPLY_NOT_MONTH_FIRST", async () => {
      const res = await preview(data.adminToken, {
        ...DEFAULTS_40,
        effectiveFrom: dbDateStr(new Date(Date.UTC(2099, 0, 15))),
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(JSON.parse(res.body).code).toBe("BULK_APPLY_NOT_MONTH_FIRST");
    });

    it("P4: a caller without tenant-settings:update gets 403", async () => {
      const res = await preview(data.empToken, DEFAULTS_40);
      expect(res.statusCode, res.body).toBe(403);
    });
  });
});
