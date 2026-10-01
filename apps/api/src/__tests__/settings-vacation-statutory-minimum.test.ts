/**
 * Issue #435 (D-10/D-14) — PUT /api/v1/settings/vacation/:employeeId rejects a totalDays write
 * below the statutory minimum (§ 19 JArbSchG for minors, § 3 BUrlG otherwise), and GET returns
 * the server's regularDays/statutoryMinimumDays suggestion values on every branch.
 *
 * Fixed dates only (2024/2027/2028) — no assertion in the PUT/legacy-row/hire-year cases depends
 * on `new Date()`. Initials-only fixtures (firstName "T", lastName "T") — no PII per CLAUDE.md.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("PUT/GET /api/v1/settings/vacation/:employeeId — statutory minimum (Issue #435, D-10/D-14)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;

  type EmployeeOverrides = {
    hireDate?: Date;
    exitDate?: Date | null;
    birthDate?: Date | null;
  };

  // Mirrors regular-vacation-entitlement.test.ts's mkEmployee: a FIXED Mo-Fr (5-day) employee,
  // created directly via Prisma so hireDate/birthDate/exitDate are exact fixture dates.
  async function mkEmployee(label: string, overrides: EmployeeOverrides = {}): Promise<string> {
    const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `svsm-${label}-${uid}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `SVSM-${label}-${uid}`,
        firstName: "T",
        lastName: "T",
        hireDate: overrides.hireDate ?? new Date(Date.UTC(2024, 0, 1)),
        exitDate: overrides.exitDate ?? null,
        birthDate: overrides.birthDate ?? null,
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
    await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    return employee.id;
  }

  const putVacation = async (employeeId: string, body: Record<string, unknown>) =>
    app.inject({
      method: "PUT",
      url: `/api/v1/settings/vacation/${employeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: body,
    });

  const getVacation = async (employeeId: string, year: number, token = data.adminToken) =>
    app.inject({
      method: "GET",
      url: `/api/v1/settings/vacation/${employeeId}?year=${year}`,
      headers: { authorization: `Bearer ${token}` },
    });

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "svsm");
    foreign = await seedTestData(app, "svsmf");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (svsm):", err);
    }
    try {
      await cleanupTestData(app, foreign.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (svsmf):", err);
    }
    await closeTestApp();
  });

  describe("PUT — adult, 5-day week, hired 2024 (no hire-year pro-rata for 2027)", () => {
    it("totalDays 19 -> 400 '§ 3 BUrlG' '20 Tagen'; no row and no audit row created", async () => {
      const employeeId = await mkEmployee("adult19");

      const res = await putVacation(employeeId, { year: 2027, totalDays: 19 });
      expect(res.statusCode, `must be rejected: ${res.body}`).toBe(400);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toContain("§ 3 BUrlG");
      expect(body.error).toContain("20 Tagen");

      const row = await app.prisma.leaveEntitlement.findFirst({
        where: { employeeId, year: 2027 },
      });
      expect(row).toBeNull();
      const audit = await app.prisma.auditLog.findFirst({
        where: { entity: "LeaveEntitlement", entityId: employeeId },
      });
      expect(audit).toBeNull();
    });

    it("totalDays 20 -> 200", async () => {
      const employeeId = await mkEmployee("adult20");
      const res = await putVacation(employeeId, { year: 2027, totalDays: 20 });
      expect(res.statusCode, `must succeed: ${res.body}`).toBe(200);
      expect(Number(JSON.parse(res.body).totalDays)).toBe(20);
    });
  });

  describe("PUT — minor born 2012-06-15 (age 14 at 1 Jan 2027, < 16 band, 30 Werktage -> 25)", () => {
    it("totalDays 24 -> 400 '§ 19 JArbSchG' '25 Tagen'", async () => {
      const employeeId = await mkEmployee("minor14", {
        birthDate: new Date(Date.UTC(2012, 5, 15)),
      });
      const res = await putVacation(employeeId, { year: 2027, totalDays: 24 });
      expect(res.statusCode, `must be rejected: ${res.body}`).toBe(400);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toContain("§ 19 JArbSchG");
      expect(body.error).toContain("25 Tagen");
    });

    it("totalDays 25 -> 200", async () => {
      const employeeId = await mkEmployee("minor14-ok", {
        birthDate: new Date(Date.UTC(2012, 5, 15)),
      });
      const res = await putVacation(employeeId, { year: 2027, totalDays: 25 });
      expect(res.statusCode, `must succeed: ${res.body}`).toBe(200);
    });
  });

  describe("PUT — 17-band minor born 2009-06-15 (age 17 at 1 Jan 2027, 25 Werktage -> 20.83)", () => {
    it("totalDays 20.82 -> 400 '20,83'", async () => {
      const employeeId = await mkEmployee("minor17", {
        birthDate: new Date(Date.UTC(2009, 5, 15)),
      });
      const res = await putVacation(employeeId, { year: 2027, totalDays: 20.82 });
      expect(res.statusCode, `must be rejected: ${res.body}`).toBe(400);
      expect(JSON.parse(res.body).error).toContain("20,83");
    });

    it("totalDays 20.83 -> 200", async () => {
      const employeeId = await mkEmployee("minor17-ok", {
        birthDate: new Date(Date.UTC(2009, 5, 15)),
      });
      const res = await putVacation(employeeId, { year: 2027, totalDays: 20.83 });
      expect(res.statusCode, `must succeed: ${res.body}`).toBe(200);
    });
  });

  describe("PUT — hire-year Wartezeit threshold (owner Ergänzung G9, same gate as the regular entitlement)", () => {
    it("hired 2027-10-01 (after 1 July): threshold 5 — 4.5 -> 400 '5 Tagen'; 5 -> 200", async () => {
      const rejectedId = await mkEmployee("hireoct-bad", {
        hireDate: new Date(Date.UTC(2027, 9, 1)),
      });
      const rejected = await putVacation(rejectedId, { year: 2027, totalDays: 4.5 });
      expect(rejected.statusCode, `must be rejected: ${rejected.body}`).toBe(400);
      expect(JSON.parse(rejected.body).error).toContain("5 Tagen");

      const okId = await mkEmployee("hireoct-ok", { hireDate: new Date(Date.UTC(2027, 9, 1)) });
      const ok = await putVacation(okId, { year: 2027, totalDays: 5 });
      expect(ok.statusCode, `must succeed: ${ok.body}`).toBe(200);
    });

    it("hired 2027-06-01 (on/before 1 July): threshold 20 (no pro-rata) — totalDays 12 -> 400 '20 Tagen'", async () => {
      const employeeId = await mkEmployee("hirejun", { hireDate: new Date(Date.UTC(2027, 5, 1)) });
      const res = await putVacation(employeeId, { year: 2027, totalDays: 12 });
      expect(res.statusCode, `must be rejected: ${res.body}`).toBe(400);
      expect(JSON.parse(res.body).error).toContain("20 Tagen");
    });
  });

  describe("PUT — legacy row below the minimum stays editable when totalDays is unchanged (D-10)", () => {
    it("totalDays 10 (unchanged) + carriedOverDays 2 -> 200; totalDays 11 (changed, still below) -> 400", async () => {
      const employeeId = await mkEmployee("legacy");
      await app.prisma.leaveEntitlement.create({
        data: {
          employeeId,
          leaveTypeId: data.vacationType.id,
          year: 2027,
          totalDays: 10,
          usedDays: 0,
          carriedOverDays: 0,
        },
      });

      const unchanged = await putVacation(employeeId, {
        year: 2027,
        totalDays: 10,
        carriedOverDays: 2,
      });
      expect(
        unchanged.statusCode,
        `unchanged totalDays must stay editable: ${unchanged.body}`,
      ).toBe(200);

      const changed = await putVacation(employeeId, { year: 2027, totalDays: 11 });
      expect(
        changed.statusCode,
        `a changed sub-minimum value must be rejected: ${changed.body}`,
      ).toBe(400);
    });
  });

  describe("PUT — a year before hire has threshold 0", () => {
    it("hired 2028-03-01, PUT year 2027 totalDays 0 -> 200", async () => {
      const employeeId = await mkEmployee("notyethired", {
        hireDate: new Date(Date.UTC(2028, 2, 1)),
      });
      const res = await putVacation(employeeId, { year: 2027, totalDays: 0 });
      expect(res.statusCode, `must succeed: ${res.body}`).toBe(200);
    });
  });

  describe("GET — regularDays/statutoryMinimumDays (D-14)", () => {
    it("adult, hired 2024, tenant default 30, year 2027 -> regularDays 30, statutoryMinimumDays 20", async () => {
      const res = await getVacation(data.employee.id, 2027);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { regularDays: number; statutoryMinimumDays: number };
      expect(body.regularDays).toBe(30);
      expect(body.statutoryMinimumDays).toBe(20);
    });

    it("current year, active employee with no row (heal branch) -> both fields present and numeric", async () => {
      const currentYear = new Date().getFullYear();
      const employeeId = await mkEmployee("healbranch", {
        hireDate: new Date(Date.UTC(currentYear, 0, 1)),
      });
      const res = await getVacation(employeeId, currentYear);
      expect(res.statusCode, `must succeed: ${res.body}`).toBe(200);
      const body = JSON.parse(res.body) as {
        regularDays: unknown;
        statutoryMinimumDays: unknown;
      };
      expect(typeof body.regularDays).toBe("number");
      expect(typeof body.statutoryMinimumDays).toBe("number");
    });

    it("a foreign tenant's employee -> 404 with the identical body (no membership oracle)", async () => {
      const res = await getVacation(foreign.employee.id, 2027, data.adminToken);
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: "Mitarbeiter nicht gefunden" });
    });
  });
});
