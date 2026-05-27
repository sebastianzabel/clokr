/**
 * Integration tests for Phase 59 (v1.6.5):
 *
 * Verifies that GET /reports/leave-overview self-heals divergent
 * LeaveEntitlement.usedDays values from Σ approved LeaveRequest.days,
 * mirroring the long-standing heal in GET /entitlements/:employeeId.
 *
 * Reproduces the a-tenant tenant bug from 2026-05-27 where four employees
 * had stored usedDays diverging from actual approved-request sums and the
 * report displayed the stale wrong number while the leave page silently
 * corrected it.
 *
 * Test pattern mirrors apps/api/src/__tests__/monthly-hours-leave-skip.test.ts:
 * shared singleton Fastify app via getTestApp, per-suite tenant slug.
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
