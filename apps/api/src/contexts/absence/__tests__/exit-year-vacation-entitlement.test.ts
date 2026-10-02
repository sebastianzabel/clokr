/**
 * Issue #447 (D-06, D-07, D-08, D-14) — the exit-year VACATION row becomes the § 5 BUrlG value
 * whenever no human ever wrote it, on demand via `syncExitYearVacationEntitlement`, and the
 * exit-year over-use warning is built in one neutral, non-reclaiming helper.
 *
 * Relative years only (current UTC year + 1 / − 1) — no assertion depends on a fixed calendar
 * year expiring. Initials-only fixtures (firstName "T", lastName "T") — no PII per CLAUDE.md.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import {
  hasHumanVacationWrite,
  syncExitYearVacationEntitlement,
  exitVacationOverUseWarning,
  REGULAR_ENTITLEMENT_REASON_EXIT,
  ensureRegularVacationEntitlement,
  REGULAR_ENTITLEMENT_REASON_LEAVE_REQUEST,
} from "../leave-days";
import type { FastifyInstance } from "fastify";

const CURRENT_YEAR = new Date().getUTCFullYear();
const Y = CURRENT_YEAR + 1;

describe("exit-year VACATION entitlement sync (Issue #447, D-06/D-07/D-08/D-14)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  async function mkEmployee(
    label: string,
    overrides: { exitDate?: Date | null } = {},
  ): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `eyv-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `EYV-${label}-${uid}`,
        firstName: "T",
        lastName: "T",
        hireDate: new Date(Date.UTC(2024, 0, 1)),
        exitDate: overrides.exitDate ?? null,
      },
    });
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
    return employee.id;
  }

  async function countAudits(entitlementId: string): Promise<number> {
    return app.prisma.auditLog.count({
      where: { entity: "LeaveEntitlement", entityId: entitlementId },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "eyv");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("recomputes a machine-owned row to the exit-year Teilurlaub value, audited once; a second call writes nothing", async () => {
    const employeeId = await mkEmployee("machine");
    const { entitlement: created } = await ensureRegularVacationEntitlement(
      app.prisma,
      employeeId,
      data.tenant.id,
      Y,
      data.vacationType.id,
      REGULAR_ENTITLEMENT_REASON_LEAVE_REQUEST,
    );
    expect(Number(created.totalDays)).toBe(30);
    expect(created.isAutoCalculated).toBe(true);

    await app.prisma.employee.update({
      where: { id: employeeId },
      data: { exitDate: new Date(Date.UTC(Y, 2, 31)) },
    });

    const first = await syncExitYearVacationEntitlement(app.prisma, employeeId, data.tenant.id, Y);
    expect(first.changed).toBe(true);
    expect(Number(first.entitlement!.totalDays)).toBe(8);
    expect(first.entitlement!.isAutoCalculated).toBe(true);

    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "LeaveEntitlement", entityId: created.id, action: "UPDATE" },
      orderBy: { createdAt: "desc" },
    });
    expect(audits.length).toBe(1);
    const newValue = audits[0]!.newValue as Record<string, unknown>;
    expect(newValue.totalDays).toBe(8);
    expect(newValue.isAutoCalculated).toBe(true);
    expect(newValue.reason).toBe(REGULAR_ENTITLEMENT_REASON_EXIT);
    const oldValue = audits[0]!.oldValue as Record<string, unknown>;
    expect(oldValue.totalDays).toBe(30);

    const auditCountBefore = await countAudits(created.id);
    const second = await syncExitYearVacationEntitlement(app.prisma, employeeId, data.tenant.id, Y);
    expect(second.changed).toBe(false);
    expect(await countAudits(created.id)).toBe(auditCountBefore);
  });

  it("heals a legacy row (isAutoCalculated false, no audit) to the exit value, written with isAutoCalculated true", async () => {
    const employeeId = await mkEmployee("legacy", { exitDate: new Date(Date.UTC(Y, 2, 31)) });
    const row = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: Y,
        totalDays: 30,
        isAutoCalculated: false,
      },
    });

    const result = await syncExitYearVacationEntitlement(app.prisma, employeeId, data.tenant.id, Y);
    expect(result.changed).toBe(true);
    expect(Number(result.entitlement!.totalDays)).toBe(8);
    expect(result.entitlement!.isAutoCalculated).toBe(true);

    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "LeaveEntitlement", entityId: row.id, action: "UPDATE" },
    });
    expect(audits.length).toBe(1);
  });

  it("leaves a human-written row untouched and writes no audit (Pitfall 2)", async () => {
    const employeeId = await mkEmployee("human");
    const { entitlement: created } = await ensureRegularVacationEntitlement(
      app.prisma,
      employeeId,
      data.tenant.id,
      Y,
      data.vacationType.id,
      REGULAR_ENTITLEMENT_REASON_LEAVE_REQUEST,
    );
    // Simulate the PUT /settings/vacation shape: an UPDATE audit sets totalDays without
    // isAutoCalculated, and the row is written to 25 while isAutoCalculated stays true (Pitfall
    // 2 — the column itself never reflects the human write).
    await app.prisma.auditLog.create({
      data: {
        userId: null,
        action: "UPDATE",
        entity: "LeaveEntitlement",
        entityId: created.id,
        newValue: { totalDays: 25, carriedOverDays: 0 },
      },
    });
    await app.prisma.leaveEntitlement.update({
      where: { id: created.id },
      data: { totalDays: 25 },
    });
    await app.prisma.employee.update({
      where: { id: employeeId },
      data: { exitDate: new Date(Date.UTC(Y, 2, 31)) },
    });

    expect(await hasHumanVacationWrite(app.prisma, created.id)).toBe(true);

    const auditCountBefore = await countAudits(created.id);
    const result = await syncExitYearVacationEntitlement(app.prisma, employeeId, data.tenant.id, Y);
    expect(result.changed).toBe(false);
    expect(Number(result.entitlement!.totalDays)).toBe(25);
    expect(await countAudits(created.id)).toBe(auditCountBefore);
  });

  it("never changes a row for a year before the current calendar year", async () => {
    const pastYear = CURRENT_YEAR - 1;
    const employeeId = await mkEmployee("past", {
      exitDate: new Date(Date.UTC(pastYear, 2, 31)),
    });
    const row = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: pastYear,
        totalDays: 30,
        isAutoCalculated: true,
      },
    });

    const result = await syncExitYearVacationEntitlement(
      app.prisma,
      employeeId,
      data.tenant.id,
      pastYear,
    );
    expect(result.changed).toBe(false);
    const unchanged = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(Number(unchanged.totalDays)).toBe(30);
    expect(await countAudits(row.id)).toBe(0);
  });

  it("reverts to the full value when exitDate is cleared, audited", async () => {
    const employeeId = await mkEmployee("cleared", { exitDate: new Date(Date.UTC(Y, 2, 31)) });
    const row = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year: Y,
        totalDays: 30,
        isAutoCalculated: true,
      },
    });
    const synced = await syncExitYearVacationEntitlement(app.prisma, employeeId, data.tenant.id, Y);
    expect(Number(synced.entitlement!.totalDays)).toBe(8);

    await app.prisma.employee.update({ where: { id: employeeId }, data: { exitDate: null } });
    const reverted = await syncExitYearVacationEntitlement(
      app.prisma,
      employeeId,
      data.tenant.id,
      Y,
    );
    expect(reverted.changed).toBe(true);
    expect(Number(reverted.entitlement!.totalDays)).toBe(30);
    expect(await countAudits(row.id)).toBe(2);
  });

  it("ensureRegularVacationEntitlement returns the synced value for an existing exit-year row; writes nothing for an employee without exit", async () => {
    const employeeId = await mkEmployee("ensure-exit", { exitDate: new Date(Date.UTC(Y, 2, 31)) });
    const { entitlement: created } = await ensureRegularVacationEntitlement(
      app.prisma,
      employeeId,
      data.tenant.id,
      Y,
      data.vacationType.id,
      REGULAR_ENTITLEMENT_REASON_LEAVE_REQUEST,
    );
    // The create path already threads exitDate through (plan 03) — assert the booking
    // precondition the ensure call must satisfy regardless.
    const synced = await ensureRegularVacationEntitlement(
      app.prisma,
      employeeId,
      data.tenant.id,
      Y,
      data.vacationType.id,
      REGULAR_ENTITLEMENT_REASON_LEAVE_REQUEST,
    );
    expect(Number(synced.entitlement.totalDays)).toBe(8);
    expect(created.id).toBe(synced.entitlement.id);

    const noExitEmployeeId = await mkEmployee("ensure-no-exit");
    const first = await ensureRegularVacationEntitlement(
      app.prisma,
      noExitEmployeeId,
      data.tenant.id,
      Y,
      data.vacationType.id,
      REGULAR_ENTITLEMENT_REASON_LEAVE_REQUEST,
    );
    const auditCountBefore = await countAudits(first.entitlement.id);
    const second = await ensureRegularVacationEntitlement(
      app.prisma,
      noExitEmployeeId,
      data.tenant.id,
      Y,
      data.vacationType.id,
      REGULAR_ENTITLEMENT_REASON_LEAVE_REQUEST,
    );
    expect(second.healed).toBe(false);
    expect(await countAudits(first.entitlement.id)).toBe(auditCountBefore);
  });

  it("exitVacationOverUseWarning: null without exit / wrong year / used within entitlement", () => {
    const row = { year: Y, totalDays: 8, carriedOverDays: 0, usedDays: 8 };
    expect(exitVacationOverUseWarning({ employeeName: "T T", exitDate: null, row })).toBeNull();
    expect(
      exitVacationOverUseWarning({
        employeeName: "T T",
        exitDate: new Date(Date.UTC(Y + 1, 2, 31)),
        row,
      }),
    ).toBeNull();
    expect(
      exitVacationOverUseWarning({
        employeeName: "T T",
        exitDate: new Date(Date.UTC(Y, 2, 31)),
        row: { ...row, usedDays: 8 },
      }),
    ).toBeNull();
  });

  it("exitVacationOverUseWarning: returns used/entitlement/message when used exceeds entitlement, German decimal formatting", () => {
    const result = exitVacationOverUseWarning({
      employeeName: "T T",
      exitDate: new Date(Date.UTC(Y, 2, 31)),
      row: { year: Y, totalDays: 8, carriedOverDays: 0, usedDays: 10 },
    });
    expect(result).not.toBeNull();
    expect(result!.used).toBe(10);
    expect(result!.entitlement).toBe(8);
    expect(result!.message).toContain("T T");
    expect(result!.message).toContain("(10 Tage)");
    expect(result!.message).toContain("(8 Tage)");
    expect(result!.message).toContain("§ 5 Abs. 3 BUrlG");
    expect(result!.message).not.toMatch(/Rückforderung/);

    const decimals = exitVacationOverUseWarning({
      employeeName: "T T",
      exitDate: new Date(Date.UTC(Y, 2, 31)),
      row: { year: Y, totalDays: 8.33, carriedOverDays: 0, usedDays: 10 },
    });
    expect(decimals!.message).toContain("8,33 Tage");
  });
});
