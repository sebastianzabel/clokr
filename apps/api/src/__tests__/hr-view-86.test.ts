/**
 * Issue #86 (Phase 86b Plan 06) — acceptance proof on the API for AC-86-1, AC-86-2, AC-86-5 and
 * AC-86-6 with the SHIPPED Personalabteilung template (`SYSTEM_ROLE_IDS.HR`), never an ad-hoc
 * custom role: the point is proving what the bundle that customers receive can do and cannot do.
 *
 *  - AC-1: HR creates and maintains employees tenant-wide, with the Stammsalon chosen at creation,
 *    and cannot hand out a role other than Mitarbeiter.
 *  - AC-2: HR writes contracts only from a month-first, writes the vacation entitlement and the
 *    exit date; every write is audited with HR as the actor.
 *  - AC-5: HR maintains salon assignments, lists inactive salons and cannot write salons.
 *  - AC-6: an employee whose employment ended stays visible; HR cannot delete, anonymise or
 *    deactivate; the route list carries no DELETE route for contracts, vacation entitlement or
 *    salon assignments.
 *
 * The 76b template test (`system-role-template-personalabteilung.test.ts`) already covers the
 * plain PATCH and the plain contract write; this file covers what it does not. Fixtures are
 * synthetic (`@example.invalid`, no person names — CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  auditRowsFor,
  soleAuditRow,
} from "./setup";
import { SYSTEM_ROLE_IDS, type SystemRoleSlot } from "../contexts/platform";
import { MONTH_FIRST_ERROR } from "../contexts/platform/month-first-date";
import { deriveMatrixRoutes } from "./neutrality/route-derivation";
import { pastDateStr, futureDateStr } from "./test-dates";

const PASSWORD = "test1234";

// Mutation-proof lever (plan 86b-06 Task 1): flipping this single constant to "TRAINER" must turn
// the write cases below red — run and restored during execution, never committed flipped.
const TEMPLATE_SLOT: SystemRoleSlot = "HR";

describe("Issue #86 (Phase 86b Plan 06) — Personalabteilung acceptance on the API", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let salonC: { id: string };
  let salonD: { id: string };

  let hr: { user: { id: string; email: string }; employee: { id: string } };
  let y: { user: { id: string; email: string }; employee: { id: string } };
  let hrToken: string;

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createEmployee(label: string) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await app.prisma.user.create({
      data: { email: `${s}@example.invalid`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "HrView86Test",
        hireDate: new Date("2024-01-01"),
      },
    });
    return { user, employee };
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

  function asHr(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: object,
  ) {
    return app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${hrToken}` },
      ...(payload === undefined ? {} : { payload }),
    });
  }

  function nextMonthFirst(): string {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
      .toISOString()
      .slice(0, 10);
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "hr86");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "HR86 Salon A" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "HR86 Salon B" });
    salonC = await createTestSalon(app.prisma, data.tenant.id, {
      name: "HR86 Salon C inaktiv",
      isActive: false,
    });
    salonD = await createTestSalon(app.prisma, data.tenant.id, { name: "HR86 Salon D" });

    // Y: the person HR maintains. Stammsalon A, a contract row (the work-settings read 404s
    // without one), hired in the past.
    y = await createEmployee("hr86-y");
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: y.employee.id,
        salonId: salonA.id,
        kind: "HOME",
        validFrom: new Date("2024-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: y.employee.id,
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

    // HR holds ONLY the shipped HR template, TENANT scope — no Mitarbeiter role beside it.
    hr = await createEmployee("hr86-hr");
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: hr.user.id,
        accessRoleId: SYSTEM_ROLE_IDS[TEMPLATE_SLOT],
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    hrToken = await login(hr.user.email);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("AC-86-1: HR creates and maintains employees tenant-wide", () => {
    it("POST /employees with homeSalonId = B and no role -> 201, Stammsalon B, one CREATE audit row by HR", async () => {
      const email = `${uniqueSuffix("hr86-new")}@example.invalid`;
      const res = await asHr("POST", "/employees", {
        email,
        firstName: "Neu",
        lastName: "HrView86Test",
        employeeNumber: uniqueSuffix("n").toUpperCase().slice(0, 20),
        hireDate: new Date(`${pastDateStr(10)}T00:00:00Z`).toISOString(),
        scheduleType: "FIXED_SCHEDULE",
        weeklyHours: 40,
        homeSalonId: salonB.id,
        // A direct password, so no invitation mail is attempted (the test mailer has no SMTP).
        password: "Zx9!hr86-direct-Pw",
      });
      expect(res.statusCode, res.body).toBe(201);
      const created = JSON.parse(res.body) as { id: string };

      const homes = await app.prisma.employeeSalonAssignment.findMany({
        where: { employeeId: created.id, kind: "HOME", validUntil: null },
      });
      expect(homes).toHaveLength(1);
      expect(homes[0].salonId).toBe(salonB.id);

      const row = await soleAuditRow(app.prisma, {
        where: { entity: "Employee", entityId: created.id, action: "CREATE" },
      });
      expect(row.userId).toBe(hr.user.id);
    });

    it("POST /employees with role MANAGER -> 403 and no employee row is created", async () => {
      const number = uniqueSuffix("m").toUpperCase().slice(0, 20);
      const email = `${uniqueSuffix("hr86-mgr")}@example.invalid`;
      const res = await asHr("POST", "/employees", {
        email,
        firstName: "Manager",
        lastName: "HrView86Test",
        employeeNumber: number,
        hireDate: new Date(`${pastDateStr(10)}T00:00:00Z`).toISOString(),
        scheduleType: "FIXED_SCHEDULE",
        weeklyHours: 40,
        homeSalonId: salonB.id,
        role: "MANAGER",
      });
      expect(res.statusCode).toBe(403);
      expect(
        await app.prisma.employee.count({
          where: { tenantId: data.tenant.id, employeeNumber: number },
        }),
      ).toBe(0);
      expect(await app.prisma.user.count({ where: { email } })).toBe(0);
    });

    it("PATCH /employees/<Y> {employeeNumber} -> 200", async () => {
      const res = await asHr("PATCH", `/employees/${y.employee.id}`, {
        employeeNumber: uniqueSuffix("upd").toUpperCase().slice(0, 20),
      });
      expect(res.statusCode, res.body).toBe(200);
    });
  });

  describe("AC-86-2: contract, vacation entitlement and exit date, audited with HR as actor", () => {
    it("PUT /settings/work/<Y> from the next month-first -> 200, one WorkSchedule CREATE audit row by HR", async () => {
      const res = await asHr("PUT", `/settings/work/${y.employee.id}`, {
        type: "FIXED_SCHEDULE",
        weeklyHours: 38,
        validFrom: nextMonthFirst(),
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body) as { id: string };

      const rows = await auditRowsFor(app, "WorkSchedule", body.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe("CREATE");
      expect(rows[0].userId).toBe(hr.user.id);
    });

    it("PUT /settings/work/<Y> from a mid-month day -> 400 with the month-first text, nothing written", async () => {
      const before = await app.prisma.workSchedule.count({ where: { employeeId: y.employee.id } });
      const res = await asHr("PUT", `/settings/work/${y.employee.id}`, {
        type: "FIXED_SCHEDULE",
        weeklyHours: 36,
        validFrom: `${nextMonthFirst().slice(0, 8)}15`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain(MONTH_FIRST_ERROR);
      expect(await app.prisma.workSchedule.count({ where: { employeeId: y.employee.id } })).toBe(
        before,
      );
    });

    it("PUT /settings/vacation/<Y> -> 200 with its LeaveEntitlement audit row by HR", async () => {
      const year = new Date().getUTCFullYear();
      const res = await asHr("PUT", `/settings/vacation/${y.employee.id}`, {
        year,
        totalDays: 28,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect((JSON.parse(res.body) as { totalDays: number }).totalDays).toBe(28);

      const entitlements = await app.prisma.leaveEntitlement.findMany({
        where: { employeeId: y.employee.id, year },
      });
      expect(entitlements).toHaveLength(1);
      const rows = await auditRowsFor(app, "LeaveEntitlement", entitlements[0].id);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const written = rows.filter((r) => r.userId === hr.user.id);
      expect(written).toHaveLength(1);
      expect(written[0].newValue).toMatchObject({ year, totalDays: 28 });
    });

    it("PATCH /employees/<Y> with a past exitDate -> 200, the audit row carries the exit date", async () => {
      const exitDay = pastDateStr(2);
      const before = (await auditRowsFor(app, "Employee", y.employee.id, "UPDATE")).length;

      const res = await asHr("PATCH", `/employees/${y.employee.id}`, {
        exitDate: new Date(`${exitDay}T00:00:00Z`).toISOString(),
      });
      expect(res.statusCode, res.body).toBe(200);

      const rows = await auditRowsFor(app, "Employee", y.employee.id, "UPDATE");
      expect(rows.length - before).toBe(1);
      const row = rows[rows.length - 1];
      expect(row.userId).toBe(hr.user.id);
      expect((row.newValue as { exitDate: string }).exitDate.slice(0, 10)).toBe(exitDay);
    });
  });

  describe("AC-86-5: salon assignments maintained, salons read-only", () => {
    let deploymentId: string;

    it("GET /employees/<Y>/salon-assignments -> 200 with Y's HOME row", async () => {
      const res = await asHr("GET", `/employees/${y.employee.id}/salon-assignments`);
      expect(res.statusCode, res.body).toBe(200);
      const { assignments } = JSON.parse(res.body) as {
        assignments: { kind: string; salonId: string }[];
      };
      expect(assignments.some((a) => a.kind === "HOME" && a.salonId === salonA.id)).toBe(true);
    });

    it("POST /employees/<Y>/salon-assignments (Einsatzsalon in D) -> 201", async () => {
      const res = await asHr("POST", `/employees/${y.employee.id}/salon-assignments`, {
        salonId: salonD.id,
        validFrom: futureDateStr(10),
      });
      expect(res.statusCode, res.body).toBe(201);
      const body = JSON.parse(res.body) as { id: string; kind: string; salonId: string };
      expect(body.kind).toBe("DEPLOYMENT");
      expect(body.salonId).toBe(salonD.id);
      deploymentId = body.id;
      const rows = await auditRowsFor(app, "EmployeeSalonAssignment", deploymentId, "CREATE");
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(hr.user.id);
    });

    it("POST /employees/<Y>/salon-assignments/home (B from a later day) -> 201", async () => {
      const res = await asHr("POST", `/employees/${y.employee.id}/salon-assignments/home`, {
        salonId: salonB.id,
        validFrom: futureDateStr(20),
      });
      expect(res.statusCode, res.body).toBe(201);
    });

    it("POST /employees/<Y>/salon-assignments/<deployment>/end -> 200", async () => {
      expect(deploymentId).toBeTruthy();
      const res = await asHr(
        "POST",
        `/employees/${y.employee.id}/salon-assignments/${deploymentId}/end`,
        { validUntil: futureDateStr(15) },
      );
      expect(res.statusCode, res.body).toBe(200);
      const rows = await auditRowsFor(app, "EmployeeSalonAssignment", deploymentId);
      expect(rows.some((r) => r.userId === hr.user.id && r.action !== "CREATE")).toBe(true);
    });

    it("GET /salons?includeInactive=true -> 200 and lists the deactivated salon C as inactive", async () => {
      const res = await asHr("GET", "/salons?includeInactive=true");
      expect(res.statusCode, res.body).toBe(200);
      const { salons } = JSON.parse(res.body) as { salons: { id: string; isActive: boolean }[] };
      const c = salons.find((s) => s.id === salonC.id);
      expect(c).toBeDefined();
      expect(c!.isActive).toBe(false);
      expect(salons.find((s) => s.id === salonA.id)!.isActive).toBe(true);
    });

    it("POST /salons and PATCH /salons/<A> -> 403, nothing changes", async () => {
      const before = await app.prisma.salon.count({ where: { tenantId: data.tenant.id } });
      const create = await asHr("POST", "/salons", {
        name: "HR86 Salon neu",
        federalState: "BAYERN",
      });
      expect(create.statusCode).toBe(403);
      const patch = await asHr("PATCH", `/salons/${salonA.id}`, { name: "HR86 umbenannt" });
      expect(patch.statusCode).toBe(403);

      expect(await app.prisma.salon.count({ where: { tenantId: data.tenant.id } })).toBe(before);
      const stored = await app.prisma.salon.findUniqueOrThrow({ where: { id: salonA.id } });
      expect(stored.name).toBe("HR86 Salon A");
    });
  });

  describe("AC-86-6: an ended employment stays visible and cannot be deleted", () => {
    it("GET /employees contains Y after the exit date; GET /employees/<Y> -> 200 with the exit date", async () => {
      const list = await asHr("GET", "/employees");
      expect(list.statusCode, list.body).toBe(200);
      const rows = JSON.parse(list.body) as { id: string; exitDate: string | null }[];
      const row = rows.find((r) => r.id === y.employee.id);
      expect(row).toBeDefined();
      expect(row!.exitDate?.slice(0, 10)).toBe(pastDateStr(2));

      const one = await asHr("GET", `/employees/${y.employee.id}`);
      expect(one.statusCode, one.body).toBe(200);
      expect((JSON.parse(one.body) as { exitDate: string }).exitDate.slice(0, 10)).toBe(
        pastDateStr(2),
      );
    });

    it("delete, hard-delete authorize, hard-delete and deactivate -> 403 each; Y is unchanged", async () => {
      const before = await app.prisma.employee.findUniqueOrThrow({
        where: { id: y.employee.id },
        include: { user: true },
      });

      const attempts: [string, string][] = [
        ["DELETE", `/employees/${y.employee.id}`],
        ["POST", `/employees/${y.employee.id}/hard-delete/authorize`],
        ["DELETE", `/employees/${y.employee.id}/hard-delete`],
        ["PATCH", `/employees/${y.employee.id}/deactivate`],
      ];
      for (const [method, url] of attempts) {
        const res = await asHr(method as "DELETE" | "POST" | "PATCH", url);
        expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(403);
      }

      const after = await app.prisma.employee.findUniqueOrThrow({
        where: { id: y.employee.id },
        include: { user: true },
      });
      expect(after.firstName).toBe(before.firstName);
      expect(after.lastName).toBe(before.lastName);
      expect(after.employeeNumber).toBe(before.employeeNumber);
      expect(after.exitDate?.getTime()).toBe(before.exitDate?.getTime());
      expect(after.user.isActive).toBe(true);
      expect(after.user.passwordHash).toBe(before.user.passwordHash);
    });

    it("the derived route list has no DELETE for contracts, vacation entitlement or salon assignments", () => {
      const routes = deriveMatrixRoutes();
      expect(routes.length).toBeGreaterThan(0);

      // Non-vacuity: the write routes this proof relies on and a DELETE route that does exist.
      expect(routes).toContain("PUT /api/v1/settings/work/:employeeId");
      expect(routes).toContain("PUT /api/v1/settings/vacation/:employeeId");
      expect(routes).toContain("POST /api/v1/employees/:id/salon-assignments");
      expect(routes).toContain("DELETE /api/v1/employees/:id");

      const deletes = routes.filter((r) => r.startsWith("DELETE "));
      expect(deletes.length).toBeGreaterThan(0);
      const offending = deletes.filter((r) => {
        const url = r.split(" ")[1];
        return (
          url.startsWith("/api/v1/settings/work") ||
          url.startsWith("/api/v1/settings/vacation") ||
          url.includes("/salon-assignments")
        );
      });
      expect(offending).toEqual([]);
    });
  });
});
