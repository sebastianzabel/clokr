/**
 * Issue #447 (D-07, D-08, D-10) — every endpoint that sets, moves or clears an exit date keeps
 * the exit-year VACATION rows at their § 5 BUrlG value (human values and past years untouched),
 * audited with the acting user; the PATCH warning is the neutral D-08 sentence.
 *
 * Relative years only (current UTC year + 1 / − 1) — no assertion depends on a fixed calendar
 * year expiring. Initials-only fixtures — no PII per CLAUDE.md.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

const CURRENT_YEAR = new Date().getUTCFullYear();
const Y = CURRENT_YEAR + 1;

describe("Employee exit-date writes recompute the exit-year VACATION row (Issue #447, D-07/D-08/D-10)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let adminUserId: string;

  async function mkEmployee(label: string): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `eee-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `EEE-${label}-${uid}`,
        firstName: "T",
        lastName: "T",
        hireDate: new Date(Date.UTC(2024, 0, 1)),
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

  async function machineOwnedRow(employeeId: string, year: number, totalDays: number) {
    return app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year,
        totalDays,
        isAutoCalculated: true,
      },
    });
  }

  async function patchEmployee(employeeId: string, body: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${employeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: body,
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "eee");
    adminUserId = data.adminUser.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("PATCH exitDate recomputes the exit-year row to § 5 BUrlG value, audited with the admin's user id", async () => {
    const empId = await mkEmployee("patch-set");
    const row = await machineOwnedRow(empId, Y, 30);

    const res = await patchEmployee(empId, {
      exitDate: new Date(Date.UTC(Y, 2, 31)).toISOString(),
    });
    expect(res.statusCode).toBe(200);

    const updated = await app.prisma.leaveEntitlement.findUniqueOrThrow({ where: { id: row.id } });
    expect(Number(updated.totalDays)).toBe(8);
    expect(updated.isAutoCalculated).toBe(true);

    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "LeaveEntitlement", entityId: row.id, action: "UPDATE" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.userId).toBe(adminUserId);
    const newValue = audit!.newValue as Record<string, unknown>;
    expect(newValue.reason).toBe("Austritt — anteiliger Anspruch (§ 5 BUrlG)");
    expect(newValue.isAutoCalculated).toBe(true);
    const oldValue = audit!.oldValue as Record<string, unknown>;
    expect(oldValue.totalDays).toBe(30);
  });

  it("PATCH exitDate leaves a human-written row untouched, no exit audit", async () => {
    const empId = await mkEmployee("patch-human");
    const putRes = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/vacation/${empId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { year: Y, totalDays: 25 },
    });
    expect(putRes.statusCode).toBe(200);
    const row = await app.prisma.leaveEntitlement.findFirstOrThrow({
      where: { employeeId: empId, leaveTypeId: data.vacationType.id, year: Y },
    });

    const res = await patchEmployee(empId, {
      exitDate: new Date(Date.UTC(Y, 2, 31)).toISOString(),
    });
    expect(res.statusCode).toBe(200);

    const unchanged = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(Number(unchanged.totalDays)).toBe(25);
    const exitAudit = await app.prisma.auditLog.findFirst({
      where: {
        entity: "LeaveEntitlement",
        entityId: row.id,
        action: "UPDATE",
        newValue: { path: ["reason"], equals: "Austritt — anteiliger Anspruch (§ 5 BUrlG)" },
      },
    });
    expect(exitAudit).toBeNull();
  });

  it("PATCH exitDate pointing at a past year leaves that year's row unchanged", async () => {
    const empId = await mkEmployee("patch-past");
    const pastYear = CURRENT_YEAR - 1;
    const row = await machineOwnedRow(empId, pastYear, 30);

    const res = await patchEmployee(empId, {
      exitDate: new Date(Date.UTC(pastYear, 2, 31)).toISOString(),
    });
    expect(res.statusCode).toBe(200);

    const unchanged = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(Number(unchanged.totalDays)).toBe(30);
  });

  it("PATCH clears exitDate -> row back to full value, audited; moving the exit year syncs both years", async () => {
    const empId = await mkEmployee("patch-clear-move");
    const rowY = await machineOwnedRow(empId, Y, 30);

    await patchEmployee(empId, { exitDate: new Date(Date.UTC(Y, 2, 31)).toISOString() });
    const afterSet = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: { id: rowY.id },
    });
    expect(Number(afterSet.totalDays)).toBe(8);

    await patchEmployee(empId, { exitDate: null });
    const afterClear = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: { id: rowY.id },
    });
    expect(Number(afterClear.totalDays)).toBe(30);

    const rowYPlus1 = await machineOwnedRow(empId, Y + 1, 30);
    await patchEmployee(empId, { exitDate: null }); // no-op, re-establish a clean baseline
    await patchEmployee(empId, { exitDate: new Date(Date.UTC(Y, 2, 31)).toISOString() });
    await patchEmployee(empId, { exitDate: new Date(Date.UTC(Y + 1, 2, 31)).toISOString() });

    const finalY = await app.prisma.leaveEntitlement.findUniqueOrThrow({ where: { id: rowY.id } });
    const finalYPlus1 = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: { id: rowYPlus1.id },
    });
    expect(Number(finalY.totalDays)).toBe(30);
    expect(Number(finalYPlus1.totalDays)).toBe(8);
  });

  it("deactivate recomputes the exit-year row to Teilurlaub; reactivate recomputes it back to the full value", async () => {
    const empId = await mkEmployee("deact-react");
    const row = await machineOwnedRow(empId, Y, 30);

    const deactivateRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${empId}/deactivate`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { exitDate: new Date(Date.UTC(Y, 2, 31)).toISOString() },
    });
    expect(deactivateRes.statusCode).toBe(200);
    const afterDeactivate = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(Number(afterDeactivate.totalDays)).toBe(8);

    const reactivateRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${empId}/reactivate`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(reactivateRes.statusCode).toBe(200);
    const afterReactivate = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(Number(afterReactivate.totalDays)).toBe(30);
  });

  it("D-08: PATCH exitDate reports proRataWarning (neutral, no reclaim suggestion) when usedDays exceed the new entitlement", async () => {
    const empId = await mkEmployee("warning");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: empId,
        leaveTypeId: data.vacationType.id,
        year: Y,
        totalDays: 30,
        usedDays: 10,
        isAutoCalculated: true,
      },
    });

    const res = await patchEmployee(empId, {
      exitDate: new Date(Date.UTC(Y, 2, 31)).toISOString(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.proRataWarning).toBeDefined();
    expect(body.proRataWarning.used).toBe(10);
    expect(body.proRataWarning.entitlement).toBe(8);
    expect(body.proRataWarning.message).toContain("T T");
    expect(body.proRataWarning.message).toContain("§ 5 Abs. 3 BUrlG");
    expect(body.proRataWarning.message).not.toMatch(/Rückforderung/);
  });

  it("PATCH with an unchanged exitDate (re-sent identical value) does not re-audit the already-synced row", async () => {
    const empId = await mkEmployee("unchanged");
    const row = await machineOwnedRow(empId, Y, 30);
    const exitIso = new Date(Date.UTC(Y, 2, 31)).toISOString();

    const first = await patchEmployee(empId, { exitDate: exitIso });
    expect(first.statusCode).toBe(200);
    const afterFirst = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(Number(afterFirst.totalDays)).toBe(8);
    const auditCountAfterFirst = await app.prisma.auditLog.count({
      where: { entity: "LeaveEntitlement", entityId: row.id },
    });

    const second = await patchEmployee(empId, { exitDate: exitIso });
    expect(second.statusCode).toBe(200);
    const auditCountAfterSecond = await app.prisma.auditLog.count({
      where: { entity: "LeaveEntitlement", entityId: row.id },
    });
    expect(auditCountAfterSecond).toBe(auditCountAfterFirst);
  });
});
