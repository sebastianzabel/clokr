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
  // Employee C: codeless legacy row (entitlement on "Urlaub", approved request on "Jahresurlaub" —
  // no longer aggregated post-Phase-97, see Test 4)
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

    // ── LeaveType "Urlaub" (canonical) + "Jahresurlaub" (legacy, codeless) ─────
    // Employee C exercises what USED TO BE name-based legacy-alias aggregation across two
    // DISTINCT rows for the same tenant. `jahresurlaub` deliberately stays codeless:
    // @@unique([tenantId, code]) forbids giving both rows the VACATION code. Phase 97 (Plan 09,
    // D-12) removes the name-list aggregation this fixture used to exercise; see Test 4 below
    // for the resulting (deliberate) behavior change.
    const urlaub = await prisma.leaveType.create({
      data: {
        tenantId: tenant.id,
        code: "VACATION",
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

    // ── Employee C: codeless legacy row, no longer aggregated (Test 4 below) ──────────────
    // Entitlement is attached to "Urlaub" (canonical) with usedDays=0.
    // An approved LeaveRequest sits on the codeless "Jahresurlaub" row instead — post-Phase-97
    // this no longer contributes to the canonical entitlement's heal (see Test 4).
    empC_Id = await mkEmployee("empC");
    const entC = await prisma.leaveEntitlement.create({
      data: {
        employeeId: empC_Id,
        leaveTypeId: urlaub.id,
        year: currentYear,
        totalDays: 20,
        usedDays: 0,
        carriedOverDays: 0,
      },
    });
    empC_EntId = entC.id;
    await prisma.leaveRequest.create({
      data: {
        employeeId: empC_Id,
        leaveTypeId: jahresurlaub.id, // attached to the codeless legacy row, not the canonical one
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

  it("Test 4 (Phase 97 D-12, deliberate behavior change): a codeless legacy row's approved request is NO LONGER aggregated into the canonical VACATION entitlement", async () => {
    // Pre-Phase-97 this row's usedDays healed to 5 (the "Jahresurlaub" row's approved request
    // was pulled in via a hard-coded German display-name list). Phase 97 resolves the
    // aggregation scope by `code === "VACATION"` alone; the codeless "Jahresurlaub" row has no
    // code and therefore no longer contributes. The tenant's own "Urlaub" LeaveRequest.days
    // total for empC is zero, so the entitlement heals to 0, not 5 — this is the AC-5
    // precondition in practice: Step 0's production query proved no codeless row with attached
    // requests exists in clokr/clokr_test at execution time, so this scenario is confined to
    // this deliberately-constructed fixture. A real orphaned row like "Jahresurlaub" here is
    // caught by the Plan 04 backfill/sweep script as a "conflicts" entry (its target code
    // VACATION is already claimed by the canonical "Urlaub" row) — it is surfaced for a human,
    // never silently absorbed again.
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
    const rowC = body.find((r) => r.employee.id === empC_Id && r.leaveType.name === "Urlaub");
    expect(rowC, "Employee C 'Urlaub' row must be present").toBeDefined();
    expect(rowC!.usedDays).toBe(0);

    // Persisted on the canonical entitlement row.
    const db = await app.prisma.leaveEntitlement.findUnique({ where: { id: empC_EntId } });
    expect(Number(db!.usedDays)).toBe(0);
  });
});

// ── Phase 97 Plan 09 (D-12): code-based aggregation scope, and the AC-5 characterization ──────
// The vacation/non-vacation branch is now driven by `leaveType.code === "VACATION"`, not a
// German display-name list. These tests pin the plan's <behavior> cases directly.
describe("selfHealUsedDays resolves the VACATION aggregation scope by code (Phase 97, D-12)", () => {
  let app: FastifyInstance;
  const tenantIds: string[] = [];
  let currentYear: number;

  beforeAll(async () => {
    app = await getTestApp();
    currentYear = new Date().getFullYear();
  });

  afterAll(async () => {
    for (const id of tenantIds) {
      try {
        await cleanupTestData(app, id);
      } catch (err) {
        console.error("Phase 97-09 self-heal test cleanup failed:", err);
      }
    }
  });

  // Each test gets its OWN tenant — @@unique([tenantId, code]) means a second VACATION-coded
  // row can never coexist with the first, so a shared tenant across tests would collide the
  // moment more than one test needs its own VACATION row.
  const mkTenant = async (slug: string) => {
    const prisma = app.prisma;
    const s = `p97sh-${slug}-` + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const tenant = await prisma.tenant.create({
      data: { name: `P97 SelfHeal ${s}`, slug: s, federalState: "NIEDERSACHSEN" },
    });
    tenantIds.push(tenant.id);
    await prisma.tenantConfig.create({
      data: { tenantId: tenant.id, defaultVacationDays: 20, timezone: "Europe/Berlin" },
    });
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
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
        lastName: "P97SelfHeal",
        hireDate: new Date("2024-01-01"),
      },
    });
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `admin-${s}@test.de`, password: "test1234" },
    });
    const adminToken = JSON.parse(loginRes.body).accessToken as string;
    return { tenantId: tenant.id, adminToken, s };
  };

  const mkEmployee = async (tenantId: string, slug: string, unique: string) => {
    const prisma = app.prisma;
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
        lastName: "P97SelfHeal",
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
    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    return emp.id;
  };

  it("a VACATION-code row still heals to Σ approved days after being renamed to something else (the D-12 fix — pre-Phase-97 this fell into the non-vacation branch and only aggregated its own leaveTypeId, which was correct here anyway; the point is the DISCRIMINATOR is now the code)", async () => {
    const prisma = app.prisma;
    const { tenantId, adminToken } = await mkTenant("renamed");
    const unique = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const renamedVacationType = await prisma.leaveType.create({
      data: {
        tenantId,
        code: "VACATION",
        name: "Erholungsurlaub", // renamed away from the canonical "Urlaub"
        isPaid: true,
        requiresApproval: true,
        color: "#3B82F6",
      },
    });
    const empId = await mkEmployee(tenantId, "renamed-vac", unique);
    const ent = await prisma.leaveEntitlement.create({
      data: {
        employeeId: empId,
        leaveTypeId: renamedVacationType.id,
        year: currentYear,
        totalDays: 20,
        usedDays: 999, // DIVERGENT — must heal to 7
        carriedOverDays: 0,
      },
    });
    await prisma.leaveRequest.create({
      data: {
        employeeId: empId,
        leaveTypeId: renamedVacationType.id,
        status: "APPROVED",
        startDate: new Date(`${currentYear}-05-01T00:00:00Z`),
        endDate: new Date(`${currentYear}-05-07T00:00:00Z`),
        days: 7,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${empId}?year=${currentYear}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; usedDays: number }>;
    const row = body.find((r) => r.id === ent.id);
    expect(row, "entitlement row must be present").toBeDefined();
    expect(Number(row!.usedDays)).toBe(7);

    const db = await prisma.leaveEntitlement.findUnique({ where: { id: ent.id } });
    expect(Number(db!.usedDays)).toBe(7);
  });

  it("a non-vacation row (code = SPECIAL) aggregates only its own leaveTypeId", async () => {
    const prisma = app.prisma;
    const { tenantId, adminToken } = await mkTenant("special");
    const unique = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const specialType = await prisma.leaveType.create({
      data: {
        tenantId,
        code: "SPECIAL",
        name: "Sonderurlaub",
        isPaid: true,
        requiresApproval: true,
        color: "#A855F7",
      },
    });
    // Prove isolation via a second, unrelated VACATION type whose request must NOT leak into
    // the SPECIAL sum.
    const vacationType = await prisma.leaveType.create({
      data: {
        tenantId,
        code: "VACATION",
        name: "Urlaub",
        isPaid: true,
        requiresApproval: true,
        color: "#3B82F6",
      },
    });
    const empId = await mkEmployee(tenantId, "special-only", unique);
    const ent = await prisma.leaveEntitlement.create({
      data: {
        employeeId: empId,
        leaveTypeId: specialType.id,
        year: currentYear,
        totalDays: 5,
        usedDays: 0,
        carriedOverDays: 0,
      },
    });
    await prisma.leaveRequest.create({
      data: {
        employeeId: empId,
        leaveTypeId: specialType.id,
        status: "APPROVED",
        startDate: new Date(`${currentYear}-06-01T00:00:00Z`),
        endDate: new Date(`${currentYear}-06-02T00:00:00Z`),
        days: 2,
      },
    });
    // Unrelated VACATION request for the same employee — must not contribute to the SPECIAL sum.
    await prisma.leaveRequest.create({
      data: {
        employeeId: empId,
        leaveTypeId: vacationType.id,
        status: "APPROVED",
        startDate: new Date(`${currentYear}-07-01T00:00:00Z`),
        endDate: new Date(`${currentYear}-07-10T00:00:00Z`),
        days: 10,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${empId}?year=${currentYear}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; usedDays: number }>;
    const row = body.find((r) => r.id === ent.id);
    expect(row, "entitlement row must be present").toBeDefined();
    expect(Number(row!.usedDays)).toBe(2); // not 12

    const db = await prisma.leaveEntitlement.findUnique({ where: { id: ent.id } });
    expect(Number(db!.usedDays)).toBe(2);
  });

  // ── AC-5 characterization vector (D-12 Schritt 1) ────────────────────────────────────────
  // One employee, three entitlement rows (VACATION/SPECIAL/SICK), mixed APPROVED/PENDING/
  // REJECTED requests. Captured against the UNCHANGED code first (see SUMMARY for the
  // pre-change run), then re-run after the switch — the vector below must be byte-identical
  // both times. This is the AC-5 evidence for D-12: not an assertion that the code is right,
  // a MEASUREMENT that nothing moved.
  it("characterization: the usedDays vector across VACATION/SPECIAL/SICK is unchanged by the code-based switch (AC-5)", async () => {
    const prisma = app.prisma;
    const { tenantId, adminToken } = await mkTenant("char");
    const unique = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const vacationType = await prisma.leaveType.create({
      data: {
        tenantId,
        code: "VACATION",
        name: "Urlaub-Char",
        isPaid: true,
        requiresApproval: true,
        color: "#3B82F6",
      },
    });
    const specialType = await prisma.leaveType.create({
      data: {
        tenantId,
        code: "SPECIAL",
        name: "Sonderurlaub-Char",
        isPaid: true,
        requiresApproval: true,
        color: "#A855F7",
      },
    });
    const sickType = await prisma.leaveType.create({
      data: {
        tenantId,
        code: "SICK",
        name: "Krankmeldung-Char",
        isPaid: true,
        requiresApproval: false,
        color: "#EF4444",
      },
    });
    const empId = await mkEmployee(tenantId, "char-vec", unique);

    const vacEnt = await prisma.leaveEntitlement.create({
      data: {
        employeeId: empId,
        leaveTypeId: vacationType.id,
        year: currentYear,
        totalDays: 25,
        usedDays: 999,
        carriedOverDays: 0,
      },
    });
    const specialEnt = await prisma.leaveEntitlement.create({
      data: {
        employeeId: empId,
        leaveTypeId: specialType.id,
        year: currentYear,
        totalDays: 5,
        usedDays: 999,
        carriedOverDays: 0,
      },
    });
    const sickEnt = await prisma.leaveEntitlement.create({
      data: {
        employeeId: empId,
        leaveTypeId: sickType.id,
        year: currentYear,
        totalDays: 0,
        usedDays: 999,
        carriedOverDays: 0,
      },
    });

    // VACATION: two APPROVED (8 + 3 = 11), one PENDING (must not count)
    await prisma.leaveRequest.create({
      data: {
        employeeId: empId,
        leaveTypeId: vacationType.id,
        status: "APPROVED",
        startDate: new Date(`${currentYear}-02-01T00:00:00Z`),
        endDate: new Date(`${currentYear}-02-08T00:00:00Z`),
        days: 8,
      },
    });
    await prisma.leaveRequest.create({
      data: {
        employeeId: empId,
        leaveTypeId: vacationType.id,
        status: "APPROVED",
        startDate: new Date(`${currentYear}-03-01T00:00:00Z`),
        endDate: new Date(`${currentYear}-03-03T00:00:00Z`),
        days: 3,
      },
    });
    await prisma.leaveRequest.create({
      data: {
        employeeId: empId,
        leaveTypeId: vacationType.id,
        status: "PENDING",
        startDate: new Date(`${currentYear}-08-01T00:00:00Z`),
        endDate: new Date(`${currentYear}-08-20T00:00:00Z`),
        days: 100,
      },
    });

    // SPECIAL: one APPROVED (2), one REJECTED (must not count)
    await prisma.leaveRequest.create({
      data: {
        employeeId: empId,
        leaveTypeId: specialType.id,
        status: "APPROVED",
        startDate: new Date(`${currentYear}-04-01T00:00:00Z`),
        endDate: new Date(`${currentYear}-04-02T00:00:00Z`),
        days: 2,
      },
    });
    await prisma.leaveRequest.create({
      data: {
        employeeId: empId,
        leaveTypeId: specialType.id,
        status: "REJECTED",
        startDate: new Date(`${currentYear}-04-10T00:00:00Z`),
        endDate: new Date(`${currentYear}-04-30T00:00:00Z`),
        days: 50,
      },
    });

    // SICK: one APPROVED (5)
    await prisma.leaveRequest.create({
      data: {
        employeeId: empId,
        leaveTypeId: sickType.id,
        status: "APPROVED",
        startDate: new Date(`${currentYear}-06-01T00:00:00Z`),
        endDate: new Date(`${currentYear}-06-05T00:00:00Z`),
        days: 5,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${empId}?year=${currentYear}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; usedDays: number }>;

    const vacRow = body.find((r) => r.id === vacEnt.id);
    const specialRow = body.find((r) => r.id === specialEnt.id);
    const sickRow = body.find((r) => r.id === sickEnt.id);
    expect(vacRow, "VACATION row present").toBeDefined();
    expect(specialRow, "SPECIAL row present").toBeDefined();
    expect(sickRow, "SICK row present").toBeDefined();

    // THE VECTOR — recorded verbatim in the plan's mandatory SUMMARY output, both pre- and
    // post-change runs.
    expect(Number(vacRow!.usedDays)).toBe(11);
    expect(Number(specialRow!.usedDays)).toBe(2);
    expect(Number(sickRow!.usedDays)).toBe(5);
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
        code: "VACATION",
        name: "Urlaub",
        isPaid: true,
        requiresApproval: true,
        color: "#3B82F6",
      },
    });
    vacationTypeId = vacationType.id;
    const sickType = await prisma.leaveType.create({
      data: {
        tenantId: tenant.id,
        code: "SICK",
        name: "Krankmeldung",
        isPaid: true,
        requiresApproval: false,
      },
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
        code: "VACATION",
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
