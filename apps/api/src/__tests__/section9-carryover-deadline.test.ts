/**
 * Phase 104 Plan 04 (Task 2 + Task 3 + Task 4) — regression pins for the illness carry-over
 * deadline guard (D-19 / R9).
 *
 * D-19: if a § 9 BUrlG credit lands into a LeaveEntitlement row whose origin year's carry-over
 * deadline has already passed, plan 104-06 marks that row `carryOverReason = "ILLNESS"` and sets
 * an extended EuGH KHS C-214/10 deadline (15 months). THREE production code paths write
 * `LeaveEntitlement.carryOverDeadline` and, before this plan, all three did so unconditionally:
 *
 *   1. `recalculateCarryOver` (leave.ts) — runs after every booking/cancellation
 *   2. `autoCarryOver` (leave.ts) — runs on every GET /entitlements/:employeeId
 *   3. `PUT /api/v1/settings/vacation/:employeeId` (settings.ts) — admin entitlement save
 *
 * All three now consult the single shared predicate `preserveIllnessDeadline`
 * (utils/illness-carryover-guard.ts). This file pins that an ILLNESS-protected deadline
 * survives all three, that non-ILLNESS rows are unaffected, and (Task 4) that no fourth,
 * divergent copy of the predicate can creep in undetected.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

// Recursively collects every .ts file path under `dir`, skipping node_modules/__tests__/dotfiles.
function walkTsFiles(dir: string, skipTests = true): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    if (skipTests && entry.name === "__tests__") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(full, skipTests));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("recalculateCarryOver / autoCarryOver — ILLNESS deadline protection (Phase 104 Plan 04, Task 2)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let currentYear: number;
  let vacationTypeId: string;

  // Default tenant carry-over deadline (config not overridden): March 31 of the given year.
  const defaultDeadline = (year: number) => new Date(year, 2, 31, 23, 59, 59);
  // A deliberately distinct extended deadline (well past the tenant default) so the two are
  // trivially distinguishable in assertions.
  const illnessDeadline = (year: number) => new Date(year, 5, 30, 23, 59, 59); // June 30

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    currentYear = new Date().getFullYear();
    const s = "s9cd-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: { name: `S9 CarryDeadline ${s}`, slug: `s9cd-${s}`, federalState: "NIEDERSACHSEN" },
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
        lastName: "S9CarryDeadline",
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
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("S9 carry-over deadline test cleanup failed:", err);
    }
  });

  const mkEmployee = async (slug: string) => {
    const prisma = app.prisma;
    const u = await prisma.user.create({
      data: {
        email: `${slug}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: u.id,
        employeeNumber: slug.toUpperCase(),
        firstName: slug,
        lastName: "S9CarryDeadline",
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

  // Approves a 5-day PENDING vacation LeaveRequest for `employeeId` covering
  // currentYear, via the real PATCH /requests/:id/review route — this is what actually
  // triggers deductVacationDays -> recalculateCarryOver(currentYear + 1) in production.
  const approveFiveDayVacation = async (employeeId: string) => {
    const req = await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: vacationTypeId,
        status: "PENDING",
        startDate: new Date(`${currentYear}-07-06T00:00:00Z`), // a Monday
        endDate: new Date(`${currentYear}-07-10T00:00:00Z`), // Friday
        days: 5,
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${req.id}/review`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: "APPROVED" },
    });
    expect(res.statusCode, `approval must succeed: ${res.body}`).toBe(200);
  };

  it("Test 1: an ILLNESS-protected deadline survives a subsequent unrelated booking (recalculateCarryOver)", async () => {
    const employeeId = await mkEmployee("s9cd-t1");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: vacationTypeId,
        year: currentYear,
        totalDays: 20,
        usedDays: 0,
        carriedOverDays: 0,
      },
    });
    const protectedDeadline = illnessDeadline(currentYear + 1);
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: vacationTypeId,
        year: currentYear + 1,
        totalDays: 0,
        usedDays: 0,
        carriedOverDays: 0,
        carryOverReason: "ILLNESS",
        carryOverDeadline: protectedDeadline,
      },
    });

    await approveFiveDayVacation(employeeId);

    const nextYearEnt = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId,
          leaveTypeId: vacationTypeId,
          year: currentYear + 1,
        },
      },
    });
    expect(nextYearEnt).toBeDefined();
    // RED before 104-04 Task 2: deadline came back as <tenant default>, not the 15-month date.
    expect(nextYearEnt!.carryOverDeadline?.getTime()).toBe(protectedDeadline.getTime());
    expect(nextYearEnt!.carryOverReason).toBe("ILLNESS");
  });

  it("Test 2: carriedOverDays IS still updated by the same booking (D-20 depends on it)", async () => {
    const employeeId = await mkEmployee("s9cd-t2");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: vacationTypeId,
        year: currentYear,
        totalDays: 20,
        usedDays: 0,
        carriedOverDays: 0,
      },
    });
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: vacationTypeId,
        year: currentYear + 1,
        totalDays: 0,
        usedDays: 0,
        carriedOverDays: 0,
        carryOverReason: "ILLNESS",
        carryOverDeadline: illnessDeadline(currentYear + 1),
      },
    });

    await approveFiveDayVacation(employeeId);

    const nextYearEnt = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId,
          leaveTypeId: vacationTypeId,
          year: currentYear + 1,
        },
      },
    });
    // remaining = 20 + 0 - 5 (the just-approved booking) = 15
    expect(Number(nextYearEnt!.carriedOverDays)).toBe(15);
  });

  it("Test 3: an entitlement with carryOverReason = null still has its deadline recomputed to the tenant default", async () => {
    const employeeId = await mkEmployee("s9cd-t3");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: vacationTypeId,
        year: currentYear,
        totalDays: 20,
        usedDays: 0,
        carriedOverDays: 0,
      },
    });
    const staleDeadline = new Date(currentYear - 1, 0, 1); // clearly wrong/stale
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: vacationTypeId,
        year: currentYear + 1,
        totalDays: 0,
        usedDays: 0,
        carriedOverDays: 0,
        carryOverReason: null,
        carryOverDeadline: staleDeadline,
      },
    });

    await approveFiveDayVacation(employeeId);

    const nextYearEnt = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId,
          leaveTypeId: vacationTypeId,
          year: currentYear + 1,
        },
      },
    });
    expect(nextYearEnt!.carryOverDeadline?.getTime()).toBe(
      defaultDeadline(currentYear + 1).getTime(),
    );
  });

  it("Test 4: an entitlement with carryOverReason = 'OPERATIONAL' also has its deadline recomputed (guard is ILLNESS-specific)", async () => {
    const employeeId = await mkEmployee("s9cd-t4");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: vacationTypeId,
        year: currentYear,
        totalDays: 20,
        usedDays: 0,
        carriedOverDays: 0,
      },
    });
    const staleDeadline = new Date(currentYear - 1, 0, 1);
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: vacationTypeId,
        year: currentYear + 1,
        totalDays: 0,
        usedDays: 0,
        carriedOverDays: 0,
        carryOverReason: "OPERATIONAL",
        carryOverDeadline: staleDeadline,
      },
    });

    await approveFiveDayVacation(employeeId);

    const nextYearEnt = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId,
          leaveTypeId: vacationTypeId,
          year: currentYear + 1,
        },
      },
    });
    expect(nextYearEnt!.carryOverDeadline?.getTime()).toBe(
      defaultDeadline(currentYear + 1).getTime(),
    );
    expect(nextYearEnt!.carryOverReason).toBe("OPERATIONAL");
  });

  it("Test 5: the same protection holds through autoCarryOver (GET /entitlements/:employeeId)", async () => {
    const employeeId = await mkEmployee("s9cd-t5");
    // Remaining = 20 - 5 = 15 > 0, so autoCarryOver's early "already carried over" guard
    // (`cur && carriedOverDays > 0`) must NOT fire — carriedOverDays starts at 0 below.
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: vacationTypeId,
        year: currentYear,
        totalDays: 20,
        usedDays: 5,
        carriedOverDays: 0,
      },
    });
    const protectedDeadline = illnessDeadline(currentYear + 1);
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: vacationTypeId,
        year: currentYear + 1,
        totalDays: 0,
        usedDays: 0,
        carriedOverDays: 0, // must stay 0 so autoCarryOver's early-return does not trigger
        carryOverReason: "ILLNESS",
        carryOverDeadline: protectedDeadline,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${employeeId}?year=${currentYear + 1}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);

    const nextYearEnt = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId,
          leaveTypeId: vacationTypeId,
          year: currentYear + 1,
        },
      },
    });
    expect(nextYearEnt!.carryOverDeadline?.getTime()).toBe(protectedDeadline.getTime());
    // carriedOverDays IS still updated by autoCarryOver, mirroring Test 2's expectation.
    expect(Number(nextYearEnt!.carriedOverDays)).toBe(15);
  });
});

describe("PUT /settings/vacation — ILLNESS deadline protection", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let year: number;
  let vacationTypeId: string;

  const protectedDeadline = new Date(2027, 5, 30, 23, 59, 59); // June 30 2027 — deliberately not a tenant default

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    year = new Date().getFullYear();
    const s = "s9pv-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const tenant = await prisma.tenant.create({
      data: { name: `S9 PutVacation ${s}`, slug: `s9pv-${s}`, federalState: "NIEDERSACHSEN" },
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
        lastName: "S9PutVacation",
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
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("S9 PUT vacation test cleanup failed:", err);
    }
  });

  const mkEmployee = async (slug: string) => {
    const prisma = app.prisma;
    const u = await prisma.user.create({
      data: {
        email: `${slug}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: u.id,
        employeeNumber: slug.toUpperCase(),
        firstName: slug,
        lastName: "S9PutVacation",
        hireDate: new Date(`${year}-01-01T00:00:00Z`),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });
    return emp.id;
  };

  const putVacation = async (employeeId: string, body: Record<string, unknown>) =>
    app.inject({
      method: "PUT",
      url: `/api/v1/settings/vacation/${employeeId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: body,
    });

  it("PUT /settings/vacation cannot strip an ILLNESS-protected carryOverDeadline when the field is omitted", async () => {
    const employeeId = await mkEmployee("s9pv-t1");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: vacationTypeId,
        year,
        totalDays: 5,
        usedDays: 0,
        carriedOverDays: 3,
        carryOverReason: "ILLNESS",
        carryOverDeadline: protectedDeadline,
      },
    });

    const res = await putVacation(employeeId, { year, totalDays: 10 });
    expect(res.statusCode, `PUT must succeed: ${res.body}`).toBe(200);
    const body = res.json() as { carryOverDeadline: string | null; totalDays: number };
    expect(new Date(body.carryOverDeadline!).getTime()).toBe(protectedDeadline.getTime());
    expect(body.totalDays).toBe(10);

    const db = await app.prisma.leaveEntitlement.findUnique({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: vacationTypeId, year } },
    });
    // RED before 104-04 Task 3: carryOverDeadline came back null, the 15-month date was gone.
    expect(db!.carryOverDeadline?.getTime()).toBe(protectedDeadline.getTime());
  });

  it("PUT /settings/vacation cannot strip an ILLNESS-protected carryOverDeadline when the field is explicitly null", async () => {
    const employeeId = await mkEmployee("s9pv-t2");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: vacationTypeId,
        year,
        totalDays: 5,
        usedDays: 0,
        carriedOverDays: 3,
        carryOverReason: "ILLNESS",
        carryOverDeadline: protectedDeadline,
      },
    });

    // Mirrors what the admin form actually sends when the date input is left empty.
    const res = await putVacation(employeeId, { year, totalDays: 10, carryOverDeadline: null });
    expect(res.statusCode, `PUT must succeed: ${res.body}`).toBe(200);

    const db = await app.prisma.leaveEntitlement.findUnique({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: vacationTypeId, year } },
    });
    expect(db!.carryOverDeadline?.getTime()).toBe(protectedDeadline.getTime());
  });

  it("an explicit non-null carryOverDeadline on an ILLNESS row IS applied and writes a distinct override audit row", async () => {
    const employeeId = await mkEmployee("s9pv-t3");
    const entitlement = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: vacationTypeId,
        year,
        totalDays: 5,
        usedDays: 0,
        carriedOverDays: 3,
        carryOverReason: "ILLNESS",
        carryOverDeadline: protectedDeadline,
      },
    });
    const correctedDeadline = "2028-01-15";

    const res = await putVacation(employeeId, {
      year,
      totalDays: 10,
      carryOverDeadline: correctedDeadline,
    });
    expect(res.statusCode, `PUT must succeed: ${res.body}`).toBe(200);

    const db = await app.prisma.leaveEntitlement.findUnique({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: vacationTypeId, year } },
    });
    expect(db!.carryOverDeadline?.toISOString().slice(0, 10)).toBe(correctedDeadline);

    const overrideAudit = await app.prisma.auditLog.findFirst({
      where: {
        action: "LEAVE_ENTITLEMENT_ILLNESS_DEADLINE_OVERRIDDEN",
        entity: "LeaveEntitlement",
        entityId: entitlement.id,
      },
    });
    expect(overrideAudit, "a distinct override audit row must exist").toBeDefined();
    expect(overrideAudit!.oldValue).toMatchObject({ carryOverReason: "ILLNESS" });
  });

  it("a row with carryOverReason = null and an omitted carryOverDeadline still ends up null, no override audit", async () => {
    const employeeId = await mkEmployee("s9pv-t4");
    const entitlement = await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: vacationTypeId,
        year,
        totalDays: 5,
        usedDays: 0,
        carriedOverDays: 3,
        carryOverReason: null,
        carryOverDeadline: null,
      },
    });

    const res = await putVacation(employeeId, { year, totalDays: 10 });
    expect(res.statusCode, `PUT must succeed: ${res.body}`).toBe(200);

    const db = await app.prisma.leaveEntitlement.findUnique({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: vacationTypeId, year } },
    });
    expect(db!.carryOverDeadline).toBeNull();

    const overrideAudit = await app.prisma.auditLog.findFirst({
      where: {
        action: "LEAVE_ENTITLEMENT_ILLNESS_DEADLINE_OVERRIDDEN",
        entity: "LeaveEntitlement",
        entityId: entitlement.id,
      },
    });
    expect(overrideAudit, "no override audit row for a non-protected row").toBeNull();
  });

  it("carriedOverDays omitted on an ILLNESS row preserves the stored value; omitted on a non-ILLNESS row still writes 0", async () => {
    const illnessEmployeeId = await mkEmployee("s9pv-t5a");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: illnessEmployeeId,
        leaveTypeId: vacationTypeId,
        year,
        totalDays: 5,
        usedDays: 0,
        carriedOverDays: 7,
        carryOverReason: "ILLNESS",
        carryOverDeadline: protectedDeadline,
      },
    });
    const resIllness = await putVacation(illnessEmployeeId, { year, totalDays: 10 });
    expect(resIllness.statusCode).toBe(200);
    const dbIllness = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: illnessEmployeeId,
          leaveTypeId: vacationTypeId,
          year,
        },
      },
    });
    expect(Number(dbIllness!.carriedOverDays)).toBe(7);

    const normalEmployeeId = await mkEmployee("s9pv-t5b");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: normalEmployeeId,
        leaveTypeId: vacationTypeId,
        year,
        totalDays: 5,
        usedDays: 0,
        carriedOverDays: 7,
        carryOverReason: null,
        carryOverDeadline: null,
      },
    });
    const resNormal = await putVacation(normalEmployeeId, { year, totalDays: 10 });
    expect(resNormal.statusCode).toBe(200);
    const dbNormal = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: normalEmployeeId,
          leaveTypeId: vacationTypeId,
          year,
        },
      },
    });
    expect(Number(dbNormal!.carriedOverDays)).toBe(0);
  });

  it("totalDays is written unchanged in every one of the above cases — the guard protects the deadline, never the number the admin came to change", async () => {
    const employeeId = await mkEmployee("s9pv-t6");
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: vacationTypeId,
        year,
        totalDays: 5,
        usedDays: 0,
        carriedOverDays: 3,
        carryOverReason: "ILLNESS",
        carryOverDeadline: protectedDeadline,
      },
    });

    const res = await putVacation(employeeId, { year, totalDays: 27 });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { totalDays: number };
    expect(body.totalDays).toBe(27);

    const db = await app.prisma.leaveEntitlement.findUnique({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: vacationTypeId, year } },
    });
    expect(Number(db!.totalDays)).toBe(27);
  });
});

describe("structural guard against a divergent copy (Phase 104 Plan 04, Task 4)", () => {
  it("every carryOverDeadline writer goes through preserveIllnessDeadline (guards against a divergent copy)", () => {
    const apiSrc = join(__dirname, "..");
    const leaveTs = readFileSync(join(apiSrc, "routes", "leave.ts"), "utf-8");
    const settingsTs = readFileSync(join(apiSrc, "routes", "settings.ts"), "utf-8");

    const leaveMatches = leaveTs.match(/preserveIllnessDeadline/g) ?? [];
    expect(
      leaveMatches.length,
      "leave.ts must reference preserveIllnessDeadline at least twice (both writers)",
    ).toBeGreaterThanOrEqual(2);

    const settingsMatches = settingsTs.match(/preserveIllnessDeadline/g) ?? [];
    expect(
      settingsMatches.length,
      "settings.ts must reference preserveIllnessDeadline at least once",
    ).toBeGreaterThanOrEqual(1);

    // No file under apps/api/src outside utils/illness-carryover-guard.ts and __tests__/
    // may contain a divergent inline copy of the predicate.
    const allFiles = walkTsFiles(apiSrc, true);
    const offenders: string[] = [];
    for (const file of allFiles) {
      if (file.endsWith(join("utils", "illness-carryover-guard.ts"))) continue;
      const content = readFileSync(file, "utf-8");
      if (content.includes('=== "ILLNESS"')) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      `no production file may re-inline the ILLNESS predicate: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
