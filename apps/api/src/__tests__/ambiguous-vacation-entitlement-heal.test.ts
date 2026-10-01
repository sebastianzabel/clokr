/**
 * Issue #445 — coordinator deviation from CONTEXT D-05 (Plan 01, recorded in the SUMMARY).
 *
 * The heal-on-read path (`ensureRegularVacationEntitlement`'s existing-row branch,
 * `selfHealUsedDays`, GET /leave/entitlements, GET /reports/leave-overview) must NOT heal a
 * zero placeholder when the employee had a full prior year on record whose VACATION row is
 * itself reliable and whose totalDays differs from the computed regular value — the exact
 * PRUEFEN condition `repair-zero-vacation-entitlements.ts` already used (now shared via
 * `isAmbiguousRegularEntitlement` in `contexts/absence/leave-days.ts`). This protects
 * Azubis/individual contracts (e.g. 20 days) from being silently raised to the #416
 * tenant-default (e.g. 30) on the first page load after deploy.
 *
 * Fixed dates only (2026/2027) — no assertion depends on `new Date()`. Every scenario uses its
 * own fresh employee (FIXED Mo-Fr WorkSchedule validFrom 2024-01-01, initials-only).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("Issue #445 — ambiguous zero-placeholder heal is gated (coordinator deviation from D-05)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  async function mkEmployee(label: string): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `avh-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `AVH-${label}-${uid}`,
        firstName: "T",
        lastName: "T",
        hireDate: new Date(Date.UTC(2024, 0, 1)),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "FIXED_SCHEDULE",
        validFrom: new Date(Date.UTC(2024, 0, 1)),
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
      },
    });
    return employee.id;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "avh");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("a flagged row (prior full year 20, computed 30) is NOT healed, has no audit, and shows the warning on GET /leave/entitlements and the report", async () => {
    const employeeId = await mkEmployee("flagged");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 20,
        isAutoCalculated: false,
      },
    });
    const placeholder = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2027,
        totalDays: 0,
        isAutoCalculated: false,
      },
    });

    const entRes = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${employeeId}?year=2027`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(entRes.statusCode).toBe(200);
    const entRows = JSON.parse(entRes.body) as Array<{
      leaveTypeId: string;
      totalDays: string | number;
      entitlementWarning: string | null;
    }>;
    const vacRow = entRows.find((r) => r.leaveTypeId === data.vacationType.id);
    expect(vacRow).toBeDefined();
    expect(Number(vacRow?.totalDays)).toBe(0);
    expect(vacRow?.entitlementWarning).toBe("Urlaubsanspruch für 2027 fehlt – bitte prüfen");

    // DB row stays at 0 — no totalDays heal, no heal audit. GET /entitlements calls
    // autoCarryOver() first (targetYear's own machinery, independent of the ambiguity gate),
    // which legitimately rolls the prior year's remainder into carriedOverDays and audits THAT
    // change — a separate concern from the totalDays heal this test is about, so it is expected
    // here, not a regression.
    const dbRow = await app.prisma.leaveEntitlement.findUnique({
      where: { id: placeholder.id },
    });
    expect(Number(dbRow?.totalDays)).toBe(0);
    expect(dbRow?.isAutoCalculated).toBe(false);
    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "LeaveEntitlement", entityId: placeholder.id },
    });
    const totalDaysHealAudit = audits.find((a) => {
      const nv = a.newValue as { totalDays?: unknown; isAutoCalculated?: unknown } | null;
      return nv !== null && typeof nv === "object" && nv.isAutoCalculated === true;
    });
    expect(totalDaysHealAudit).toBeUndefined();

    // Same warning surfaces on the report.
    const reportRes = await app.inject({
      method: "GET",
      url: "/api/v1/reports/leave-overview?year=2027",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(reportRes.statusCode).toBe(200);
    const reportRows = JSON.parse(reportRes.body) as Array<{
      employee: { id: string };
      entitlementWarning: string | null;
    }>;
    const reportRow = reportRows.find((r) => r.employee.id === employeeId);
    expect(reportRow).toBeDefined();
    expect(reportRow?.entitlementWarning).toBe("Urlaubsanspruch für 2027 fehlt – bitte prüfen");
  });

  it("an unflagged row (prior full year 30, computed 30) IS healed with an UPDATE audit and has no warning", async () => {
    const employeeId = await mkEmployee("unflagged");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 30,
        isAutoCalculated: true,
      },
    });
    const placeholder = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: 2027,
        totalDays: 0,
        isAutoCalculated: false,
      },
    });

    const entRes = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${employeeId}?year=2027`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(entRes.statusCode).toBe(200);
    const entRows = JSON.parse(entRes.body) as Array<{
      leaveTypeId: string;
      totalDays: string | number;
      entitlementWarning: string | null;
    }>;
    const vacRow = entRows.find((r) => r.leaveTypeId === data.vacationType.id);
    expect(vacRow).toBeDefined();
    expect(Number(vacRow?.totalDays)).toBe(30);
    expect(vacRow?.entitlementWarning).toBeNull();

    const dbRow = await app.prisma.leaveEntitlement.findUnique({
      where: { id: placeholder.id },
    });
    expect(Number(dbRow?.totalDays)).toBe(30);
    expect(dbRow?.isAutoCalculated).toBe(true);
    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "LeaveEntitlement", entityId: placeholder.id, action: "UPDATE" },
    });
    expect(audit).not.toBeNull();
  });
});
