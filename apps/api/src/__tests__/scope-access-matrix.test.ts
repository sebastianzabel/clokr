/**
 * Phase 91b Plan 10 (Issue #91), D-15 — the issue's own acceptance scenario, tested directly and
 * un-frozen (no RECORD/VERIFY split, nothing to freeze against — this is new behavior since this
 * phase, unlike `permission-neutrality-matrix.test.ts`'s 8 TENANT-scope-only recorded actors,
 * which this file makes ZERO edits to, per D-15's own instruction).
 *
 * Scenario, verbatim from the issue: employee X has Stammsalon A and an active Einsatzsalon
 * (DEPLOYMENT) at B. MA_A holds a SALONS-scope assignment on salon A; MA_B holds one on salon B;
 * MA_AB holds one covering BOTH A and B.
 *
 * Two resource types deliberately diverge here, and this file proves they diverge rather than
 * merely asserting "scoping works":
 * - Person master data (D-12, `employee:read`): Stammsalon-OR-active-deployment. MA_A sees X
 *   (Stammsalon match). MA_B ALSO sees X (active-deployment-at-B match) — the BROADER rule.
 * - TimeEntry (D-09, `time-entry:read`): entry's own salon OR Stammsalon-at-the-entry's-date, no
 *   deployment fallback. A TimeEntry of X recorded AT SALON A is visible to MA_A (salon match) but
 *   NOT to MA_B — MA_B's deployment-based D-12 reach for X's PROFILE does not extend to X's time
 *   entries at a DIFFERENT salon (D-09's narrower rule).
 * MA_AB (scope = {A, B}) sees everything both MA_A and MA_B individually see — D-03's own union
 * acceptance criterion, tested directly rather than only inferred from the underlying functions'
 * own unit tests.
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";

const PASSWORD = "test1234";

describe("Issue #91 (Phase 91b Plan 10) — scope-access-matrix (D-15 acceptance scenario)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createEmployee(label: string) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "MatrixTest",
        hireDate: new Date("2020-01-01"),
      },
    });
    return { user, employee };
  }

  function createHome(employeeId: string, salonId: string, validFrom = "2020-01-01") {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date(validFrom),
        validUntil: null,
        weekdays: [],
      },
    });
  }

  function createDeployment(employeeId: string, salonId: string, validFrom = "2020-06-01") {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind: "DEPLOYMENT",
        validFrom: new Date(validFrom),
        validUntil: null,
        weekdays: [],
      },
    });
  }

  async function createScopedManager(label: string, permissions: string[], salonIds: string[]) {
    const { user } = await createEmployee(label);
    const name = `Matrix ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(permissions),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        accessRoleId: role.id,
        scopeType: "SALONS",
        salonIds,
        employeeIds: [],
      },
    });
    return { user };
  }

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  let employeeX: { user: { id: string; email: string }; employee: { id: string } };
  let mgrA: { user: { email: string } };
  let mgrB: { user: { email: string } };
  let mgrAB: { user: { email: string } };
  let entryAtSalonAId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "scam");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "SCAM Salon A" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "SCAM Salon B" });

    // Employee X: Stammsalon A, active Einsatzsalon (DEPLOYMENT) at B.
    employeeX = await createEmployee("scam-x");
    await createHome(employeeX.employee.id, salonA.id);
    await createDeployment(employeeX.employee.id, salonB.id);

    // A TimeEntry of X recorded AT SALON A (not B) on a date within the deployment window.
    const entry = await app.prisma.timeEntry.create({
      data: {
        employeeId: employeeX.employee.id,
        date: new Date("2026-07-15"),
        startTime: new Date("2026-07-15T08:00:00.000Z"),
        endTime: new Date("2026-07-15T16:00:00.000Z"),
        salonId: salonA.id,
      },
    });
    entryAtSalonAId = entry.id;

    const permissions = ["employee:read:ZUGEWIESEN", "time-entry:read:ZUGEWIESEN"];
    mgrA = await createScopedManager("scam-mgr-a", permissions, [salonA.id]);
    mgrB = await createScopedManager("scam-mgr-b", permissions, [salonB.id]);
    mgrAB = await createScopedManager("scam-mgr-ab", permissions, [salonA.id, salonB.id]);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function seesEmployeeX(email: string): Promise<boolean> {
    const token = await login(email);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${employeeX.employee.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return res.statusCode === 200;
  }

  async function seesEntryAtSalonA(email: string): Promise<boolean> {
    const token = await login(email);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/time-entries?employeeId=${employeeX.employee.id}&from=2026-07-01&to=2026-07-31`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = (JSON.parse(res.body) as Array<{ id: string }>).map((e) => e.id);
    return ids.includes(entryAtSalonAId);
  }

  it("D-12 (person master data): MA_A sees X via Stammsalon", async () => {
    expect(await seesEmployeeX(mgrA.user.email)).toBe(true);
  });

  it("D-12 (person master data): MA_B ALSO sees X, via the active Einsatzsalon at B — the broader deployment-inclusive rule", async () => {
    expect(await seesEmployeeX(mgrB.user.email)).toBe(true);
  });

  it("D-12 (person master data): MA_AB (union of A and B) sees X too", async () => {
    expect(await seesEmployeeX(mgrAB.user.email)).toBe(true);
  });

  it("D-09 (TimeEntry): MA_A sees the entry recorded at salon A", async () => {
    expect(await seesEntryAtSalonA(mgrA.user.email)).toBe(true);
  });

  it("D-09 (TimeEntry): MA_B does NOT see the entry — the divergence this file exists to prove. MA_B sees X's PROFILE (D-12, deployment-inclusive) but not X's time entries recorded at a salon (A) outside MA_B's own scope (B), because D-09 carries no deployment fallback", async () => {
    expect(await seesEntryAtSalonA(mgrB.user.email)).toBe(false);
  });

  it("D-09 (TimeEntry): MA_AB (union of A and B) sees the entry too — D-03's union acceptance criterion", async () => {
    expect(await seesEntryAtSalonA(mgrAB.user.email)).toBe(true);
  });
});
