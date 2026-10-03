/**
 * Issue #450 (D-05, D-06, D-07, D-08) — guard suite for the regular branch of
 * PUT /api/v1/settings/work/:employeeId's reactive VACATION-entitlement recompute
 * (wired in 450-01): a human-set value is never overwritten (D-07, two detection paths),
 * already-taken/carried days are never touched and a negative remainder is written as-is,
 * never clamped (D-05), every change carries exactly one attributed audit (D-08), the
 * recompute's year range is exactly `changedFrom`'s UTC year through the current UTC year + 1
 * (D-06), a repeated identical PUT is idempotent, and a foreign tenant's row is untouched.
 *
 * Every guard below is proven non-vacuous by a recorded mutation run (see this plan's SUMMARY) —
 * removing the corresponding skip/bound in `recalcVacationEntitlementsForContractChange`
 * (leave-days.ts) makes the matching `it` below fail.
 *
 * Fixed dates only (`new Date(Date.UTC(...))`), current-UTC-year-relative where the plan's own
 * `<behavior>` block says "current UTC year" so the suite does not rot across a year boundary.
 * Initials-only fixtures (firstName "T", lastName "T") — no PII per CLAUDE.md.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("PUT /api/v1/settings/work/:employeeId — Vertragswechsel recompute guards (Issue #450, D-05/D-06/D-07/D-08)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let dataB: Awaited<ReturnType<typeof seedTestData>>;
  // Set by the negative-remainder test, consumed by the idempotence test that must run right
  // after it (both `it`s execute sequentially within this describe, Vitest's default order).
  let negRemainderEmployeeId: string;
  let negRemainderEntitlementId: string;

  async function mkEmployee(label: string, workDays: number[]): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `cc450g-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `CC450G-${label}-${uid}`,
        firstName: "T",
        lastName: "T",
        hireDate: new Date(Date.UTC(2024, 0, 1)),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "FIXED_SCHEDULE",
        mondayHours: workDays.includes(1) ? 8 : 0,
        tuesdayHours: workDays.includes(2) ? 8 : 0,
        wednesdayHours: workDays.includes(3) ? 8 : 0,
        thursdayHours: workDays.includes(4) ? 8 : 0,
        fridayHours: workDays.includes(5) ? 8 : 0,
        saturdayHours: 0,
        sundayHours: 0,
        workDays,
        validFrom: new Date(Date.UTC(2024, 0, 1)),
      },
    });
    return employee.id;
  }

  async function mkForeignTenantEmployee(): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `cc450g-b-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: dataB.tenant.id,
        userId: user.id,
        employeeNumber: `CC450G-B-${uid}`,
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
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3],
        validFrom: new Date(Date.UTC(2024, 0, 1)),
      },
    });
    return employee.id;
  }

  async function mkEntitlement(
    employeeId: string,
    year: number,
    totalDays: number,
    opts: { usedDays?: number; carriedOverDays?: number } = {},
  ): Promise<string> {
    const row = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        year,
        totalDays,
        usedDays: opts.usedDays ?? 0,
        carriedOverDays: opts.carriedOverDays ?? 0,
        isAutoCalculated: true,
      },
    });
    return row.id;
  }

  async function mkManualWrite(entitlementId: string, totalDays: number): Promise<void> {
    await app.prisma.auditLog.create({
      data: {
        action: "UPDATE",
        entity: "LeaveEntitlement",
        entityId: entitlementId,
        newValue: { totalDays },
      },
    });
  }

  async function entitlementRow(employeeId: string, year: number) {
    return app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: {
        employeeId_leaveTypeId_year: { employeeId, leaveTypeId: data.vacationType.id, year },
      },
    });
  }

  async function entitlementAudits(entitlementId: string) {
    return app.prisma.auditLog.findMany({
      where: { entity: "LeaveEntitlement", entityId: entitlementId, action: "UPDATE" },
      orderBy: { createdAt: "asc" },
    });
  }

  async function putWork(employeeId: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${employeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload,
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "cc450g");
    dataB = await seedTestData(app, "cc450g-b");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, dataB.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("stale-auto human row: isAutoCalculated TRUE but an audited human totalDays write — never overwritten, no new audit (D-07)", async () => {
    const employeeId = await mkEmployee("stale", [1, 2, 3]);
    const entitlementId = await mkEntitlement(employeeId, 2026, 18);
    await mkManualWrite(entitlementId, 18);

    const res = await putWork(employeeId, { type: "FIXED_SCHEDULE", validFrom: "2026-07-01" });
    expect(res.statusCode).toBe(200);

    const row = await entitlementRow(employeeId, 2026);
    expect(Number(row.totalDays)).toBe(18);

    // Exactly the one manual-write audit we inserted ourselves — no second (recompute) audit.
    const audits = await entitlementAudits(entitlementId);
    expect(audits).toHaveLength(1);
  });

  it("negative remainder: a total below usedDays is written as-is, never clamped or hidden (D-05); audit carries old/new, reason, validFrom, acting user (D-08)", async () => {
    const employeeId = await mkEmployee("negrem", [1, 2, 3, 4, 5]);
    const entitlementId = await mkEntitlement(employeeId, 2026, 30, {
      usedDays: 28,
      carriedOverDays: 3,
    });

    const res = await putWork(employeeId, {
      type: "FIXED_SCHEDULE",
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 0,
      fridayHours: 0,
      validFrom: "2026-07-01",
    });
    expect(res.statusCode).toBe(200);

    const row = await entitlementRow(employeeId, 2026);
    expect(Number(row.totalDays)).toBe(24);
    expect(Number(row.usedDays)).toBe(28);
    expect(Number(row.carriedOverDays)).toBe(3);

    const audits = await entitlementAudits(entitlementId);
    expect(audits).toHaveLength(1);
    expect((audits[0].oldValue as { totalDays: number }).totalDays).toBe(30);
    const newValue = audits[0].newValue as {
      totalDays: number;
      isAutoCalculated: boolean;
      reason: string;
      validFrom: string;
    };
    expect(newValue.totalDays).toBe(24);
    expect(newValue.isAutoCalculated).toBe(true);
    expect(newValue.reason).toBe("Vertragswechsel");
    expect(newValue.validFrom).toBe("2026-07-01");
    expect(audits[0].userId).toBe(data.adminUser.id);

    negRemainderEmployeeId = employeeId;
    negRemainderEntitlementId = entitlementId;
  });

  it("idempotence: repeating the IDENTICAL PUT of the negative-remainder case writes no second audit", async () => {
    // The row is already at the target value (24), so daysDiffer() sees no change — this is a
    // DIFFERENT assertion than the negative-remainder test above (it reuses that test's fixture
    // instead of rebuilding it, so it only runs after that test has set the row to 24).
    expect(negRemainderEmployeeId, "must run after the negative-remainder test").toBeDefined();

    const res = await putWork(negRemainderEmployeeId, {
      type: "FIXED_SCHEDULE",
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 0,
      fridayHours: 0,
      validFrom: "2026-07-01",
    });
    expect(res.statusCode).toBe(200);

    const audits = await entitlementAudits(negRemainderEntitlementId);
    expect(audits).toHaveLength(1);
  });

  it("year range: only years from changedFrom's UTC year through current UTC year + 1 are touched (D-06)", async () => {
    const cy = new Date().getUTCFullYear();
    const employeeId = await mkEmployee("yearrange", [1, 2, 3]);
    // cy-1 deliberately carries a value the formula would NOT produce (20, not 18) — if the
    // loop ever reached it, this assertion would catch it.
    await mkEntitlement(employeeId, cy - 1, 20);
    await mkEntitlement(employeeId, cy, 18);
    await mkEntitlement(employeeId, cy + 1, 18);
    await mkEntitlement(employeeId, cy + 2, 18);

    const res = await putWork(employeeId, { type: "FIXED_SCHEDULE", validFrom: `${cy}-07-01` });
    expect(res.statusCode).toBe(200);

    const rowPrev = await entitlementRow(employeeId, cy - 1);
    expect(Number(rowPrev.totalDays)).toBe(20);
    expect(await entitlementAudits(rowPrev.id)).toHaveLength(0);

    const rowCy = await entitlementRow(employeeId, cy);
    expect(Number(rowCy.totalDays)).toBe(24);

    const rowNext = await entitlementRow(employeeId, cy + 1);
    expect(Number(rowNext.totalDays)).toBe(30);

    const rowNext2 = await entitlementRow(employeeId, cy + 2);
    expect(Number(rowNext2.totalDays)).toBe(18);
    expect(await entitlementAudits(rowNext2.id)).toHaveLength(0);
  });

  it("future-dated: a contract change dated into next year recomputes only that year, never the current one (D-06, unconditional on validFrom)", async () => {
    const cy = new Date().getUTCFullYear();
    const employeeId = await mkEmployee("futuredated", [1, 2, 3]);
    await mkEntitlement(employeeId, cy, 20); // deliberately wrong (formula would give 18)
    await mkEntitlement(employeeId, cy + 1, 18);

    const res = await putWork(employeeId, {
      type: "FIXED_SCHEDULE",
      validFrom: `${cy + 1}-01-01`,
    });
    expect(res.statusCode).toBe(200);

    const rowCy = await entitlementRow(employeeId, cy);
    expect(Number(rowCy.totalDays)).toBe(20);
    expect(await entitlementAudits(rowCy.id)).toHaveLength(0);

    const rowNext = await entitlementRow(employeeId, cy + 1);
    expect(Number(rowNext.totalDays)).toBe(30);
  });

  it("tenant isolation: a foreign tenant's employee is untouched by another tenant's admin PUT (existing 404 guard)", async () => {
    const employeeId = await mkForeignTenantEmployee();
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: dataB.vacationType.id,
        year: 2026,
        totalDays: 18,
        usedDays: 0,
        carriedOverDays: 0,
        isAutoCalculated: true,
      },
    });

    const res = await putWork(employeeId, { type: "FIXED_SCHEDULE", validFrom: "2026-07-01" });
    expect(res.statusCode).toBe(404);

    const row = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId,
          leaveTypeId: dataB.vacationType.id,
          year: 2026,
        },
      },
    });
    expect(Number(row.totalDays)).toBe(18);
  });
});
