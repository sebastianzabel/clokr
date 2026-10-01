/**
 * Issue #445 (D-07) — repair-script tests for repair-zero-vacation-entitlements.ts.
 *
 * Covers:
 *   - Tenant-selection required (throws German error without --tenant-id | --all-tenants)
 *   - CLI parsing: --year, --confirm, --include-flagged; an invalid --year throws a German error
 *   - Dry-run: lists every zero placeholder with a target > 0, flags PRUEFEN per D-07, writes
 *     NOTHING
 *   - --year filters candidates to that one year
 *   - --confirm heals unflagged candidates only; flagged rows are skipped (summary.skippedFlagged)
 *   - --confirm --include-flagged also heals flagged rows
 *   - A human-written zero (audited CREATE) and an employee not employed in the target year
 *     (target 0) are never candidates
 *   - A third run after everything is healed finds zero candidates (idempotent)
 *
 * Uses initials-only for employee names (no PII per memory feedback_no_pii_in_github).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import { main, parseCli } from "../repair-zero-vacation-entitlements";
import type { FastifyInstance } from "fastify";

describe("repair-zero-vacation-entitlements (Issue #445, D-07)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // Scenario A: prior-year row healthy (30) -> candidate, target 30, flag null.
  let employeeA: string;
  let entitlementA2027: string;
  // Scenario B: prior-year row divergent (20) -> candidate, target 30, flag PRUEFEN.
  let employeeB: string;
  let entitlementB2027: string;
  // Scenario C: a human-written zero (audited CREATE) -> never a candidate.
  let employeeC: string;
  // Scenario D: exited before the target year -> target 0 -> never a candidate.
  let employeeD: string;
  // Scenario E: hired mid-2026 (Feb 1, on/before the G9 Wartezeit cutoff — Issue #435, owner
  // Ergänzung), no 2025 row -> candidate, target 30 (full value, no pro-rata), priorYear null,
  // flag null. Was target 28 (11/12 pro-rated) before the Ergänzung.
  let employeeE: string;
  let entitlementE2026: string;

  const mkEmployee = async (
    label: string,
    overrides: { hireDate?: Date; exitDate?: Date } = {},
  ): Promise<string> => {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `rzve-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `RZVE-${label}-${uid}`,
        firstName: "T",
        lastName: "T",
        hireDate: overrides.hireDate ?? new Date(Date.UTC(2024, 0, 1)),
        exitDate: overrides.exitDate ?? null,
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
  };

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "rzve");

    employeeA = await mkEmployee("a");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: employeeA,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 30,
        isAutoCalculated: true,
      },
    });
    const a2027 = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: employeeA,
        leaveTypeId: data.vacationType.id,
        year: 2027,
        totalDays: 0,
        isAutoCalculated: false,
      },
    });
    entitlementA2027 = a2027.id;

    employeeB = await mkEmployee("b");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: employeeB,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 20,
        isAutoCalculated: false,
      },
    });
    const b2027 = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: employeeB,
        leaveTypeId: data.vacationType.id,
        year: 2027,
        totalDays: 0,
        isAutoCalculated: false,
      },
    });
    entitlementB2027 = b2027.id;

    employeeC = await mkEmployee("c");
    const c2027 = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: employeeC,
        leaveTypeId: data.vacationType.id,
        year: 2027,
        totalDays: 0,
        isAutoCalculated: false,
      },
    });
    await app.prisma.auditLog.create({
      data: {
        userId: null,
        action: "CREATE",
        entity: "LeaveEntitlement",
        entityId: c2027.id,
        newValue: { year: 2027, totalDays: 0 },
      },
    });

    employeeD = await mkEmployee("d", { exitDate: new Date(Date.UTC(2026, 5, 30)) });
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: employeeD,
        leaveTypeId: data.vacationType.id,
        year: 2027,
        totalDays: 0,
        isAutoCalculated: false,
      },
    });

    employeeE = await mkEmployee("e", { hireDate: new Date(Date.UTC(2026, 1, 1)) });
    const e2026 = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: employeeE,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 0,
        isAutoCalculated: false,
      },
    });
    entitlementE2026 = e2026.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("rejects without --tenant-id or --all-tenants", async () => {
    await expect(main([], app.prisma)).rejects.toThrow(/Tenant-Auswahl erforderlich/);
  });

  it("parses --tenant-id, --year, --confirm, --include-flagged", () => {
    expect(
      parseCli(["--tenant-id", "abc", "--year", "2027", "--confirm", "--include-flagged"]),
    ).toEqual({
      tenantId: "abc",
      allTenants: false,
      year: 2027,
      confirm: true,
      includeFlagged: true,
      help: false,
    });
  });

  it("rejects a non-numeric --year with a German error", () => {
    expect(() => parseCli(["--all-tenants", "--year", "x"])).toThrow(/Ungültiges Jahr/);
  });

  it("dry-run lists exactly A, B, E as candidates with the expected numbers, writes NOTHING", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const summary = await main(["--tenant-id", data.tenant.id], app.prisma);
      expect(summary.dryRun).toBe(true);

      const byEmployee = new Map(summary.candidates.map((c) => [c.employeeId, c]));
      const a = byEmployee.get(employeeA);
      expect(a).toMatchObject({
        year: 2027,
        currentTotalDays: 0,
        targetTotalDays: 30,
        priorYearTotalDays: 30,
        flag: null,
      });
      const b = byEmployee.get(employeeB);
      expect(b).toMatchObject({
        year: 2027,
        currentTotalDays: 0,
        targetTotalDays: 30,
        priorYearTotalDays: 20,
        flag: "PRUEFEN",
      });
      const e = byEmployee.get(employeeE);
      expect(e).toMatchObject({
        year: 2026,
        currentTotalDays: 0,
        targetTotalDays: 30,
        priorYearTotalDays: null,
        flag: null,
      });

      expect(byEmployee.has(employeeC)).toBe(false);
      expect(byEmployee.has(employeeD)).toBe(false);

      // No row changed by a dry run.
      const unchangedA = await app.prisma.leaveEntitlement.findUnique({
        where: { id: entitlementA2027 },
      });
      expect(Number(unchangedA?.totalDays)).toBe(0);
      expect(unchangedA?.isAutoCalculated).toBe(false);

      const dryRunLines = infoSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith("[DRY-RUN]"));
      expect(dryRunLines.length).toBeGreaterThanOrEqual(3);
      const lineRegex =
        /^\[DRY-RUN\] entitlementId=\S+ employeeId=\S+ employeeNumber=\S+ year=\d{4} totalDays=0 target=[\d.]+ priorYear=\S+ flag=(PRUEFEN|-)$/;
      for (const line of dryRunLines) {
        expect(line).toMatch(lineRegex);
      }
      // No employee name field ever appears in the printed output.
      for (const line of dryRunLines) {
        expect(line).not.toMatch(/firstName|lastName/i);
      }
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("--year 2026 dry-run finds only E", async () => {
    const summary = await main(["--tenant-id", data.tenant.id, "--year", "2026"], app.prisma);
    expect(summary.candidates.map((c) => c.employeeId)).toEqual([employeeE]);
  });

  it("--confirm heals A and E, skips flagged B, leaves C and D untouched", async () => {
    const summary = await main(["--tenant-id", data.tenant.id, "--confirm"], app.prisma);
    expect(summary.dryRun).toBe(false);
    expect(summary.applied).toBeGreaterThanOrEqual(2);
    expect(summary.skippedFlagged).toBeGreaterThanOrEqual(1);

    const healedA = await app.prisma.leaveEntitlement.findUnique({
      where: { id: entitlementA2027 },
    });
    expect(Number(healedA?.totalDays)).toBe(30);
    expect(healedA?.isAutoCalculated).toBe(true);
    const auditA = await app.prisma.auditLog.findFirst({
      where: { entity: "LeaveEntitlement", entityId: entitlementA2027, action: "UPDATE" },
    });
    expect(auditA).not.toBeNull();
    expect(auditA?.oldValue).toMatchObject({ totalDays: 0 });
    expect((auditA?.newValue as { reason?: string } | null)?.reason).toBe(
      "Korrektur Urlaubsanspruch 0 (Issue #445)",
    );

    const healedE = await app.prisma.leaveEntitlement.findUnique({
      where: { id: entitlementE2026 },
    });
    expect(Number(healedE?.totalDays)).toBe(30);
    expect(healedE?.isAutoCalculated).toBe(true);

    const stillZeroB = await app.prisma.leaveEntitlement.findUnique({
      where: { id: entitlementB2027 },
    });
    expect(Number(stillZeroB?.totalDays)).toBe(0);
    expect(stillZeroB?.isAutoCalculated).toBe(false);

    // C (human zero) and D (exited, target 0) are never touched.
    const untouchedC = await app.prisma.leaveEntitlement.findFirst({
      where: { employeeId: employeeC, year: 2027 },
    });
    expect(Number(untouchedC?.totalDays)).toBe(0);
    const untouchedD = await app.prisma.leaveEntitlement.findFirst({
      where: { employeeId: employeeD, year: 2027 },
    });
    expect(Number(untouchedD?.totalDays)).toBe(0);
  });

  it("--confirm --include-flagged heals B", async () => {
    const summary = await main(
      ["--tenant-id", data.tenant.id, "--confirm", "--include-flagged"],
      app.prisma,
    );
    expect(summary.applied).toBeGreaterThanOrEqual(1);

    const healedB = await app.prisma.leaveEntitlement.findUnique({
      where: { id: entitlementB2027 },
    });
    expect(Number(healedB?.totalDays)).toBe(30);
    expect(healedB?.isAutoCalculated).toBe(true);
  });

  it("a third --confirm --include-flagged run finds 0 candidates; audit counts unchanged", async () => {
    const auditCountBefore = await app.prisma.auditLog.count({
      where: {
        entity: "LeaveEntitlement",
        entityId: { in: [entitlementA2027, entitlementB2027, entitlementE2026] },
      },
    });

    const summary = await main(
      ["--tenant-id", data.tenant.id, "--confirm", "--include-flagged"],
      app.prisma,
    );
    expect(summary.candidates).toHaveLength(0);
    expect(summary.applied).toBe(0);

    const auditCountAfter = await app.prisma.auditLog.count({
      where: {
        entity: "LeaveEntitlement",
        entityId: { in: [entitlementA2027, entitlementB2027, entitlementE2026] },
      },
    });
    expect(auditCountAfter).toBe(auditCountBefore);
  });
});
