/**
 * Phase 67b Plan 01 Task 2 (issue #67) — AC-Vorschlag-1..4: `salonForDay()` acceptance cases,
 * imported through `contexts/platform` (the index re-export, D-16), plus `listSalonAssignments`
 * (D-17) and the GET route's role check (MANAGER 200 / EMPLOYEE 403).
 */
import bcrypt from "bcryptjs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { salonForDay, listSalonAssignments } from "../contexts/platform";
import { DEFAULT_SALON_OPENING_HOURS } from "../contexts/platform/facade/salons";

describe("salonForDay / listSalonAssignments (Phase 67b Plan 01 Task 2, issue #67)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let salonC: { id: string };
  let salonS: { id: string };
  let salonM: { id: string };
  // Phase 67b review: the Sunday-proof deployments (S/M) MUST use the literal instants
  // 2026-09-26T22:30:00Z / 2026-09-27T22:30:00Z (acceptance criteria), which fall inside the
  // AC-Vorschlag-2/3 fixture's Sep1-Oct31 DEPLOYMENT B/C window on tenantA.employee. A second,
  // dedicated employee keeps the two fixtures from overlapping and interfering with each other.
  let sundayEmployeeId: string;

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "sfd-a");
    tenantB = await seedTestData(app, "sfd-b");

    salonA = await app.prisma.salon.create({
      data: {
        tenantId: tenantA.tenant.id,
        name: "Salon A",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
    salonB = await app.prisma.salon.create({
      data: {
        tenantId: tenantA.tenant.id,
        name: "Salon B",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
    salonC = await app.prisma.salon.create({
      data: {
        tenantId: tenantA.tenant.id,
        name: "Salon C",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
    salonS = await app.prisma.salon.create({
      data: {
        tenantId: tenantA.tenant.id,
        name: "Salon S",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
    salonM = await app.prisma.salon.create({
      data: {
        tenantId: tenantA.tenant.id,
        name: "Salon M",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });

    // tenantA.employee.hireDate = 2024-01-01 (seedTestData). HOME row from hireDate, open-ended.
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        employeeId: tenantA.employee.id,
        salonId: salonA.id,
        kind: "HOME",
        validFrom: new Date("2024-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });

    // DEPLOYMENT B: Thursday+Friday (weekdays 3,4), 2026-09-01..2026-10-31.
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        employeeId: tenantA.employee.id,
        salonId: salonB.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2026-09-01"),
        validUntil: new Date("2026-10-31"),
        weekdays: [3, 4],
      },
    });

    // DEPLOYMENT C: empty weekdays, same window — must never be returned (AC-Vorschlag-3).
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        employeeId: tenantA.employee.id,
        salonId: salonC.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2026-09-01"),
        validUntil: new Date("2026-10-31"),
        weekdays: [],
      },
    });

    // A dedicated second employee for the Sunday-proof (S/M) — kept isolated from tenantA.employee
    // so its fixture window cannot collide with DEPLOYMENT B/C's Sep1-Oct31 window above.
    const sundayUser = await app.prisma.user.create({
      data: {
        email: `sfd-sunday-${Date.now().toString(36)}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const sundayEmployee = await app.prisma.employee.create({
      data: {
        tenantId: tenantA.tenant.id,
        userId: sundayUser.id,
        employeeNumber: `SFD-SUN-${Date.now().toString(36)}`,
        firstName: "Sunday",
        lastName: "Proof",
        hireDate: new Date("2024-01-01"),
      },
    });
    sundayEmployeeId = sundayEmployee.id;

    // DEPLOYMENT S: Sunday only (weekday 6). DEPLOYMENT M: Monday only (weekday 0).
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        employeeId: sundayEmployeeId,
        salonId: salonS.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2026-09-20"),
        validUntil: new Date("2026-10-05"),
        weekdays: [6],
      },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        employeeId: sundayEmployeeId,
        salonId: salonM.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2026-09-20"),
        validUntil: new Date("2026-10-05"),
        weekdays: [0],
      },
    });

    // A voided row (validUntil = validFrom − 1, D-03) — must never be returned by salonForDay.
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        employeeId: tenantA.employee.id,
        salonId: salonC.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2027-01-10"),
        validUntil: new Date("2027-01-09"),
        weekdays: [0, 1, 2, 3, 4, 5, 6],
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    try {
      await cleanupTestData(app, tenantB.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("AC-Vorschlag-2: DEPLOYMENT B wins on Thursday inside its window, HOME A on Monday, HOME A again after B ended", async () => {
    const thursday = await salonForDay(
      app.prisma,
      tenantA.tenant.id,
      tenantA.employee.id,
      new Date("2026-10-01T10:00:00Z"), // Thursday, tenant tz Europe/Berlin — same calendar day
    );
    expect(thursday).toEqual({
      salonId: salonB.id,
      kind: "DEPLOYMENT",
      assignmentId: expect.any(String),
    });

    const monday = await salonForDay(
      app.prisma,
      tenantA.tenant.id,
      tenantA.employee.id,
      new Date("2026-10-05T10:00:00Z"), // Monday
    );
    expect(monday).toEqual({ salonId: salonA.id, kind: "HOME", assignmentId: expect.any(String) });

    const thursdayAfterEnd = await salonForDay(
      app.prisma,
      tenantA.tenant.id,
      tenantA.employee.id,
      new Date("2026-11-05T10:00:00Z"), // Thursday, but after B's validUntil (2026-10-31)
    );
    expect(thursdayAfterEnd).toEqual({
      salonId: salonA.id,
      kind: "HOME",
      assignmentId: expect.any(String),
    });
  });

  it("AC-Vorschlag-3: DEPLOYMENT C (empty weekdays) is never suggested — every day of the 61-day window answers A or B", async () => {
    const start = new Date("2026-09-01T10:00:00Z");
    let checked = 0;
    for (let i = 0; i < 61; i++) {
      const day = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
      const result = await salonForDay(app.prisma, tenantA.tenant.id, tenantA.employee.id, day);
      checked += 1;
      expect(result).not.toBeNull();
      expect([salonA.id, salonB.id]).toContain(result!.salonId);
      expect(result!.salonId).not.toBe(salonC.id);
    }
    expect(checked).toBe(61);
  });

  it("AC-Vorschlag-4 / D-16 (Sunday proof): a Berlin-Sunday instant matches weekday 6, a Berlin-Monday instant matches weekday 0 — verified independently of the tenant-timezone conversion via getUTCDay()", async () => {
    const sundayInstant = new Date("2026-09-26T22:30:00Z");
    const mondayInstant = new Date("2026-09-27T22:30:00Z");
    // Anti-vacuity: if these literals ever drift to the wrong UTC weekday, this fails loudly
    // instead of silently testing the wrong day.
    expect(sundayInstant.getUTCDay()).toBe(6); // Saturday in UTC
    expect(mondayInstant.getUTCDay()).toBe(0); // Sunday in UTC

    const sundayResult = await salonForDay(
      app.prisma,
      tenantA.tenant.id,
      sundayEmployeeId,
      sundayInstant,
    );
    expect(sundayResult).toEqual({
      salonId: salonS.id,
      kind: "DEPLOYMENT",
      assignmentId: expect.any(String),
    });

    const mondayResult = await salonForDay(
      app.prisma,
      tenantA.tenant.id,
      sundayEmployeeId,
      mondayInstant,
    );
    expect(mondayResult).toEqual({
      salonId: salonM.id,
      kind: "DEPLOYMENT",
      assignmentId: expect.any(String),
    });
  });

  it("AC-Vorschlag-1: foreign tenantId yields null; non-null for every day from hireDate through hireDate+400; null before hireDate; a voided row is never returned", async () => {
    const foreign = await salonForDay(
      app.prisma,
      tenantB.tenant.id,
      tenantA.employee.id,
      new Date("2026-10-01T10:00:00Z"),
    );
    expect(foreign).toBeNull();

    const beforeHire = await salonForDay(
      app.prisma,
      tenantA.tenant.id,
      tenantA.employee.id,
      new Date("2023-12-31T10:00:00Z"),
    );
    expect(beforeHire).toBeNull();

    const hireDate = new Date("2024-01-01T10:00:00Z");
    let nonNullCount = 0;
    for (let i = 0; i <= 400; i++) {
      const day = new Date(hireDate.getTime() + i * 24 * 60 * 60 * 1000);
      const result = await salonForDay(app.prisma, tenantA.tenant.id, tenantA.employee.id, day);
      if (result !== null) nonNullCount += 1;
    }
    expect(nonNullCount).toBe(401);

    // The voided row (2027-01-10 validUntil 2027-01-09, weekdays all) covers no day — the answer
    // on 2027-01-10 must still be HOME (A), never the voided row's salon (C).
    const voidedDay = await salonForDay(
      app.prisma,
      tenantA.tenant.id,
      tenantA.employee.id,
      new Date("2027-01-10T10:00:00Z"),
    );
    expect(voidedDay).toEqual({
      salonId: salonA.id,
      kind: "HOME",
      assignmentId: expect.any(String),
    });
  });

  it("review IN-02 / D-16: after the hire date moved LATER, salonForDay answers null for every day before the tenant-local hireDate although the old HOME row still covers it, and HOME from the hire day on", async () => {
    const lateUser = await app.prisma.user.create({
      data: {
        email: `sfd-late-${Date.now().toString(36)}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    // 2025-03-14T23:30:00Z is 2025-03-15 00:30 in Berlin: the tenant-local hire day is the 15th,
    // the UTC day the 14th — so the 14th proves the comparison is tenant-local, not UTC.
    const lateEmployee = await app.prisma.employee.create({
      data: {
        tenantId: tenantA.tenant.id,
        userId: lateUser.id,
        employeeNumber: `SFD-LATE-${Date.now().toString(36)}`,
        firstName: "Late",
        lastName: "Hire",
        hireDate: new Date("2025-03-14T23:30:00Z"),
      },
    });
    // The HOME row from the OLD, earlier hire date — D-07 leaves it in place when hireDate moves
    // later.
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        employeeId: lateEmployee.id,
        salonId: salonA.id,
        kind: "HOME",
        validFrom: new Date("2024-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });

    for (const instant of ["2024-06-01T10:00:00Z", "2025-03-14T12:00:00Z"]) {
      const before = await salonForDay(
        app.prisma,
        tenantA.tenant.id,
        lateEmployee.id,
        new Date(instant),
      );
      expect(before, `${instant} lies before the tenant-local hire day`).toBeNull();
    }

    const hireDay = await salonForDay(
      app.prisma,
      tenantA.tenant.id,
      lateEmployee.id,
      new Date("2025-03-15T08:00:00Z"),
    );
    expect(hireDay).toEqual({ salonId: salonA.id, kind: "HOME", assignmentId: expect.any(String) });
  });

  it("D-17: listSalonAssignments returns ALL rows including ended and voided, HOME first then by validFrom", async () => {
    const rows = await listSalonAssignments(app.prisma, tenantA.tenant.id, tenantA.employee.id);
    // HOME (1) + DEPLOYMENT B + DEPLOYMENT C + voided DEPLOYMENT = 4 rows total (S/M live on the
    // dedicated sundayEmployee, not this employee).
    expect(rows).toHaveLength(4);
    expect(rows[0].kind).toBe("HOME");
    const deployments = rows.slice(1);
    expect(deployments.every((r) => r.kind === "DEPLOYMENT")).toBe(true);
    // Ascending by validFrom among the DEPLOYMENT rows.
    for (let i = 1; i < deployments.length; i++) {
      expect(deployments[i].validFrom.getTime()).toBeGreaterThanOrEqual(
        deployments[i - 1].validFrom.getTime(),
      );
    }
    // The voided row IS present (D-03: voided ≠ deleted).
    const voidedRow = rows.find(
      (r) => r.validUntil !== null && r.validUntil.getTime() < r.validFrom.getTime(),
    );
    expect(voidedRow).toBeDefined();
  });

  describe("GET /:id/salon-assignments role check", () => {
    let managerToken: string;

    beforeAll(async () => {
      const s = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const passwordHash = await bcrypt.hash("test1234", 10);
      const mgrUser = await app.prisma.user.create({
        data: {
          email: `mgr-sfd-${s}@test.de`,
          passwordHash,
          role: "MANAGER",
          isActive: true,
        },
      });
      await app.prisma.employee.create({
        data: {
          tenantId: tenantA.tenant.id,
          userId: mgrUser.id,
          employeeNumber: `MG-SFD-${s}`,
          firstName: "Manager",
          lastName: "SalonForDay",
          hireDate: new Date("2024-01-01"),
        },
      });
      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: mgrUser.email, password: "test1234" },
      });
      managerToken = JSON.parse(loginRes.body).accessToken;
    });

    it("MANAGER gets 200", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${tenantA.employee.id}/salon-assignments`,
        headers: { authorization: `Bearer ${managerToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it("EMPLOYEE gets 403", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${tenantA.employee.id}/salon-assignments`,
        headers: { authorization: `Bearer ${tenantA.empToken}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
