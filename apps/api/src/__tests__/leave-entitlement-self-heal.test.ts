/**
 * Integration tests for Phase 59 (v1.6.5) and COMP-V1814-03 (Phase 76.21-04):
 *
 * Phase 59: Verifies that GET /reports/leave-overview self-heals divergent
 * LeaveEntitlement.usedDays values from Σ approved LeaveRequest.days,
 * mirroring the long-standing heal in GET /entitlements/:employeeId.
 *
 * COMP-V1814-03: Carry-over expiry is gated on a documented EuGH Hinweis
 * (CARRYOVER_WARNED AuditLog entry). Days do NOT expire unless a warning was
 * recorded for that employee+entitlement. See docs/burlg-carryover.md.
 *
 * Test pattern: shared singleton Fastify app via getTestApp, per-suite tenant slug.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

describe("LeaveEntitlement.usedDays self-heal in /reports/leave-overview (Phase 59)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let currentYear: number;

  // Employee A: report divergence (stored=24, actual=13)
  let empA_Id: string;
  let empA_EntId: string;
  // Employee B: leave-page regression (stored=10, actual=0)
  let empB_Id: string;
  let empB_EntId: string;
  // Employee C: legacy alias aggregation (entitlement on "Urlaub", approved request on "Jahresurlaub")
  let empC_Id: string;
  let empC_EntId: string;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    currentYear = new Date().getFullYear();
    const s = "lsh-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    // ── Tenant + tenantConfig ──────────────────────────────────────────────
    const tenant = await prisma.tenant.create({
      data: {
        name: `Leave Self Heal ${s}`,
        slug: `lsh-${s}`,
        federalState: "NIEDERSACHSEN",
      },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId: tenant.id, defaultVacationDays: 20, timezone: "Europe/Berlin" },
    });

    // ── Admin user + employee + login → adminToken ─────────────────────────
    const adminPasswordHash = await bcrypt.hash("test1234", 10);
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${s}@test.de`,
        passwordHash: adminPasswordHash,
        role: "ADMIN",
        isActive: true,
      },
    });
    await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: adminUser.id,
        employeeNumber: `ADM-${s}`,
        firstName: "Admin",
        lastName: "SelfHeal",
        hireDate: new Date("2024-01-01"),
      },
    });
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `admin-${s}@test.de`, password: "test1234" },
    });
    adminToken = JSON.parse(loginRes.body).accessToken as string;

    // ── LeaveType "Urlaub" (canonical) + "Jahresurlaub" (legacy alias) ─────
    const urlaub = await prisma.leaveType.create({
      data: {
        tenantId: tenant.id,
        name: "Urlaub",
        isPaid: true,
        requiresApproval: true,
        color: "#3B82F6",
      },
    });
    const jahresurlaub = await prisma.leaveType.create({
      data: {
        tenantId: tenant.id,
        name: "Jahresurlaub",
        isPaid: true,
        requiresApproval: true,
        color: "#3B82F6",
      },
    });

    // Helper: create a fresh employee (user + employee + workSchedule + overtimeAccount).
    const mkEmployee = async (slug: string) => {
      const u = await prisma.user.create({
        data: {
          email: `${slug}-${s}@test.de`,
          passwordHash: await bcrypt.hash("test1234", 10),
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const emp = await prisma.employee.create({
        data: {
          tenantId: tenant.id,
          userId: u.id,
          employeeNumber: `${slug.toUpperCase()}-${s}`,
          firstName: slug,
          lastName: "Test",
          hireDate: new Date(`${currentYear}-01-01T00:00:00Z`),
        },
      });
      await prisma.workSchedule.create({
        data: {
          employeeId: emp.id,
          type: "FIXED_SCHEDULE",
          weeklyHours: 40,
          mondayHours: 8,
          tuesdayHours: 8,
          wednesdayHours: 8,
          thursdayHours: 8,
          fridayHours: 8,
          saturdayHours: 0,
          sundayHours: 0,
          validFrom: new Date(`${currentYear}-01-01T00:00:00Z`),
        },
      });
      await prisma.overtimeAccount.create({
        data: { employeeId: emp.id, balanceHours: 0 },
      });
      return emp.id;
    };

    // ── Employee A: divergent (stored 24, actual 13) ───────────────────────
    empA_Id = await mkEmployee("empA");
    const entA = await prisma.leaveEntitlement.create({
      data: {
        employeeId: empA_Id,
        leaveTypeId: urlaub.id,
        year: currentYear,
        totalDays: 20,
        usedDays: 24, // DIVERGENT — should heal to 13
        carriedOverDays: 0,
      },
    });
    empA_EntId = entA.id;
    await prisma.leaveRequest.create({
      data: {
        employeeId: empA_Id,
        leaveTypeId: urlaub.id,
        status: "APPROVED",
        startDate: new Date(`${currentYear}-03-01T00:00:00Z`),
        endDate: new Date(`${currentYear}-03-19T00:00:00Z`),
        days: 13,
      },
    });

    // ── Employee B: leave-page regression (stored 10, actual 0) ────────────
    empB_Id = await mkEmployee("empB");
    const entB = await prisma.leaveEntitlement.create({
      data: {
        employeeId: empB_Id,
        leaveTypeId: urlaub.id,
        year: currentYear,
        totalDays: 20,
        usedDays: 10, // DIVERGENT — should heal to 0 (no approved requests)
        carriedOverDays: 0,
      },
    });
    empB_EntId = entB.id;
    // No LeaveRequest for empB.

    // ── Employee C: legacy alias aggregation ───────────────────────────────
    // Entitlement is attached to "Urlaub" (canonical) with usedDays=0
    // BUT approved LeaveRequest is attached to "Jahresurlaub" (legacy) with days=5
    empC_Id = await mkEmployee("empC");
    const entC = await prisma.leaveEntitlement.create({
      data: {
        employeeId: empC_Id,
        leaveTypeId: urlaub.id,
        year: currentYear,
        totalDays: 20,
        usedDays: 0, // DIVERGENT — should heal to 5 (legacy alias aggregation)
        carriedOverDays: 0,
      },
    });
    empC_EntId = entC.id;
    await prisma.leaveRequest.create({
      data: {
        employeeId: empC_Id,
        leaveTypeId: jahresurlaub.id, // attached to LEGACY typeId
        status: "APPROVED",
        startDate: new Date(`${currentYear}-04-01T00:00:00Z`),
        endDate: new Date(`${currentYear}-04-07T00:00:00Z`),
        days: 5,
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("Test 1: report self-heals divergent row (stored 24 → actual 13)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/leave-overview?year=${currentYear}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{
      employee: { id: string };
      leaveType: { name: string };
      usedDays: number;
      totalDays: number;
      carriedOverDays: number;
      remainingDays: number;
    }>;

    const rowA = body.find((r) => r.employee.id === empA_Id && r.leaveType.name === "Urlaub");
    expect(rowA, "Employee A 'Urlaub' row must be present in report").toBeDefined();
    expect(rowA!.usedDays).toBe(13);
    expect(rowA!.totalDays).toBe(20);
    expect(rowA!.remainingDays).toBe(7); // 20 + 0 - 13

    // DB write-back assertion — the heal was persisted, not just response-time.
    const db = await app.prisma.leaveEntitlement.findUnique({ where: { id: empA_EntId } });
    expect(Number(db!.usedDays)).toBe(13);
  });

  it("Test 2: second call is idempotent — no second DB UPDATE", async () => {
    const before = await app.prisma.leaveEntitlement.findUnique({
      where: { id: empA_EntId },
      select: { updatedAt: true },
    });
    // Sleep 50ms so a stray UPDATE would produce a different timestamp.
    await new Promise((r) => setTimeout(r, 50));

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/leave-overview?year=${currentYear}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);

    const after = await app.prisma.leaveEntitlement.findUnique({
      where: { id: empA_EntId },
      select: { updatedAt: true },
    });
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
  });

  it("Test 3: GET /entitlements/:employeeId still self-heals (regression)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${empB_Id}?year=${currentYear}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; usedDays: number; leaveType: { name: string } }>;
    const row = body.find((r) => r.id === empB_EntId);
    expect(row, "Employee B 'Urlaub' entitlement row must be present").toBeDefined();
    expect(Number(row!.usedDays)).toBe(0);

    const db = await app.prisma.leaveEntitlement.findUnique({ where: { id: empB_EntId } });
    expect(Number(db!.usedDays)).toBe(0);
  });

  it("Test 4: vacation aggregation includes legacy 'Jahresurlaub' typeId", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/leave-overview?year=${currentYear}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{
      employee: { id: string };
      leaveType: { name: string };
      usedDays: number;
    }>;
    // Find the empC row whose entitlement was on "Urlaub" — its usedDays must
    // reflect the approved LeaveRequest that lives on the "Jahresurlaub" legacy typeId.
    const rowC = body.find((r) => r.employee.id === empC_Id && r.leaveType.name === "Urlaub");
    expect(rowC, "Employee C 'Urlaub' row must aggregate the 'Jahresurlaub' request").toBeDefined();
    expect(rowC!.usedDays).toBe(5);

    // Persisted on the canonical entitlement row.
    const db = await app.prisma.leaveEntitlement.findUnique({ where: { id: empC_EntId } });
    expect(Number(db!.usedDays)).toBe(5);
  });
});

// ── Phase 104 Plan 04, Task 1 (Pitfall 2): Section9Credit-aware self-heal ──────────────────
// selfHealUsedDays() must subtract only CONFIRMED Section9Credit.creditedDays from the raw
// Σ approved LeaveRequest.days sum — AU_PENDING and REJECTED credits must have zero effect,
// and entitlements with no credit at all must heal exactly as before (parity).
describe("selfHealUsedDays is Section9Credit-aware (Phase 104, Pitfall 2)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let currentYear: number;
  let vacationTypeId: string;
  let sickTypeId: string;

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    currentYear = new Date().getFullYear();
    const s = "s9sh-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: { name: `S9 SelfHeal ${s}`, slug: `s9sh-${s}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId: tenant.id, defaultVacationDays: 20, timezone: "Europe/Berlin" },
    });

    const adminPasswordHash = await bcrypt.hash("test1234", 10);
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${s}@test.de`,
        passwordHash: adminPasswordHash,
        role: "ADMIN",
        isActive: true,
      },
    });
    await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: adminUser.id,
        employeeNumber: `ADM-${s}`,
        firstName: "Admin",
        lastName: "S9SelfHeal",
        hireDate: new Date("2024-01-01"),
      },
    });
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `admin-${s}@test.de`, password: "test1234" },
    });
    adminToken = JSON.parse(loginRes.body).accessToken as string;

    const vacationType = await prisma.leaveType.create({
      data: {
        tenantId: tenant.id,
        name: "Urlaub",
        isPaid: true,
        requiresApproval: true,
        color: "#3B82F6",
      },
    });
    vacationTypeId = vacationType.id;
    const sickType = await prisma.leaveType.create({
      data: { tenantId: tenant.id, name: "Krankmeldung", isPaid: true, requiresApproval: false },
    });
    sickTypeId = sickType.id;
  });

  afterAll(async () => {
    try {
      // Section9Credit's two LeaveRequest FKs are onDelete: Restrict — must be removed
      // before cleanupTestData's leaveRequest.deleteMany, or that delete (and everything
      // it gates) silently fails and leaks fixture rows into the next run.
      await app.prisma.section9Credit.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("S9 self-heal test cleanup failed:", err);
    }
  });

  const employeeIds: string[] = [];

  // Shared fixture builder — creates one employee with a vacation LeaveRequest of
  // `vacationDays` days, an initial LeaveEntitlement.usedDays of `storedUsedDays`, and
  // zero or more Section9Credit rows against that vacation request.
  const mkFixture = async (
    slug: string,
    vacationDays: number,
    storedUsedDays: number,
    credits: Array<{ status: "AU_PENDING" | "CONFIRMED" | "REJECTED"; creditedDays: number }>,
  ) => {
    const prisma = app.prisma;
    const unique = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const u = await prisma.user.create({
      data: {
        email: `${slug}-${unique}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: u.id,
        employeeNumber: `${slug.toUpperCase()}-${unique}`,
        firstName: slug,
        lastName: "S9SelfHeal",
        hireDate: new Date(`${currentYear}-01-01T00:00:00Z`),
      },
    });
    employeeIds.push(emp.id);
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date(`${currentYear}-01-01T00:00:00Z`),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });

    const ent = await prisma.leaveEntitlement.create({
      data: {
        employeeId: emp.id,
        leaveTypeId: vacationTypeId,
        year: currentYear,
        totalDays: 20,
        usedDays: storedUsedDays,
        carriedOverDays: 0,
      },
    });

    const vacationRequest = await prisma.leaveRequest.create({
      data: {
        employeeId: emp.id,
        leaveTypeId: vacationTypeId,
        status: "APPROVED",
        startDate: new Date(`${currentYear}-06-01T00:00:00Z`),
        endDate: new Date(`${currentYear}-06-19T00:00:00Z`),
        days: vacationDays,
      },
    });

    for (const c of credits) {
      const sickRequest = await prisma.leaveRequest.create({
        data: {
          employeeId: emp.id,
          leaveTypeId: sickTypeId,
          status: "APPROVED",
          startDate: new Date(`${currentYear}-06-05T00:00:00Z`),
          endDate: new Date(`${currentYear}-06-06T00:00:00Z`),
          days: 2,
        },
      });
      await prisma.section9Credit.create({
        data: {
          employeeId: emp.id,
          sickRequestId: sickRequest.id,
          vacationRequestId: vacationRequest.id,
          overlapStart: new Date(`${currentYear}-06-05T00:00:00Z`),
          overlapEnd: new Date(`${currentYear}-06-06T00:00:00Z`),
          status: c.status,
          creditedDays: c.creditedDays,
        },
      });
    }

    return { employeeId: emp.id, entitlementId: ent.id, vacationRequestId: vacationRequest.id };
  };

  it("Test 1: a CONFIRMED § 9 credit is NOT written back up by selfHealUsedDays", async () => {
    // raw sum = 13, one CONFIRMED credit of 5 -> actual = 8. Stored already correct at 8.
    const fx = await mkFixture("s9sh-t1", 13, 8, [{ status: "CONFIRMED", creditedDays: 5 }]);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${fx.employeeId}?year=${currentYear}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; usedDays: number }>;
    const row = body.find((r) => r.id === fx.entitlementId);
    expect(row, "entitlement row must be present").toBeDefined();
    // MUST stay 8 — a naive Σ LeaveRequest.days heal would write it back up to 13.
    expect(Number(row!.usedDays)).toBe(8);

    const db = await app.prisma.leaveEntitlement.findUnique({ where: { id: fx.entitlementId } });
    expect(Number(db!.usedDays)).toBe(8);
  });

  it("Test 2: an AU_PENDING credit has NO effect — self-heal still heals to the raw request sum", async () => {
    // raw sum = 13, one AU_PENDING credit of 5 (deliberately effect-free, D-09). Stored
    // stale at 10 -> must heal UP to the full 13, ignoring the pending credit.
    const fx = await mkFixture("s9sh-t2", 13, 10, [{ status: "AU_PENDING", creditedDays: 5 }]);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${fx.employeeId}?year=${currentYear}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; usedDays: number }>;
    const row = body.find((r) => r.id === fx.entitlementId);
    expect(row, "entitlement row must be present").toBeDefined();
    expect(Number(row!.usedDays)).toBe(13);
  });

  it("Test 3: a REJECTED credit has no effect either", async () => {
    const fx = await mkFixture("s9sh-t3", 13, 10, [{ status: "REJECTED", creditedDays: 5 }]);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${fx.employeeId}?year=${currentYear}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; usedDays: number }>;
    const row = body.find((r) => r.id === fx.entitlementId);
    expect(row, "entitlement row must be present").toBeDefined();
    expect(Number(row!.usedDays)).toBe(13);
  });

  it("Test 4 (parity): genuine drift with no credit at all is still healed to Σ LeaveRequest.days, byte-identical to today", async () => {
    const fx = await mkFixture("s9sh-t4", 13, 20, []);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${fx.employeeId}?year=${currentYear}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; usedDays: number }>;
    const row = body.find((r) => r.id === fx.entitlementId);
    expect(row, "entitlement row must be present").toBeDefined();
    expect(Number(row!.usedDays)).toBe(13);
  });

  it("Test 5: two CONFIRMED credits against the same vacation request sum correctly", async () => {
    // raw sum = 13, two CONFIRMED credits of 3 + 2 = 5 -> actual = 8. No double subtraction,
    // no missed one.
    const fx = await mkFixture("s9sh-t5", 13, 25, [
      { status: "CONFIRMED", creditedDays: 3 },
      { status: "CONFIRMED", creditedDays: 2 },
    ]);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${fx.employeeId}?year=${currentYear}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; usedDays: number }>;
    const row = body.find((r) => r.id === fx.entitlementId);
    expect(row, "entitlement row must be present").toBeDefined();
    expect(Number(row!.usedDays)).toBe(8);
  });
});

// ── COMP-V1814-03: EuGH C-684/16 carry-over expiry gate ─────────────────────
// Carry-over days do NOT expire on the deadline unless a CARRYOVER_WARNED
// AuditLog entry was recorded for that entitlement. Without a documented
// warning the employer cannot forfeit the employee's entitlement.
// See docs/burlg-carryover.md for the legal basis.
describe("carryover expiry gate (COMP-V1814-03)", () => {
  let app: FastifyInstance;
  let gateAdminToken: string;
  let gateTenantId: string;
  let gateEmpId: string;
  let gateLeaveTypeId: string;

  // A deadline firmly in the past (previous calendar year)
  const pastDeadline = new Date(new Date().getFullYear() - 1, 2, 31, 23, 59, 59); // 31 Mar last year
  // A deadline firmly in the future
  const futureDeadline = new Date(new Date().getFullYear() + 1, 2, 31, 23, 59, 59); // 31 Mar next year

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const s = "ceg-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: { name: `CEG Tenant ${s}`, slug: `ceg-${s}`, federalState: "NIEDERSACHSEN" },
    });
    gateTenantId = tenant.id;
    await prisma.tenantConfig.create({
      data: { tenantId: tenant.id, defaultVacationDays: 20, timezone: "Europe/Berlin" },
    });

    const adminUser = await prisma.user.create({
      data: {
        email: `admin-ceg-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "ADMIN",
        isActive: true,
      },
    });
    await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: adminUser.id,
        employeeNumber: `ADM-CEG-${s}`,
        firstName: "Admin",
        lastName: "CEG",
        hireDate: new Date("2024-01-01"),
      },
    });
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `admin-ceg-${s}@test.de`, password: "test1234" },
    });
    gateAdminToken = JSON.parse(loginRes.body).accessToken as string;

    const lt = await prisma.leaveType.create({
      data: {
        tenantId: tenant.id,
        name: "Urlaub",
        isPaid: true,
        requiresApproval: true,
        color: "#3B82F6",
      },
    });
    gateLeaveTypeId = lt.id;

    const empUser = await prisma.user.create({
      data: {
        email: `emp-ceg-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: empUser.id,
        employeeNumber: `EMP-CEG-${s}`,
        firstName: "TestEmp",
        lastName: "CEG",
        hireDate: new Date("2024-01-01"),
      },
    });
    gateEmpId = emp.id;
    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, gateTenantId);
    } catch (err) {
      console.error("CEG test cleanup failed:", err);
    }
  });

  it("carryover expiry gate — no warning preserves days", async () => {
    // Past deadline + carriedOverDays=5, but NO CARRYOVER_WARNED audit entry.
    // EuGH C-684/16: entitlement must be preserved.
    const year = 2020; // fixed historic year avoids autoCarryOver interference
    const ent = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: gateEmpId,
        leaveTypeId: gateLeaveTypeId,
        year,
        totalDays: 20,
        usedDays: 0,
        carriedOverDays: 5,
        carryOverDeadline: pastDeadline,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${gateEmpId}?year=${year}`,
      headers: { authorization: `Bearer ${gateAdminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ id: string; effectiveCarryOverDays: number }>;
    const row = rows.find((r) => r.id === ent.id);
    expect(row, "entitlement row must be present in response").toBeDefined();
    // Without a documented warning, carry-over must NOT expire (EuGH C-684/16)
    expect(row!.effectiveCarryOverDays).toBe(5);

    await app.prisma.leaveEntitlement.delete({ where: { id: ent.id } });
  });

  it("carryover expiry gate — warning expires days", async () => {
    // Past deadline + carriedOverDays=5 + CARRYOVER_WARNED audit entry present.
    // Warning was issued → employer fulfilled Hinweispflicht → expiry is valid.
    const year = 2019;
    const ent = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: gateEmpId,
        leaveTypeId: gateLeaveTypeId,
        year,
        totalDays: 20,
        usedDays: 0,
        carriedOverDays: 5,
        carryOverDeadline: pastDeadline,
      },
    });

    // Seed the CARRYOVER_WARNED audit row (proof of Hinweispflicht fulfillment)
    await app.prisma.auditLog.create({
      data: {
        action: "CARRYOVER_WARNED",
        entity: "LeaveEntitlement",
        entityId: ent.id,
        newValue: { thresholdDays: 30, year, carriedOverDays: 5 },
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${gateEmpId}?year=${year}`,
      headers: { authorization: `Bearer ${gateAdminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ id: string; effectiveCarryOverDays: number }>;
    const row = rows.find((r) => r.id === ent.id);
    expect(row, "entitlement row must be present in response").toBeDefined();
    // Warning was issued → expiry is legally valid
    expect(row!.effectiveCarryOverDays).toBe(0);

    await app.prisma.auditLog.deleteMany({
      where: { action: "CARRYOVER_WARNED", entity: "LeaveEntitlement", entityId: ent.id },
    });
    await app.prisma.leaveEntitlement.delete({ where: { id: ent.id } });
  });

  it("carryover expiry gate — before deadline", async () => {
    // Future deadline + carriedOverDays=5. Even with a warning, days must be preserved
    // because the deadline has not yet passed.
    const year = 2018;
    const ent = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: gateEmpId,
        leaveTypeId: gateLeaveTypeId,
        year,
        totalDays: 20,
        usedDays: 0,
        carriedOverDays: 5,
        carryOverDeadline: futureDeadline,
      },
    });

    // A warning exists but the deadline is in the future — must still be preserved
    await app.prisma.auditLog.create({
      data: {
        action: "CARRYOVER_WARNED",
        entity: "LeaveEntitlement",
        entityId: ent.id,
        newValue: { thresholdDays: 30, year, carriedOverDays: 5 },
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${gateEmpId}?year=${year}`,
      headers: { authorization: `Bearer ${gateAdminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ id: string; effectiveCarryOverDays: number }>;
    const row = rows.find((r) => r.id === ent.id);
    expect(row, "entitlement row must be present in response").toBeDefined();
    // Deadline not yet reached → always preserved regardless of warning
    expect(row!.effectiveCarryOverDays).toBe(5);

    await app.prisma.auditLog.deleteMany({
      where: { action: "CARRYOVER_WARNED", entity: "LeaveEntitlement", entityId: ent.id },
    });
    await app.prisma.leaveEntitlement.delete({ where: { id: ent.id } });
  });
});
