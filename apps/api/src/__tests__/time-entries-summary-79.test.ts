/**
 * Phase 79 Plan 04 (Issue #79), R3 — `GET /api/v1/time-entries/summary`: presence time, working
 * time and recorded break of ONE employee over a period, summed over the very entry set the
 * Arbeitszeitkonto counts (T1: closed, valid, non-deleted WORK entries).
 *
 * Fake clock 2026-06-15T10:00:00Z — installed BEFORE the app boots so every token's iat/exp and
 * the saldo's "today" agree. No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { DEFAULT_SALON_OPENING_HOURS } from "../contexts/platform/facade/salons";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";

const PASSWORD = "test1234";

describe("Issue #79 (Phase 79 Plan 04) — GET /api/v1/time-entries/summary", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let otherData: Awaited<ReturnType<typeof seedTestData>>;
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
        lastName: "Summary79",
        hireDate: new Date("2025-01-01"),
      },
    });
    return { user, employee };
  }

  function createHome(employeeId: string, salonId: string) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
  }

  /** One closed WORK entry; `end` and `breakMinutes` default to 08:00-16:00 with no break. */
  function createEntry(
    employeeId: string,
    salonId: string,
    date: string,
    opts: {
      start?: string;
      end?: string | null;
      breakMinutes?: number;
      type?: "WORK" | "OVERTIME";
      isInvalid?: boolean;
      deletedAt?: Date;
    } = {},
  ) {
    const end = opts.end === undefined ? "16:00:00Z" : opts.end;
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: new Date(`${date}T00:00:00Z`),
        startTime: new Date(`${date}T${opts.start ?? "08:00:00Z"}`),
        endTime: end === null ? null : new Date(`${date}T${end}`),
        breakMinutes: opts.breakMinutes ?? 0,
        type: opts.type ?? "WORK",
        isInvalid: opts.isInvalid ?? false,
        deletedAt: opts.deletedAt ?? null,
        source: "MANUAL",
      },
    });
  }

  /** A user holding `permissions` scoped to salons/persons (same shape as time-entries-salon-scope). */
  async function createScopedUser(
    label: string,
    permissions: string[],
    scope: { scopeType: "SALONS" | "PERSONS"; salonIds?: string[]; employeeIds?: string[] },
  ) {
    const { user } = await createEmployee(label);
    const name = `Summary ${crypto.randomBytes(3).toString("hex")}`;
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
        scopeType: scope.scopeType,
        salonIds: scope.salonIds ?? [],
        employeeIds: scope.employeeIds ?? [],
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

  function summary(token: string, qs: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/time-entries/summary?${qs}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "tsum79");
    otherData = await seedTestData(app, "tsum79b");
    const mkSalon = (name: string) =>
      app.prisma.salon.create({
        data: {
          tenantId: data.tenant.id,
          name,
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: true,
          federalState: "NIEDERSACHSEN",
        },
      });
    salonA = await mkSalon("TSUM79 Salon A");
    salonB = await mkSalon("TSUM79 Salon B");
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, otherData.tenant.id);
    } catch (err) {
      console.error("time-entries-summary-79 cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("tracer — the caller's own employee", () => {
    it("08:00-16:00 with a 30-minute break: presence 480, working 450, break 30, one entry (R1, R2, R3)", async () => {
      await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          salonId: data.salonId,
          date: new Date("2026-02-02T00:00:00Z"),
          startTime: new Date("2026-02-02T08:00:00Z"),
          endTime: new Date("2026-02-02T16:00:00Z"),
          breakMinutes: 30,
          type: "WORK",
          source: "MANUAL",
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries/summary?employeeId=${data.employee.id}&from=2026-02-01&to=2026-02-28`,
        headers: { authorization: `Bearer ${data.empToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        employeeId: data.employee.id,
        from: "2026-02-01",
        to: "2026-02-28",
        presenceMinutes: 480,
        workingMinutes: 450,
        breakMinutes: 30,
        entryCount: 1,
      });
    });
  });

  describe("the entry set is the saldo's (T1)", () => {
    it("counts only closed, valid, non-deleted WORK entries in range; sums are rounded once; admin sees the same body", async () => {
      const { user, employee } = await createEmployee("t1set");
      const sid = data.salonId;
      // Counted: 2026-02-02 08:00-16:00Z break 30  -> presence 480,     working 450
      await createEntry(employee.id, sid, "2026-02-02", { breakMinutes: 30 });
      // Counted: 2026-02-09 07:58:20-16:31:00Z break 45 -> presence 512m40s = 512.666..., working 467.666...
      await createEntry(employee.id, sid, "2026-02-09", {
        start: "07:58:20Z",
        end: "16:31:00Z",
        breakMinutes: 45,
      });
      // Excluded rows: invalid, open, soft-deleted, non-WORK, outside the range.
      await createEntry(employee.id, sid, "2026-02-03", { isInvalid: true });
      await createEntry(employee.id, sid, "2026-02-04", { end: null });
      await createEntry(employee.id, sid, "2026-02-05", { deletedAt: new Date() });
      await createEntry(employee.id, sid, "2026-02-06", { type: "OVERTIME" });
      await createEntry(employee.id, sid, "2026-03-02");

      // Exact sums: presence 480 + 512.666... = 992.666... -> 993; working 450 + 467.666... =
      // 917.666... -> 918; break 30 + 45 = 75.
      const expected = {
        employeeId: employee.id,
        from: "2026-02-01",
        to: "2026-02-28",
        presenceMinutes: 993,
        workingMinutes: 918,
        breakMinutes: 75,
        entryCount: 2,
      };
      const own = await summary(
        await login(user.email),
        `employeeId=${employee.id}&from=2026-02-01&to=2026-02-28`,
      );
      expect(own.statusCode).toBe(200);
      expect(JSON.parse(own.body)).toEqual(expected);

      const admin = await summary(
        data.adminToken,
        `employeeId=${employee.id}&from=2026-02-01&to=2026-02-28`,
      );
      expect(admin.statusCode).toBe(200);
      expect(JSON.parse(admin.body)).toEqual(expected);
    });
  });

  describe("input validation (D-09)", () => {
    const eid = () => data.employee.id;

    it("rejects a missing employeeId, an impossible calendar date and a non-ISO date with 400 Validierungsfehler", async () => {
      for (const qs of [
        "from=2026-02-01&to=2026-02-28",
        `employeeId=${eid()}&from=2026-02-30&to=2026-03-05`,
        `employeeId=${eid()}&from=02.02.2026&to=2026-02-28`,
      ]) {
        const res = await summary(data.adminToken, qs);
        expect(res.statusCode, qs).toBe(400);
        expect(JSON.parse(res.body).error, qs).toBe("Validierungsfehler");
      }
    });

    it("rejects from > to", async () => {
      const res = await summary(
        data.adminToken,
        `employeeId=${eid()}&from=2026-02-28&to=2026-02-01`,
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: "Startdatum muss vor Enddatum liegen" });
    });

    it("allows at most 366 inclusive days: 367 is rejected, 366 passes (also across a leap year)", async () => {
      const tooLong = await summary(
        data.adminToken,
        `employeeId=${eid()}&from=2026-01-01&to=2027-01-02`,
      );
      expect(tooLong.statusCode).toBe(400);
      expect(JSON.parse(tooLong.body)).toEqual({
        error: "Der Zeitraum darf höchstens 366 Tage umfassen",
      });

      // 2026-01-01..2027-01-01 is 366 inclusive days; 2028-01-01..2028-12-31 is 366 days (leap).
      for (const qs of ["from=2026-01-01&to=2027-01-01", "from=2028-01-01&to=2028-12-31"]) {
        const ok = await summary(data.adminToken, `employeeId=${eid()}&${qs}`);
        expect(ok.statusCode, qs).toBe(200);
      }
    });
  });

  describe("authorization and the tenant oracle (D-08)", () => {
    it("EIGENE reach with a foreign employeeId is 403 Forbidden", async () => {
      const res = await summary(
        data.empToken,
        `employeeId=${data.adminEmployee.id}&from=2026-02-01&to=2026-02-28`,
      );
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
    });

    it("a user without any time-entry reach is 403 Forbidden", async () => {
      const noTimeEntry = await createScopedUser("nope", ["employee:read:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      const res = await summary(
        await login(noTimeEntry.user.email),
        `employeeId=${data.employee.id}&from=2026-02-01&to=2026-02-28`,
      );
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
    });

    it("a foreign tenant's employee and an unknown id answer with byte-identical 404 bodies", async () => {
      const foreign = await summary(
        data.adminToken,
        `employeeId=${otherData.employee.id}&from=2026-02-01&to=2026-02-28`,
      );
      const unknown = await summary(
        data.adminToken,
        `employeeId=${crypto.randomUUID()}&from=2026-02-01&to=2026-02-28`,
      );
      expect(foreign.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(foreign.body).toBe(unknown.body);
      expect(JSON.parse(foreign.body)).toEqual({ error: "Mitarbeiter nicht gefunden" });
    });
  });

  describe("entry-level scope (D-13)", () => {
    it("a scoped manager gets the partial sum over exactly the entries GET /time-entries lists for them", async () => {
      const x = await createEmployee("scopex");
      const y = await createEmployee("scopey");
      await createHome(x.employee.id, salonB.id);
      await createHome(y.employee.id, salonB.id);
      // X: one entry at salon A (08:00-16:00, break 30), one at its HOME salon B (08:00-16:00, no break).
      await createEntry(x.employee.id, salonA.id, "2026-02-02", { breakMinutes: 30 });
      await createEntry(x.employee.id, salonB.id, "2026-02-03");
      // Y: HOME at B, one entry at B only.
      await createEntry(y.employee.id, salonB.id, "2026-02-03");

      const salonsA = await createScopedUser("mgr-salons", ["time-entry:read:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      const tokenA = await login(salonsA.user.email);
      const range = "from=2026-02-01&to=2026-02-28";

      // X for the salon-A manager: only the salon-A entry (480 presence, 30 break -> 450 working).
      const xRes = await summary(tokenA, `employeeId=${x.employee.id}&${range}`);
      expect(xRes.statusCode).toBe(200);
      expect(JSON.parse(xRes.body)).toEqual({
        employeeId: x.employee.id,
        from: "2026-02-01",
        to: "2026-02-28",
        presenceMinutes: 480,
        workingMinutes: 450,
        breakMinutes: 30,
        entryCount: 1,
      });
      // The list shows the same single entry.
      const list = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?employeeId=${x.employee.id}&${range}`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(JSON.parse(list.body)).toHaveLength(1);

      // Y has nothing in scope: 200 with zeros, like the empty list.
      const yRes = await summary(tokenA, `employeeId=${y.employee.id}&${range}`);
      expect(yRes.statusCode).toBe(200);
      expect(JSON.parse(yRes.body)).toEqual({
        employeeId: y.employee.id,
        from: "2026-02-01",
        to: "2026-02-28",
        presenceMinutes: 0,
        workingMinutes: 0,
        breakMinutes: 0,
        entryCount: 0,
      });

      // PERSONS manager on [X]: both of X's entries. Presence 480 + 480 = 960, break 30,
      // working 450 + 480 = 930.
      const persons = await createScopedUser("mgr-persons", ["time-entry:read:ZUGEWIESEN"], {
        scopeType: "PERSONS",
        employeeIds: [x.employee.id],
      });
      const pRes = await summary(
        await login(persons.user.email),
        `employeeId=${x.employee.id}&${range}`,
      );
      expect(pRes.statusCode).toBe(200);
      expect(JSON.parse(pRes.body)).toEqual({
        employeeId: x.employee.id,
        from: "2026-02-01",
        to: "2026-02-28",
        presenceMinutes: 960,
        workingMinutes: 930,
        breakMinutes: 30,
        entryCount: 2,
      });
    });
  });

  describe("parity with the account's Ist (R4)", () => {
    it("summary workingMinutes == month-saldo workedMinutes == the monthly report's workedHours; presence differs by the break", async () => {
      const { employee } = await createEmployee("parity");
      await app.prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
          type: "FIXED_SCHEDULE",
          weeklyHours: 40,
          mondayHours: 8,
          tuesdayHours: 8,
          wednesdayHours: 8,
          thursdayHours: 8,
          fridayHours: 8,
          saturdayHours: 0,
          sundayHours: 0,
          workDays: [1, 2, 3, 4, 5],
          validFrom: new Date("2025-01-01T00:00:00Z"),
        },
      });
      await createHome(employee.id, data.salonId);
      await app.prisma.overtimeAccount.create({
        data: { employeeId: employee.id, balanceHours: 0 },
      });
      // Net 480 + break 30 = 510 min presence on the 4th and 5th, net 495 + 30 = 525 on the 6th.
      await createEntry(employee.id, data.salonId, "2026-05-04", {
        end: "16:30:00Z",
        breakMinutes: 30,
      });
      await createEntry(employee.id, data.salonId, "2026-05-05", {
        end: "16:30:00Z",
        breakMinutes: 30,
      });
      await createEntry(employee.id, data.salonId, "2026-05-06", {
        end: "16:45:00Z",
        breakMinutes: 30,
      });

      const res = await summary(
        data.adminToken,
        `employeeId=${employee.id}&from=2026-05-01&to=2026-05-31`,
      );
      expect(res.statusCode).toBe(200);
      const sum = JSON.parse(res.body) as {
        presenceMinutes: number;
        workingMinutes: number;
        breakMinutes: number;
      };

      const saldoRes = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/month-saldo/${employee.id}?year=2026&month=5`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(saldoRes.statusCode).toBe(200);
      const saldo = JSON.parse(saldoRes.body) as { workedMinutes: number };

      const reportRes = await app.inject({
        method: "GET",
        url: `/api/v1/reports/monthly?employeeId=${employee.id}&year=2026&month=5`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(reportRes.statusCode).toBe(200);
      const row = (
        JSON.parse(reportRes.body) as { rows: Array<{ employeeId: string; workedHours: number }> }
      ).rows.find((r) => r.employeeId === employee.id);
      expect(row).toBeDefined();

      // 480 + 480 + 495 = 1455 working minutes; presence 510 + 510 + 525 = 1545; break 90.
      expect(sum.workingMinutes).toBe(1455);
      expect(saldo.workedMinutes).toBe(1455);
      expect(row!.workedHours).toBe(Math.round((sum.workingMinutes / 60) * 100) / 100);
      expect(sum.presenceMinutes - sum.workingMinutes).toBe(sum.breakMinutes);
      expect(sum.breakMinutes).toBe(90);
      expect(sum.presenceMinutes).not.toBe(sum.workingMinutes);
    });

    // Documented difference (review WR-01): the summary sums the T1 entry set over the requested
    // period as-is, while the account additionally clamps to the employment span (and, for an
    // Azubi, adds the Berufsschule credit). This case pins the clamp so the two numbers cannot
    // silently be assumed equal for an employee with an entry before the hire date.
    it("an entry before the hire date counts in the summary but not in the month saldo", async () => {
      const { employee } = await createEmployee("clamp");
      await app.prisma.employee.update({
        where: { id: employee.id },
        data: { hireDate: new Date("2026-05-05T00:00:00Z") },
      });
      await app.prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
          type: "FIXED_SCHEDULE",
          weeklyHours: 40,
          mondayHours: 8,
          tuesdayHours: 8,
          wednesdayHours: 8,
          thursdayHours: 8,
          fridayHours: 8,
          saturdayHours: 0,
          sundayHours: 0,
          workDays: [1, 2, 3, 4, 5],
          validFrom: new Date("2026-05-05T00:00:00Z"),
        },
      });
      await createHome(employee.id, data.salonId);
      await app.prisma.overtimeAccount.create({
        data: { employeeId: employee.id, balanceHours: 0 },
      });
      // 2026-05-04 lies one day before the hire date; the 5th and 6th are inside the span.
      await createEntry(employee.id, data.salonId, "2026-05-04");
      await createEntry(employee.id, data.salonId, "2026-05-05");
      await createEntry(employee.id, data.salonId, "2026-05-06");

      const res = await summary(
        data.adminToken,
        `employeeId=${employee.id}&from=2026-05-01&to=2026-05-31`,
      );
      expect(res.statusCode).toBe(200);
      const sum = JSON.parse(res.body) as { workingMinutes: number; entryCount: number };

      const saldoRes = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/month-saldo/${employee.id}?year=2026&month=5`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(saldoRes.statusCode).toBe(200);
      const saldo = JSON.parse(saldoRes.body) as { workedMinutes: number };

      // Summary: all three entries (3 x 480). Account: only the two inside the employment span.
      expect(sum.entryCount).toBe(3);
      expect(sum.workingMinutes).toBe(1440);
      expect(saldo.workedMinutes).toBe(960);
    });
  });
});
