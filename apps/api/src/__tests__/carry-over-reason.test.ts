/**
 * Issue #445 finding 5 — protected carry-over deadline with a documented reason (D-16..D-18).
 *
 * Fixed dates only (2026/2027/2028) — no assertion depends on `new Date()`. Every scenario uses
 * its own fresh employee (hire 2024-01-01, FIXED Mo-Fr, initials-only), with a 2026 row
 * (totalDays 30) and a 2027 row (totalDays 30, carriedOverDays 3).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { recalculateCarryOver } from "../contexts/absence/leave-days";
import type { FastifyInstance } from "fastify";

describe("Issue #445 finding 5 — protected carry-over deadline with a documented reason (D-16..D-18)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  async function mkEmployee(
    label: string,
    carryOverReason: string | null = null,
    carryOverDeadline: Date | null = null,
  ): Promise<{ employeeId: string; entitlementId: string }> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `cors-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `CORS-${label}-${uid}`,
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
    await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: employee.id,
        leaveTypeId: data.vacationType.id,
        year: 2026,
        totalDays: 30,
        usedDays: 0,
      },
    });
    const ent2027 = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: employee.id,
        leaveTypeId: data.vacationType.id,
        year: 2027,
        totalDays: 30,
        usedDays: 0,
        carriedOverDays: 3,
        carryOverReason,
        carryOverDeadline,
      },
    });
    return { employeeId: employee.id, entitlementId: ent2027.id };
  }

  const putVacation = (employeeId: string, body: Record<string, unknown>) =>
    app.inject({
      method: "PUT",
      url: `/api/v1/settings/vacation/${employeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: body,
    });

  const get2027 = (employeeId: string) =>
    app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: { employeeId, leaveTypeId: data.vacationType.id, year: 2027 },
      },
    });

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "cors");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("case 1: MATERNITY with an explicit deadline survives a recompute", async () => {
    const { employeeId } = await mkEmployee("c1");

    const res = await putVacation(employeeId, {
      year: 2027,
      totalDays: 30,
      carriedOverDays: 3,
      carryOverReason: "MATERNITY",
      carryOverDeadline: "2028-06-30",
    });
    expect(res.statusCode, `PUT must succeed: ${res.body}`).toBe(200);

    const afterPut = await get2027(employeeId);
    expect(afterPut!.carryOverReason).toBe("MATERNITY");
    expect(afterPut!.carryOverDeadline?.toISOString().slice(0, 10)).toBe("2028-06-30");

    await recalculateCarryOver(app.prisma, data.tenant.id, employeeId, data.vacationType.id, 2027);

    const afterRecalc = await get2027(employeeId);
    expect(afterRecalc!.carryOverDeadline?.toISOString().slice(0, 10)).toBe("2028-06-30");
  });

  it("case 2: PARENTAL_LEAVE with an explicit deadline survives a recompute", async () => {
    const { employeeId } = await mkEmployee("c2");

    const res = await putVacation(employeeId, {
      year: 2027,
      totalDays: 30,
      carriedOverDays: 3,
      carryOverReason: "PARENTAL_LEAVE",
      carryOverDeadline: "2028-09-30",
    });
    expect(res.statusCode, `PUT must succeed: ${res.body}`).toBe(200);

    await recalculateCarryOver(app.prisma, data.tenant.id, employeeId, data.vacationType.id, 2027);

    const afterRecalc = await get2027(employeeId);
    expect(afterRecalc!.carryOverDeadline?.toISOString().slice(0, 10)).toBe("2028-09-30");
    expect(afterRecalc!.carryOverReason).toBe("PARENTAL_LEAVE");
  });

  it("case 3: OTHER requires a note; with a note it is stored and protects the deadline", async () => {
    const { employeeId } = await mkEmployee("c3");

    const resNoNote = await putVacation(employeeId, {
      year: 2027,
      totalDays: 30,
      carriedOverDays: 3,
      carryOverReason: "OTHER",
      carryOverDeadline: "2028-03-31",
    });
    expect(resNoNote.statusCode).toBe(400);
    expect((resNoNote.json() as { error: string }).error).toContain("Notiz");
    const unchanged = await get2027(employeeId);
    expect(unchanged!.carryOverReason).toBeNull();

    const res = await putVacation(employeeId, {
      year: 2027,
      totalDays: 30,
      carriedOverDays: 3,
      carryOverReason: "OTHER",
      carryOverNote: "Vereinbarung vom 15.03.",
      carryOverDeadline: "2028-03-31",
    });
    expect(res.statusCode, `PUT must succeed: ${res.body}`).toBe(200);
    const afterPut = await get2027(employeeId);
    expect(afterPut!.carryOverNote).toBe("Vereinbarung vom 15.03.");

    // case 10: the UPDATE audit of this successful PUT carries both fields. Checked BEFORE the
    // recompute below, which would itself write a later UPDATE audit (carriedOverDays only).
    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "UPDATE", entity: "LeaveEntitlement", entityId: afterPut!.id },
      orderBy: { createdAt: "desc" },
    });
    expect(audit, "an UPDATE audit row must exist").toBeDefined();
    expect((audit!.newValue as Record<string, unknown>).carryOverReason).toBe("OTHER");
    expect((audit!.newValue as Record<string, unknown>).carryOverNote).toBe(
      "Vereinbarung vom 15.03.",
    );
    expect(audit!.oldValue).toHaveProperty("carryOverReason");
    expect(audit!.oldValue).toHaveProperty("carryOverNote");

    await recalculateCarryOver(app.prisma, data.tenant.id, employeeId, data.vacationType.id, 2027);
    const afterRecalc = await get2027(employeeId);
    expect(afterRecalc!.carryOverDeadline?.toISOString().slice(0, 10)).toBe("2028-03-31");
  });

  it("case 4: MATERNITY without a deadline is rejected", async () => {
    const { employeeId } = await mkEmployee("c4");

    const res = await putVacation(employeeId, {
      year: 2027,
      totalDays: 30,
      carriedOverDays: 3,
      carryOverReason: "MATERNITY",
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("Übertragsfrist");
  });

  it("case 5: ILLNESS without a deadline defaults to 31 March of year + 1", async () => {
    const { employeeId } = await mkEmployee("c5");

    const res = await putVacation(employeeId, {
      year: 2027,
      totalDays: 30,
      carriedOverDays: 3,
      carryOverReason: "ILLNESS",
    });
    expect(res.statusCode, `PUT must succeed: ${res.body}`).toBe(200);
    const body = res.json() as { carryOverDeadline: string };
    expect(new Date(body.carryOverDeadline).toISOString()).toBe(
      new Date(Date.UTC(2028, 2, 31, 23, 59, 59)).toISOString(),
    );
  });

  it("case 6: an explicit null reason removes protection, is audited, and the next recompute resets the deadline to the tenant default", async () => {
    const { employeeId, entitlementId } = await mkEmployee(
      "c6",
      "MATERNITY",
      new Date(Date.UTC(2028, 5, 30, 23, 59, 59)),
    );

    const res = await putVacation(employeeId, {
      year: 2027,
      totalDays: 30,
      carriedOverDays: 3,
      carryOverReason: null,
    });
    expect(res.statusCode, `PUT must succeed: ${res.body}`).toBe(200);
    const afterPut = await get2027(employeeId);
    expect(afterPut!.carryOverReason).toBeNull();

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "UPDATE", entity: "LeaveEntitlement", entityId: entitlementId },
      orderBy: { createdAt: "desc" },
    });
    expect((audit!.oldValue as Record<string, unknown>).carryOverReason).toBe("MATERNITY");
    expect((audit!.newValue as Record<string, unknown>).carryOverReason).toBeNull();

    await recalculateCarryOver(app.prisma, data.tenant.id, employeeId, data.vacationType.id, 2027);
    const afterRecalc = await get2027(employeeId);
    expect(afterRecalc!.carryOverDeadline?.getTime()).toBe(
      new Date(2027, 2, 31, 23, 59, 59).getTime(),
    );
  });

  it("case 7: the reason omitted on a protected row keeps the reason and the deadline", async () => {
    const { employeeId } = await mkEmployee(
      "c7",
      "MATERNITY",
      new Date(Date.UTC(2028, 5, 30, 23, 59, 59)),
    );

    const res = await putVacation(employeeId, { year: 2027, totalDays: 28 });
    expect(res.statusCode, `PUT must succeed: ${res.body}`).toBe(200);
    const afterPut = await get2027(employeeId);
    expect(afterPut!.carryOverReason).toBe("MATERNITY");
    expect(afterPut!.carryOverDeadline?.toISOString()).toBe(
      new Date(Date.UTC(2028, 5, 30, 23, 59, 59)).toISOString(),
    );
  });

  it("case 8: a legacy OPERATIONAL row keeps its deadline through a recompute", async () => {
    const { employeeId } = await mkEmployee(
      "c8",
      "OPERATIONAL",
      new Date(Date.UTC(2028, 7, 31, 23, 59, 59)),
    );

    await recalculateCarryOver(app.prisma, data.tenant.id, employeeId, data.vacationType.id, 2027);
    const afterRecalc = await get2027(employeeId);
    expect(afterRecalc!.carryOverDeadline?.toISOString()).toBe(
      new Date(Date.UTC(2028, 7, 31, 23, 59, 59)).toISOString(),
    );
    expect(afterRecalc!.carryOverReason).toBe("OPERATIONAL");
  });

  it("case 9: a carryOverNote over 500 characters is rejected", async () => {
    const { employeeId } = await mkEmployee("c9");

    const res = await putVacation(employeeId, {
      year: 2027,
      totalDays: 30,
      carriedOverDays: 3,
      carryOverReason: "OTHER",
      carryOverNote: "x".repeat(501),
      carryOverDeadline: "2028-03-31",
    });
    expect(res.statusCode).toBe(400);
  });
});

// Issue #451 / #445 addendum (D-09) — the GET side of the round trip. The PUT tests above
// already prove the row is written correctly; these prove the admin UI's load path (the
// Urlaub tab reads via GET /settings/vacation/:employeeId) actually sees it.
describe("GET /settings/vacation returns carryOverReason/carryOverNote (Issue #451 D-09)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  async function mkEmployeeD09(label: string): Promise<{ employeeId: string }> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `cors-d09-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `CORS-D09-${label}-${uid}`,
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
    await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: employee.id,
        leaveTypeId: data.vacationType.id,
        year: 2027,
        totalDays: 30,
        usedDays: 0,
        carriedOverDays: 3,
      },
    });
    return { employeeId: employee.id };
  }

  const putVacationD09 = (employeeId: string, body: Record<string, unknown>) =>
    app.inject({
      method: "PUT",
      url: `/api/v1/settings/vacation/${employeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: body,
    });

  const getVacationD09 = (employeeId: string, year = 2027) =>
    app.inject({
      method: "GET",
      url: `/api/v1/settings/vacation/${employeeId}?year=${year}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "cors-d09");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("returns the stored reason and note after a PUT sets them", async () => {
    const { employeeId } = await mkEmployeeD09("a");

    const putRes = await putVacationD09(employeeId, {
      year: 2027,
      totalDays: 30,
      carriedOverDays: 3,
      carryOverReason: "MATERNITY",
      carryOverNote: "Mutterschutz bis 15.02.",
      carryOverDeadline: "2028-06-30",
    });
    expect(putRes.statusCode, `PUT must succeed: ${putRes.body}`).toBe(200);

    const getRes = await getVacationD09(employeeId);
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json() as {
      carryOverReason: string | null;
      carryOverNote: string | null;
    };
    expect(body.carryOverReason).toBe("MATERNITY");
    expect(body.carryOverNote).toBe("Mutterschutz bis 15.02.");
  });

  it("returns carryOverReason null and carryOverNote null for a row without a documented reason", async () => {
    const { employeeId } = await mkEmployeeD09("b");

    const getRes = await getVacationD09(employeeId);
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json() as {
      carryOverReason: string | null;
      carryOverNote: string | null;
    };
    expect(body.carryOverReason).toBeNull();
    expect(body.carryOverNote).toBeNull();
  });
});
