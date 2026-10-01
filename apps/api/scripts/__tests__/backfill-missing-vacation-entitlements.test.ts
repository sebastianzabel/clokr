/**
 * Issue #416 — repair-script tests for backfill-missing-vacation-entitlements.ts.
 *
 * Covers:
 *   - Tenant-selection required (throws German error without --tenant-id | --all-tenants)
 *   - Dry-run: lists the candidate with its proposed totalDays, writes NOTHING
 *   - --confirm: creates the missing row with a CREATE AuditLog entry
 *   - Idempotency: a second --confirm run creates zero new rows / zero new audits
 *   - An employee already manually repaired (row pre-exists) is skipped, never touched
 *   - An exited (inactive) employee is never a candidate
 *
 * Uses initials-only for employee names (no PII per memory feedback_no_pii_in_github).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../src/__tests__/setup";
import { main, parseCli } from "../backfill-missing-vacation-entitlements";
import type { FastifyInstance } from "fastify";

describe("backfill-missing-vacation-entitlements (Issue #416)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const currentYear = new Date().getFullYear();

  // An active employee inserted directly via Prisma (bypassing POST /employees, which now
  // auto-seeds an entitlement — Task 3 of this same phase) — the exact legacy shape this
  // script exists to repair: no LeaveEntitlement row at all.
  let noEntitlementEmployeeId: string;
  // An employee whose row was already manually repaired (e.g. an admin PUT ahead of this
  // script running) — must be skipped, never touched.
  let alreadyRepairedEmployeeId: string;
  let alreadyRepairedEntitlementId: string;
  // An exited employee with no row — must never be a candidate.
  let exitedEmployeeId: string;
  // Issue #435 (Task 3, D-06/D-09): an active employee with a per-person base value — the
  // dry-run must propose the PERSON value, never the tenant default.
  let personValueEmployeeId: string;
  // Issue #435 (Task 3, D-09): a minor whose person value (20) sits BELOW the JArbSchG statutory
  // minimum for their age band at a 5-day week (25) — the dry-run must propose the FLOORED value.
  let minorEmployeeId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "bfve");

    const mkEmployee = async (
      label: string,
      overrides: { exitDate?: Date; birthDate?: Date; annualVacationDays?: number } = {},
    ): Promise<string> => {
      const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const user = await app.prisma.user.create({
        data: {
          email: `bfve-${label}-${uid}@test.de`,
          passwordHash: "x",
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const employee = await app.prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: user.id,
          employeeNumber: `BFVE-${label}-${uid}`,
          firstName: "T",
          lastName: "T",
          hireDate: new Date(Date.UTC(currentYear - 1, 0, 1)),
          ...overrides,
        },
      });
      return employee.id;
    };

    noEntitlementEmployeeId = await mkEmployee("noent");
    alreadyRepairedEmployeeId = await mkEmployee("repaired");
    exitedEmployeeId = await mkEmployee("exited", {
      exitDate: new Date(Date.UTC(currentYear - 1, 5, 30)),
    });
    personValueEmployeeId = await mkEmployee("personvalue", { annualVacationDays: 22 });
    minorEmployeeId = await mkEmployee("minor", {
      birthDate: new Date(Date.UTC(currentYear - 15, 5, 15)), // 14 on 1 January of currentYear
      annualVacationDays: 20, // legacy shape, bypassing the API's D-11 floor check
    });

    const alreadyRepaired = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: alreadyRepairedEmployeeId,
        leaveTypeId: data.vacationType.id,
        year: currentYear,
        totalDays: 30,
        isAutoCalculated: true,
      },
    });
    alreadyRepairedEntitlementId = alreadyRepaired.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("throws a German error without --tenant-id or --all-tenants", async () => {
    await expect(main([], app.prisma)).rejects.toThrow(/Tenant-Auswahl erforderlich/);
  });

  it("parses --confirm, --tenant-id and --all-tenants", () => {
    expect(parseCli(["--tenant-id", "abc", "--confirm"])).toEqual({
      tenantId: "abc",
      allTenants: false,
      confirm: true,
      help: false,
    });
    expect(parseCli(["--all-tenants"])).toMatchObject({ allTenants: true, confirm: false });
  });

  it("dry-run lists the candidate with a proposed totalDays and writes NOTHING", async () => {
    const summary = await main(["--tenant-id", data.tenant.id], app.prisma);
    expect(summary.dryRun).toBe(true);

    const candidate = summary.candidates.find((c) => c.employeeId === noEntitlementEmployeeId);
    expect(candidate).toBeDefined();
    expect(candidate?.proposedTotalDays).toBe(30); // full-time, hired prior year -> full 30

    const rows = await app.prisma.leaveEntitlement.findMany({
      where: { employeeId: noEntitlementEmployeeId },
    });
    expect(rows).toHaveLength(0);

    // Issue #435 (D-06): the dry-run proposes the PERSON value, never the tenant default.
    const personValueCandidate = summary.candidates.find(
      (c) => c.employeeId === personValueEmployeeId,
    );
    expect(personValueCandidate?.proposedTotalDays).toBe(22);

    // Issue #435 (D-09): the dry-run proposes the FLOORED value for a minor whose person value
    // (20) sits below the JArbSchG statutory minimum for their age band (25, 5-day week).
    const minorCandidate = summary.candidates.find((c) => c.employeeId === minorEmployeeId);
    expect(minorCandidate?.proposedTotalDays).toBe(25);

    // The exited employee must never be a candidate.
    expect(summary.candidates.find((c) => c.employeeId === exitedEmployeeId)).toBeUndefined();

    // The already-repaired employee must not be a candidate either (its row already exists).
    expect(
      summary.candidates.find((c) => c.employeeId === alreadyRepairedEmployeeId),
    ).toBeUndefined();
  });

  it("--confirm creates the missing row with a CREATE audit entry", async () => {
    const summary = await main(["--tenant-id", data.tenant.id, "--confirm"], app.prisma);
    expect(summary.dryRun).toBe(false);
    expect(summary.created).toBeGreaterThanOrEqual(1);

    const entitlement = await app.prisma.leaveEntitlement.findFirst({
      where: { employeeId: noEntitlementEmployeeId, year: currentYear },
    });
    expect(entitlement).not.toBeNull();
    expect(Number(entitlement?.totalDays)).toBe(30);
    expect(entitlement?.isAutoCalculated).toBe(true);

    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "LeaveEntitlement", entityId: entitlement!.id, action: "CREATE" },
    });
    expect(audit).not.toBeNull();

    // Issue #435 (D-06/D-09): --confirm creates EXACTLY what dry-run proposed — no drift.
    const personValueEntitlement = await app.prisma.leaveEntitlement.findFirst({
      where: { employeeId: personValueEmployeeId, year: currentYear },
    });
    expect(Number(personValueEntitlement?.totalDays)).toBe(22);

    const minorEntitlement = await app.prisma.leaveEntitlement.findFirst({
      where: { employeeId: minorEmployeeId, year: currentYear },
    });
    expect(Number(minorEntitlement?.totalDays)).toBe(25);

    // The already-manually-repaired row must be COMPLETELY untouched (same updatedAt).
    const untouched = await app.prisma.leaveEntitlement.findUnique({
      where: { id: alreadyRepairedEntitlementId },
    });
    expect(Number(untouched?.totalDays)).toBe(30);
    const repairAudits = await app.prisma.auditLog.findMany({
      where: { entity: "LeaveEntitlement", entityId: alreadyRepairedEntitlementId },
    });
    expect(repairAudits).toHaveLength(0); // never audited by this script — never touched
  });

  it("a second --confirm run is a no-op: zero new rows, zero new audits", async () => {
    const before = await app.prisma.leaveEntitlement.findMany({
      where: { employeeId: noEntitlementEmployeeId },
    });
    const beforeAudits = await app.prisma.auditLog.count({
      where: { entity: "LeaveEntitlement", entityId: before[0]!.id },
    });

    const summary = await main(["--tenant-id", data.tenant.id, "--confirm"], app.prisma);
    expect(summary.created).toBe(0);

    const after = await app.prisma.leaveEntitlement.findMany({
      where: { employeeId: noEntitlementEmployeeId },
    });
    expect(after).toHaveLength(1);
    const afterAudits = await app.prisma.auditLog.count({
      where: { entity: "LeaveEntitlement", entityId: before[0]!.id },
    });
    expect(afterAudits).toBe(beforeAudits);
  });
});
