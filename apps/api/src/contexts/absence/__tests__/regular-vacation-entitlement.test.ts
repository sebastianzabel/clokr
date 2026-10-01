/**
 * Issue #445 (D-01, D-02, D-03, D-05, D-06) — the regular yearly vacation entitlement, computed
 * in ONE pure function, and the DB-aware ensure/heal wrapper around it.
 *
 * Fixed dates only (2026/2027/2028/2029) — no assertion depends on `new Date()`.
 * Initials-only fixtures (firstName "T", lastName "T") — no PII per CLAUDE.md.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import {
  computeRegularVacationDays,
  calculatePartTimeVacation,
  calculateProRataVacationForHire,
} from "../vacation-calc";
import {
  resolveVacationBaseDays,
  resolveRegularVacationDays,
  isZeroVacationPlaceholder,
  ensureRegularVacationEntitlement,
} from "../leave-days";
import { leaveTypeFields } from "../leave-type";
import type { FastifyInstance } from "fastify";

describe("computeRegularVacationDays (Issue #445, D-01)", () => {
  it("full-time employee, a later year than the hire year: full base days", () => {
    expect(
      computeRegularVacationDays({
        year: 2027,
        hireDate: new Date(2024, 0, 1),
        workDaysPerWeek: 5,
        baseDays: 30,
      }),
    ).toBe(30);
  });

  it("part-time scaling for a later year", () => {
    expect(
      computeRegularVacationDays({
        year: 2027,
        hireDate: new Date(2024, 0, 1),
        workDaysPerWeek: 4,
        baseDays: 30,
      }),
    ).toBe(24);
    expect(
      computeRegularVacationDays({
        year: 2027,
        hireDate: new Date(2024, 0, 1),
        workDaysPerWeek: 4,
        baseDays: 20,
      }),
    ).toBe(16);
    expect(
      computeRegularVacationDays({
        year: 2027,
        hireDate: new Date(2024, 0, 1),
        workDaysPerWeek: 3,
        baseDays: 20,
      }),
    ).toBe(12);
  });

  it("hire-year pro-rata, § 5 Abs. 2 BUrlG rounding", () => {
    // 3/12 × 30 = 7.5, rounded UP to 8 (fraction >= 0.5)
    expect(
      computeRegularVacationDays({
        year: 2027,
        hireDate: new Date(2027, 9, 1),
        workDaysPerWeek: 5,
        baseDays: 30,
      }),
    ).toBe(8);
    // 11/12 × 30 = 27.5 → 28
    expect(
      computeRegularVacationDays({
        year: 2026,
        hireDate: new Date(2026, 1, 1),
        workDaysPerWeek: 5,
        baseDays: 30,
      }),
    ).toBe(28);
    expect(
      computeRegularVacationDays({
        year: 2027,
        hireDate: new Date(2027, 6, 1),
        workDaysPerWeek: 4,
        baseDays: 30,
      }),
    ).toBe(12);
  });

  it("parity with the #416 inline formula (scale first, then hire-year pro-rata)", () => {
    const cases = [
      { year: 2027, hireDate: new Date(2024, 0, 1), workDaysPerWeek: 5, baseDays: 30 },
      { year: 2027, hireDate: new Date(2024, 0, 1), workDaysPerWeek: 4, baseDays: 30 },
      { year: 2027, hireDate: new Date(2024, 0, 1), workDaysPerWeek: 4, baseDays: 20 },
      { year: 2027, hireDate: new Date(2024, 0, 1), workDaysPerWeek: 3, baseDays: 20 },
      { year: 2027, hireDate: new Date(2027, 9, 1), workDaysPerWeek: 5, baseDays: 30 },
      { year: 2026, hireDate: new Date(2026, 1, 1), workDaysPerWeek: 5, baseDays: 30 },
      { year: 2027, hireDate: new Date(2027, 6, 1), workDaysPerWeek: 4, baseDays: 30 },
    ];
    for (const c of cases) {
      const scaledBase = calculatePartTimeVacation(
        {
          mondayHours: 0,
          tuesdayHours: 0,
          wednesdayHours: 0,
          thursdayHours: 0,
          fridayHours: 0,
          saturdayHours: 0,
          sundayHours: 0,
          contractWorkDaysPerWeek: c.workDaysPerWeek,
        },
        5,
        c.baseDays,
      );
      const inline =
        c.year === c.hireDate.getFullYear()
          ? calculateProRataVacationForHire(scaledBase, c.year, c.hireDate)
          : scaledBase;
      expect(computeRegularVacationDays(c)).toBe(inline);
    }
  });
});

describe("regular VACATION entitlement wrapper (Issue #445, D-02/D-03/D-05/D-06)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  type EmployeeKind = "FIXED" | "SHIFT_BASED";

  async function mkEmployee(
    label: string,
    kind: EmployeeKind = "FIXED",
    overrides: { hireDate?: Date; exitDate?: Date } = {},
  ): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `rve-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `RVE-${label}-${uid}`,
        firstName: "T",
        lastName: "T",
        hireDate: overrides.hireDate ?? new Date(Date.UTC(2024, 0, 1)),
        exitDate: overrides.exitDate ?? null,
      },
    });
    if (kind === "SHIFT_BASED") {
      await app.prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
          type: "SHIFT_BASED",
          contractWorkDaysPerWeek: 4,
          workDays: [1, 2, 3, 4, 5, 6],
          validFrom: new Date(Date.UTC(2024, 0, 1)),
        },
      });
    } else {
      await app.prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
          type: "FIXED_SCHEDULE",
          mondayHours: 8,
          tuesdayHours: 8,
          wednesdayHours: 8,
          thursdayHours: 8,
          fridayHours: 8,
          saturdayHours: 0,
          sundayHours: 0,
          validFrom: new Date(Date.UTC(2024, 0, 1)),
        },
      });
    }
    return employee.id;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "rve");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("resolveVacationBaseDays returns the tenant default", async () => {
    const result = await resolveVacationBaseDays(app.prisma, data.employee.id, data.tenant.id);
    expect(result).toBe(30);
  });

  describe("resolveRegularVacationDays", () => {
    it("hired 2024-01-01, FIXED full-time -> 30", async () => {
      const employeeId = await mkEmployee("rrd-fixed");
      const result = await resolveRegularVacationDays(app.prisma, employeeId, data.tenant.id, 2027);
      expect(result).toBe(30);
    });

    it("SHIFT_BASED contract 4 -> 24", async () => {
      const employeeId = await mkEmployee("rrd-shift", "SHIFT_BASED");
      const result = await resolveRegularVacationDays(app.prisma, employeeId, data.tenant.id, 2027);
      expect(result).toBe(24);
    });

    it("exited before the queried year -> 0", async () => {
      const employeeId = await mkEmployee("rrd-exit-before", "FIXED", {
        exitDate: new Date(Date.UTC(2026, 5, 30)),
      });
      const result = await resolveRegularVacationDays(app.prisma, employeeId, data.tenant.id, 2027);
      expect(result).toBe(0);
    });

    it("exited inside the queried year -> full value", async () => {
      const employeeId = await mkEmployee("rrd-exit-inside", "FIXED", {
        exitDate: new Date(Date.UTC(2027, 5, 30)),
      });
      const result = await resolveRegularVacationDays(app.prisma, employeeId, data.tenant.id, 2027);
      expect(result).toBe(30);
    });

    it("hired after the queried year -> 0", async () => {
      const employeeId = await mkEmployee("rrd-hire-after", "FIXED", {
        hireDate: new Date(Date.UTC(2028, 2, 1)),
      });
      const result = await resolveRegularVacationDays(app.prisma, employeeId, data.tenant.id, 2027);
      expect(result).toBe(0);
    });
  });

  describe("isZeroVacationPlaceholder", () => {
    it("a row created with totalDays 0 and no audit -> true", async () => {
      const employeeId = await mkEmployee("zp-plain");
      const row = await app.prisma.leaveEntitlement.create({
        data: { employeeId, leaveTypeId: data.vacationType.id, year: 2027, totalDays: 0 },
      });
      expect(await isZeroVacationPlaceholder(app.prisma, row)).toBe(true);
    });

    it("isAutoCalculated true -> false", async () => {
      const employeeId = await mkEmployee("zp-auto");
      const row = await app.prisma.leaveEntitlement.create({
        data: {
          employeeId,
          leaveTypeId: data.vacationType.id,
          year: 2027,
          totalDays: 0,
          isAutoCalculated: true,
        },
      });
      expect(await isZeroVacationPlaceholder(app.prisma, row)).toBe(false);
    });

    it("totalDays 5 -> false", async () => {
      const employeeId = await mkEmployee("zp-nonzero");
      const row = await app.prisma.leaveEntitlement.create({
        data: { employeeId, leaveTypeId: data.vacationType.id, year: 2027, totalDays: 5 },
      });
      expect(await isZeroVacationPlaceholder(app.prisma, row)).toBe(false);
    });

    it("a 0 row plus an AuditLog CREATE whose newValue sets totalDays -> false (human write)", async () => {
      const employeeId = await mkEmployee("zp-human-create");
      const row = await app.prisma.leaveEntitlement.create({
        data: { employeeId, leaveTypeId: data.vacationType.id, year: 2027, totalDays: 0 },
      });
      await app.prisma.auditLog.create({
        data: {
          userId: null,
          action: "CREATE",
          entity: "LeaveEntitlement",
          entityId: row.id,
          newValue: { year: 2027, totalDays: 0 },
        },
      });
      expect(await isZeroVacationPlaceholder(app.prisma, row)).toBe(false);
    });

    it("a 0 row plus an AuditLog UPDATE unrelated to totalDays -> true (still a placeholder)", async () => {
      const employeeId = await mkEmployee("zp-carry-only");
      const row = await app.prisma.leaveEntitlement.create({
        data: { employeeId, leaveTypeId: data.vacationType.id, year: 2027, totalDays: 0 },
      });
      await app.prisma.auditLog.create({
        data: {
          userId: null,
          action: "UPDATE",
          entity: "LeaveEntitlement",
          entityId: row.id,
          newValue: { carriedOverDays: 5, reason: "x" },
        },
      });
      expect(await isZeroVacationPlaceholder(app.prisma, row)).toBe(true);
    });
  });

  describe("ensureRegularVacationEntitlement", () => {
    it("missing row -> created with the regular entitlement and one CREATE audit", async () => {
      const employeeId = await mkEmployee("erve-missing");
      const result = await ensureRegularVacationEntitlement(
        app.prisma,
        employeeId,
        data.tenant.id,
        2027,
        data.vacationType.id,
        "R",
      );
      expect(result.created).toBe(true);
      expect(result.healed).toBe(false);
      expect(Number(result.entitlement.totalDays)).toBe(30);
      expect(result.entitlement.isAutoCalculated).toBe(true);

      const audits = await app.prisma.auditLog.findMany({
        where: { entity: "LeaveEntitlement", entityId: result.entitlement.id, action: "CREATE" },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]!.userId).toBeNull();
      const newValue = audits[0]!.newValue as { totalDays: number; reason: string };
      expect(newValue.totalDays).toBe(30);
      expect(newValue.reason).toBe("R");
    });

    it("placeholder row -> healed with totalDays + isAutoCalculated + one UPDATE audit; idempotent on a second call", async () => {
      const employeeId = await mkEmployee("erve-placeholder");
      const placeholder = await app.prisma.leaveEntitlement.create({
        data: { employeeId, leaveTypeId: data.vacationType.id, year: 2028, totalDays: 0 },
      });

      const first = await ensureRegularVacationEntitlement(
        app.prisma,
        employeeId,
        data.tenant.id,
        2028,
        data.vacationType.id,
        "R",
      );
      expect(first.created).toBe(false);
      expect(first.healed).toBe(true);
      expect(Number(first.entitlement.totalDays)).toBe(30);
      expect(first.entitlement.isAutoCalculated).toBe(true);

      const audits = await app.prisma.auditLog.findMany({
        where: { entity: "LeaveEntitlement", entityId: placeholder.id, action: "UPDATE" },
      });
      expect(audits).toHaveLength(1);
      const oldValue = audits[0]!.oldValue as { totalDays: number };
      const newValue = audits[0]!.newValue as { totalDays: number; isAutoCalculated: boolean };
      expect(oldValue.totalDays).toBe(0);
      expect(newValue.totalDays).toBe(30);
      expect(newValue.isAutoCalculated).toBe(true);

      const second = await ensureRegularVacationEntitlement(
        app.prisma,
        employeeId,
        data.tenant.id,
        2028,
        data.vacationType.id,
        "R",
      );
      expect(second.created).toBe(false);
      expect(second.healed).toBe(false);

      const auditsAfter = await app.prisma.auditLog.count({
        where: { entity: "LeaveEntitlement", entityId: placeholder.id },
      });
      expect(auditsAfter).toBe(1);
    });

    it("a 0 row with a human CREATE audit -> untouched", async () => {
      const employeeId = await mkEmployee("erve-human-zero");
      const row = await app.prisma.leaveEntitlement.create({
        data: { employeeId, leaveTypeId: data.vacationType.id, year: 2029, totalDays: 0 },
      });
      await app.prisma.auditLog.create({
        data: {
          userId: null,
          action: "CREATE",
          entity: "LeaveEntitlement",
          entityId: row.id,
          newValue: { year: 2029, totalDays: 0 },
        },
      });

      const result = await ensureRegularVacationEntitlement(
        app.prisma,
        employeeId,
        data.tenant.id,
        2029,
        data.vacationType.id,
        "R",
      );
      expect(result.created).toBe(false);
      expect(result.healed).toBe(false);
      expect(Number(result.entitlement.totalDays)).toBe(0);

      const auditCount = await app.prisma.auditLog.count({
        where: { entity: "LeaveEntitlement", entityId: row.id },
      });
      expect(auditCount).toBe(1); // no new audit written beyond the human one
    });

    it("exited employee -> created with totalDays 0 and isAutoCalculated true (never a placeholder)", async () => {
      const employeeId = await mkEmployee("erve-exited", "FIXED", {
        exitDate: new Date(Date.UTC(2026, 5, 30)),
      });
      const result = await ensureRegularVacationEntitlement(
        app.prisma,
        employeeId,
        data.tenant.id,
        2027,
        data.vacationType.id,
        "R",
      );
      expect(result.created).toBe(true);
      expect(Number(result.entitlement.totalDays)).toBe(0);
      expect(result.entitlement.isAutoCalculated).toBe(true);
    });

    it("a non-VACATION leaveTypeId -> creates a 0 row with one CREATE audit (today's behaviour)", async () => {
      const specialType = await app.prisma.leaveType.create({
        data: { tenantId: data.tenant.id, ...leaveTypeFields("SPECIAL") },
      });
      const employeeId = await mkEmployee("erve-special");
      const result = await ensureRegularVacationEntitlement(
        app.prisma,
        employeeId,
        data.tenant.id,
        2027,
        specialType.id,
        "R",
      );
      expect(result.created).toBe(true);
      expect(Number(result.entitlement.totalDays)).toBe(0);

      const audits = await app.prisma.auditLog.findMany({
        where: { entity: "LeaveEntitlement", entityId: result.entitlement.id, action: "CREATE" },
      });
      expect(audits).toHaveLength(1);
    });
  });
});
