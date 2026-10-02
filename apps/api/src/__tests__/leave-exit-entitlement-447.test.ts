/**
 * Issue #447 (D-06, D-08, D-09) — the booking check trusts the synced exit-year row (carry-over
 * never pro-rated), GET syncs and reports the over-use warning, and the approval warning is built
 * by the same helper, with no first-half-year guard any more.
 *
 * Relative years only (current UTC year + 1) — no assertion depends on a fixed calendar year
 * expiring. Initials-only fixtures — no PII per CLAUDE.md.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

const Y = new Date().getUTCFullYear() + 1;

/** The first `n` Mo–Fr dates on/after `from`, as a {start,end,nextFrom} ISO-date range plus the
 * day right after the range ends (so a caller can chain a second, disjoint range). February has
 * no statutory holiday in any Bundesland, so a plain weekday count matches the booking check. */
function firstNWeekdaysFrom(from: Date, n: number): { start: string; end: string; nextFrom: Date } {
  let count = 0;
  let cursor = new Date(from);
  let last = cursor;
  while (count < n) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      count++;
      last = new Date(cursor);
    }
    if (count < n) cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return {
    start: from.toISOString().slice(0, 10),
    end: last.toISOString().slice(0, 10),
    nextFrom: new Date(last.getTime() + 24 * 60 * 60 * 1000),
  };
}

function firstNWeekdaysOfFebruary(year: number, n: number): { start: string; end: string } {
  return firstNWeekdaysFrom(new Date(Date.UTC(year, 1, 1)), n);
}

describe("Exit-year VACATION booking/GET/approval (Issue #447, D-06/D-08/D-09)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  async function mkEmployee(
    label: string,
    overrides: { hireDate?: Date; annualVacationDays?: number } = {},
  ): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `lee-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `LEE-${label}-${uid}`,
        firstName: "T",
        lastName: "T",
        hireDate: overrides.hireDate ?? new Date(Date.UTC(2024, 0, 1)),
        annualVacationDays: overrides.annualVacationDays ?? null,
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
        validFrom: overrides.hireDate ?? new Date(Date.UTC(2024, 0, 1)),
      },
    });
    return employee.id;
  }

  async function postVacation(employeeId: string, start: string, end: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { type: "VACATION", startDate: start, endDate: end, employeeId },
    });
  }

  async function approve(requestId: string) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${requestId}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED" },
    });
  }

  async function getEntitlements(employeeId: string, year: number) {
    return app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${employeeId}?year=${year}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "lee");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("accepts a request for exactly Teilurlaub + carry-over (18), rejects 19 — carry-over never pro-rated", async () => {
    const empA = await mkEmployee("a");
    const rowA = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: empA,
        leaveTypeId: data.vacationType.id,
        year: Y,
        totalDays: 30,
        carriedOverDays: 10,
        carryOverDeadline: new Date(Date.UTC(Y, 2, 31)),
        isAutoCalculated: true,
      },
    });
    await app.prisma.employee.update({
      where: { id: empA },
      data: { exitDate: new Date(Date.UTC(Y, 2, 31)) },
    });

    const range18 = firstNWeekdaysOfFebruary(Y, 18);
    const res18 = await postVacation(empA, range18.start, range18.end);
    expect(res18.statusCode).toBe(201);
    const synced = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: { id: rowA.id },
    });
    expect(Number(synced.totalDays)).toBe(8);

    const empB = await mkEmployee("b");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: empB,
        leaveTypeId: data.vacationType.id,
        year: Y,
        totalDays: 30,
        carriedOverDays: 10,
        carryOverDeadline: new Date(Date.UTC(Y, 2, 31)),
        isAutoCalculated: true,
      },
    });
    await app.prisma.employee.update({
      where: { id: empB },
      data: { exitDate: new Date(Date.UTC(Y, 2, 31)) },
    });
    const range19 = firstNWeekdaysOfFebruary(Y, 19);
    const res19 = await postVacation(empB, range19.start, range19.end);
    expect(res19.statusCode).toBe(400);
    const body19 = JSON.parse(res19.body);
    expect(body19.error).toBe(`Nicht genug Urlaubstage in ${Y}`);
    expect(body19.available).toBe(18);
  });

  it("GET syncs the exit-year row and reports exitOverUseWarning; a human-written row keeps its value and no exit audit", async () => {
    const empC = await mkEmployee("c");
    await app.prisma.leaveEntitlement.create({
      data: { employeeId: empC, leaveTypeId: data.vacationType.id, year: Y, totalDays: 30 },
    });
    await app.prisma.employee.update({
      where: { id: empC },
      data: { exitDate: new Date(Date.UTC(Y, 2, 31)) },
    });

    const getRes = await getEntitlements(empC, Y);
    expect(getRes.statusCode).toBe(200);
    const rows = JSON.parse(getRes.body) as Array<{
      typeCode: string;
      totalDays: unknown;
      effectiveEntitlementDays: number;
    }>;
    const vacRow = rows.find((r) => r.typeCode === "VACATION")!;
    expect(Number(vacRow.totalDays)).toBe(8);
    expect(vacRow.effectiveEntitlementDays).toBe(8);

    const exitAudit = await app.prisma.auditLog.findFirst({
      where: {
        entity: "LeaveEntitlement",
        action: "UPDATE",
        newValue: { path: ["reason"], equals: "Austritt — anteiliger Anspruch (§ 5 BUrlG)" },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(exitAudit).not.toBeNull();

    const empD = await mkEmployee("d");
    const putRes = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/vacation/${empD}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { year: Y, totalDays: 25 },
    });
    expect(putRes.statusCode).toBe(200);
    await app.prisma.employee.update({
      where: { id: empD },
      data: { exitDate: new Date(Date.UTC(Y, 2, 31)) },
    });
    const getResD = await getEntitlements(empD, Y);
    const rowsD = JSON.parse(getResD.body) as Array<{ typeCode: string; totalDays: unknown }>;
    const vacRowD = rowsD.find((r) => r.typeCode === "VACATION")!;
    expect(Number(vacRowD.totalDays)).toBe(25);
    const exitAuditD = await app.prisma.auditLog.findFirst({
      where: {
        entity: "LeaveEntitlement",
        action: "UPDATE",
        entityId: (
          await app.prisma.leaveEntitlement.findFirstOrThrow({
            where: { employeeId: empD, leaveTypeId: data.vacationType.id, year: Y },
          })
        ).id,
        newValue: { path: ["reason"], equals: "Austritt — anteiliger Anspruch (§ 5 BUrlG)" },
      },
    });
    expect(exitAuditD).toBeNull();
  });

  it("approval warning: first half-year exit — no warning at the entitled amount, warning once exceeded", async () => {
    const empE = await mkEmployee("e");
    const feb1 = firstNWeekdaysFrom(new Date(Date.UTC(Y, 1, 1)), 5);
    const r1 = await postVacation(empE, feb1.start, feb1.end);
    expect(r1.statusCode).toBe(201);
    const id1 = JSON.parse(r1.body).id;

    const feb2 = firstNWeekdaysFrom(feb1.nextFrom, 5);
    const r2 = await postVacation(empE, feb2.start, feb2.end);
    expect(r2.statusCode).toBe(201);
    const id2 = JSON.parse(r2.body).id;

    await app.prisma.employee.update({
      where: { id: empE },
      data: { exitDate: new Date(Date.UTC(Y, 2, 31)) },
    });
    const getRes = await getEntitlements(empE, Y);
    const rows = JSON.parse(getRes.body) as Array<{ typeCode: string; totalDays: unknown }>;
    expect(Number(rows.find((r) => r.typeCode === "VACATION")!.totalDays)).toBe(8);

    const approve1 = await approve(id1);
    expect(approve1.statusCode).toBe(200);
    expect(JSON.parse(approve1.body).proRataWarning).toBeUndefined();

    const approve2 = await approve(id2);
    expect(approve2.statusCode).toBe(200);
    const warning2 = JSON.parse(approve2.body).proRataWarning;
    expect(warning2).toBeDefined();
    expect(warning2.used).toBe(10);
    expect(warning2.entitlement).toBe(8);
    expect(warning2.message).toContain("§ 5 Abs. 3 BUrlG");
    expect(warning2.message).not.toMatch(/Rückforderung/);

    const getAfter = await getEntitlements(empE, Y);
    const rowsAfter = JSON.parse(getAfter.body) as Array<{
      typeCode: string;
      exitOverUseWarning: { message: string } | null;
    }>;
    const vacAfter = rowsAfter.find((r) => r.typeCode === "VACATION")!;
    expect(vacAfter.exitOverUseWarning?.message).toBe(warning2.message);
  });

  it("approval warning: second half-year exit before the Wartezeit also warns (no first-half-year guard any more)", async () => {
    const empF = await mkEmployee("f", {
      hireDate: new Date(Date.UTC(Y, 6, 1)),
      annualVacationDays: 23,
    });
    const aug1 = firstNWeekdaysFrom(new Date(Date.UTC(Y, 7, 1)), 6);
    const r1 = await postVacation(empF, aug1.start, aug1.end);
    expect(r1.statusCode).toBe(201);
    const id1 = JSON.parse(r1.body).id;

    const aug2 = firstNWeekdaysFrom(aug1.nextFrom, 6);
    const r2 = await postVacation(empF, aug2.start, aug2.end);
    expect(r2.statusCode).toBe(201);
    const id2 = JSON.parse(r2.body).id;

    await app.prisma.employee.update({
      where: { id: empF },
      data: { exitDate: new Date(Date.UTC(Y, 10, 30)) },
    });
    const getRes = await getEntitlements(empF, Y);
    const rows = JSON.parse(getRes.body) as Array<{ typeCode: string; totalDays: unknown }>;
    expect(Number(rows.find((r) => r.typeCode === "VACATION")!.totalDays)).toBe(10);

    await approve(id1);
    const approve2 = await approve(id2);
    expect(approve2.statusCode).toBe(200);
    const warning2 = JSON.parse(approve2.body).proRataWarning;
    expect(warning2).toBeDefined();
    expect(warning2.entitlement).toBe(10);
  });
});
