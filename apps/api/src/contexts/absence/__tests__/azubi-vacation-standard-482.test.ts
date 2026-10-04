/**
 * Issue #482 (owner decision 2026-10-04) — the Azubi-Standard
 * (`TenantConfig.defaultApprenticeVacationDays`) becomes a calculation input of the regular
 * yearly vacation entitlement for an AZUBI without a person value, instead of only pre-filling
 * the create dialog (superseding #416 decision 3 / #435 D-05).
 *
 * Fixed years only (2024/2026/2027) — no assertion depends on `new Date()`. Initials-only
 * fixtures (firstName "T", lastName "T") — no PII per CLAUDE.md.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import {
  resolveVacationBaseDays,
  resolveRegularVacationDays,
  ensureRegularVacationEntitlement,
  REGULAR_ENTITLEMENT_REASON_ROLLOVER,
} from "../leave-days";
import type { FastifyInstance } from "fastify";
import type { EmployeeClassification } from "@clokr/db";

describe("Azubi-Standard as a calculation input (Issue #482)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let dataNoConfig: Awaited<ReturnType<typeof seedTestData>>;

  async function mkEmployee(
    label: string,
    opts: {
      tenantId?: string;
      hireDate?: Date;
      exitDate?: Date | null;
      classification?: EmployeeClassification;
      birthDate?: Date | null;
      annualVacationDays?: number | null;
      workDays?: number[]; // weekday indices 1=Mo..5=Fr; default Mo-Fr
    } = {},
  ): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const tenantId = opts.tenantId ?? data.tenant.id;
    const user = await app.prisma.user.create({
      data: {
        email: `az482-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const hireDate = opts.hireDate ?? new Date(Date.UTC(2024, 0, 1));
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `AZ482-${label}-${uid}`,
        firstName: "T",
        lastName: "T",
        classification: opts.classification ?? "VOLLZEIT",
        hireDate,
        exitDate: opts.exitDate ?? null,
        birthDate: opts.birthDate ?? null,
        annualVacationDays: opts.annualVacationDays ?? null,
      },
    });
    const workDays = opts.workDays ?? [1, 2, 3, 4, 5];
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "FIXED_SCHEDULE",
        mondayHours: workDays.includes(1) ? 8 : 0,
        tuesdayHours: workDays.includes(2) ? 8 : 0,
        wednesdayHours: workDays.includes(3) ? 8 : 0,
        thursdayHours: workDays.includes(4) ? 8 : 0,
        fridayHours: workDays.includes(5) ? 8 : 0,
        saturdayHours: workDays.includes(6) ? 8 : 0,
        sundayHours: workDays.includes(0) ? 8 : 0,
        workDays,
        validFrom: hireDate,
      },
    });
    return employee.id;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "az482");
    dataNoConfig = await seedTestData(app, "az482n");

    // Tenant default stays the schema's 30; the Azubi-Standard is set to a value
    // (22.5) distinguishable from the schema default (20), the adult floor (20) and the
    // tenant default (30) — G-1/AC-1.
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { defaultApprenticeVacationDays: 22.5 },
    });
    // G-1: a tenant with no TenantConfig row at all resolves to 30 (chain step 4), not the
    // column's schema default 20 — the owner chain names the TenantConfig value, which does
    // not exist for this tenant.
    await app.prisma.tenantConfig.delete({ where: { tenantId: dataNoConfig.tenant.id } });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, dataNoConfig.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("resolveVacationBaseDays", () => {
    it("B1: AZUBI, no person value -> the Azubi-Standard (22.5)", async () => {
      const employeeId = await mkEmployee("b1", { classification: "AZUBI" });
      const result = await resolveVacationBaseDays(app.prisma, employeeId, data.tenant.id);
      expect(result).toBe(22.5);
    });

    it("B2 (AC-2 control): AZUBI with a person value -> the person value wins (24)", async () => {
      const employeeId = await mkEmployee("b2", {
        classification: "AZUBI",
        annualVacationDays: 24,
      });
      const result = await resolveVacationBaseDays(app.prisma, employeeId, data.tenant.id);
      expect(result).toBe(24);
    });

    it("B3 (AC-3 control): VOLLZEIT, no person value -> the tenant default (30)", async () => {
      const employeeId = await mkEmployee("b3", { classification: "VOLLZEIT" });
      const result = await resolveVacationBaseDays(app.prisma, employeeId, data.tenant.id);
      expect(result).toBe(30);
    });

    it("B4 (G-1 control): AZUBI in a tenant with no TenantConfig row -> 30 (chain step 4)", async () => {
      const employeeId = await mkEmployee("b4", {
        tenantId: dataNoConfig.tenant.id,
        classification: "AZUBI",
      });
      const result = await resolveVacationBaseDays(app.prisma, employeeId, dataNoConfig.tenant.id);
      expect(result).toBe(30);
    });
  });

  describe("resolveRegularVacationDays (AC-1/AC-5)", () => {
    it("B5: AZUBI, Mo-Fr, no birth date, year 2027 -> 22.5", async () => {
      const employeeId = await mkEmployee("b5", {
        classification: "AZUBI",
        birthDate: null,
      });
      const result = await resolveRegularVacationDays(app.prisma, employeeId, data.tenant.id, 2027);
      expect(result).toBe(22.5);
    });

    it("B6: AZUBI, Mo-Do (4 contract days), year 2027 -> 18 (contract scaling)", async () => {
      const employeeId = await mkEmployee("b6", {
        classification: "AZUBI",
        birthDate: null,
        workDays: [1, 2, 3, 4],
      });
      const result = await resolveRegularVacationDays(app.prisma, employeeId, data.tenant.id, 2027);
      expect(result).toBe(18);
    });

    it("B7 (AC-5): minor AZUBI (born 2012-06-15), Mo-Fr, no person value, year 2027 -> 25 (floor beats the apprentice default)", async () => {
      const employeeId = await mkEmployee("b7", {
        classification: "AZUBI",
        birthDate: new Date(Date.UTC(2012, 5, 15)),
      });
      const result = await resolveRegularVacationDays(app.prisma, employeeId, data.tenant.id, 2027);
      expect(result).toBe(25);
    });
  });

  describe("ensureRegularVacationEntitlement (AC-4)", () => {
    it("B8: missing row, AZUBI, Mo-Fr -> created, totalDays 22.5, isAutoCalculated, one CREATE audit", async () => {
      const employeeId = await mkEmployee("b8", { classification: "AZUBI", birthDate: null });
      const result = await ensureRegularVacationEntitlement(
        app.prisma,
        employeeId,
        data.tenant.id,
        2027,
        data.vacationType.id,
        REGULAR_ENTITLEMENT_REASON_ROLLOVER,
      );
      expect(result.created).toBe(true);
      expect(Number(result.entitlement.totalDays)).toBe(22.5);
      expect(result.entitlement.isAutoCalculated).toBe(true);

      const audits = await app.prisma.auditLog.findMany({
        where: { entity: "LeaveEntitlement", entityId: result.entitlement.id, action: "CREATE" },
      });
      expect(audits).toHaveLength(1);
    });

    it("B9: zero placeholder, no prior-year row -> healed, totalDays 22.5, one UPDATE audit", async () => {
      const employeeId = await mkEmployee("b9", { classification: "AZUBI", birthDate: null });
      const placeholder = await app.prisma.leaveEntitlement.create({
        data: { employeeId, leaveTypeId: data.vacationType.id, year: 2027, totalDays: 0 },
      });

      const result = await ensureRegularVacationEntitlement(
        app.prisma,
        employeeId,
        data.tenant.id,
        2027,
        data.vacationType.id,
        REGULAR_ENTITLEMENT_REASON_ROLLOVER,
      );
      expect(result.created).toBe(false);
      expect(result.healed).toBe(true);
      expect(Number(result.entitlement.totalDays)).toBe(22.5);

      const audits = await app.prisma.auditLog.findMany({
        where: { entity: "LeaveEntitlement", entityId: placeholder.id, action: "UPDATE" },
      });
      expect(audits).toHaveLength(1);
    });

    it("B10 (G-4): zero placeholder plus a deviating prior-year row -> needsReview, 2027 stays 0, no heal", async () => {
      const employeeId = await mkEmployee("b10", { classification: "AZUBI", birthDate: null });
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
        data: { employeeId, leaveTypeId: data.vacationType.id, year: 2027, totalDays: 0 },
      });

      const result = await ensureRegularVacationEntitlement(
        app.prisma,
        employeeId,
        data.tenant.id,
        2027,
        data.vacationType.id,
        REGULAR_ENTITLEMENT_REASON_ROLLOVER,
      );
      expect(result.needsReview).toBe(true);
      expect(result.healed).toBe(false);
      expect(Number(result.entitlement.totalDays)).toBe(0);

      const audits = await app.prisma.auditLog.findMany({
        where: { entity: "LeaveEntitlement", entityId: placeholder.id, action: "UPDATE" },
      });
      expect(audits).toHaveLength(0);
    });

    it("B11 (AC-4/#435 D-15): an existing non-placeholder row is never rewritten by a settings change", async () => {
      const employeeId = await mkEmployee("b11", { classification: "AZUBI", birthDate: null });
      const existing = await app.prisma.leaveEntitlement.create({
        data: {
          employeeId,
          leaveTypeId: data.vacationType.id,
          year: 2027,
          totalDays: 30,
          isAutoCalculated: true,
        },
      });

      const first = await ensureRegularVacationEntitlement(
        app.prisma,
        employeeId,
        data.tenant.id,
        2027,
        data.vacationType.id,
        REGULAR_ENTITLEMENT_REASON_ROLLOVER,
      );
      expect(first.healed).toBe(false);
      expect(Number(first.entitlement.totalDays)).toBe(30);

      try {
        const res = await app.inject({
          method: "PUT",
          url: "/api/v1/settings/work",
          headers: { authorization: `Bearer ${data.adminToken}` },
          payload: { defaultApprenticeVacationDays: 23 },
        });
        expect(res.statusCode).toBe(200);

        const row = await app.prisma.leaveEntitlement.findUniqueOrThrow({
          where: { id: existing.id },
        });
        expect(Number(row.totalDays)).toBe(30);

        const audits = await app.prisma.auditLog.count({
          where: { entity: "LeaveEntitlement", entityId: existing.id },
        });
        expect(audits).toBe(0);
      } finally {
        await app.prisma.tenantConfig.update({
          where: { tenantId: data.tenant.id },
          data: { defaultApprenticeVacationDays: 22.5 },
        });
      }
    });
  });
});
