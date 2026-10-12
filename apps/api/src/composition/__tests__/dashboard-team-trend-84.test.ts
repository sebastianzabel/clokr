/**
 * Issue #84 (AC-1, AC-3; D-07, D-12, D-17) — `GET /api/v1/dashboard/team-trend`.
 *
 * The endpoint replaces the browser's six `/reports/monthly` calls with ONE server answer. This
 * file proves, against the LIVE `/reports/monthly`, that the unfiltered numbers are identical to
 * what the report would have summed: the report is the one source of Ist/Soll (Issue #451, the
 * working-time account's `computeMonthReportFigures`) and of the sick-day arithmetic (the absence
 * context's `sickLeaveDayCounts`), so a team-trend month that differs from the sum of the report
 * rows is a divergence between two readers of one rule.
 *
 * Fixture minutes are multiples of 3 on purpose: the report prints hours rounded to two decimals,
 * and a multiple of 3 minutes converts back to whole minutes exactly, so the comparison needs no
 * tolerance. No person names in fixtures.
 *
 * Harness: fake clock 2026-06-15T10:00Z installed BEFORE the app boots, so the window is
 * 2026-01 ... 2026-06 and June is the open month.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
} from "./../../__tests__/setup";
import { saldoSnapshotPeriodBounds } from "../../__tests__/test-dates";
import { leaveTypeFields } from "../../contexts/absence/leave-type";
import { normalizeRolePermissions, roleNameKey, SYSTEM_ROLE_IDS } from "../../contexts/platform";

const PASSWORD = "test1234";
const MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"] as const;

type TrendMonth = {
  month: string;
  workedMinutes: number;
  shouldMinutes: number | null;
  sickDays: number;
};
type Trend = {
  salonId: string | null;
  workedBasis: string;
  sollUnavailableReason: string | null;
  months: TrendMonth[];
};
type ReportRow = { workedHours: number; shouldHours: number; sickDays: number };

function uniqueSuffix(label: string): string {
  return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

describe("Issue #84 — dashboard team-trend", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
    app = await getTestApp();
  });

  afterAll(async () => {
    vi.useRealTimers();
    await closeTestApp();
  });

  async function createPerson(
    tenantId: string,
    label: string,
    opts: {
      schedule?: "FIXED" | "MONTHLY_NO_BUDGET" | "NONE";
      exempt?: boolean;
      hireDate?: string;
    } = {},
  ) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "Trend84",
        hireDate: new Date(`${opts.hireDate ?? "2024-01-01"}T00:00:00Z`),
        isTimeTrackingExempt: opts.exempt ?? false,
      },
    });
    const schedule = opts.schedule ?? "FIXED";
    if (schedule === "FIXED") {
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
          validFrom: new Date("2024-01-01T00:00:00Z"),
        },
      });
    } else if (schedule === "MONTHLY_NO_BUDGET") {
      await app.prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
          type: "MONTHLY_HOURS",
          workDays: [1, 2, 3, 4, 5],
          overtimeMode: "CARRY_FORWARD",
          validFrom: new Date("2024-01-01T00:00:00Z"),
        },
      });
    }
    return { user, employee };
  }

  function home(tenantId: string, employeeId: string, salonId: string, from = "2024-01-01") {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date(`${from}T00:00:00Z`),
        validUntil: null,
      },
    });
  }

  function entry(
    employeeId: string,
    salonId: string,
    date: string,
    start: string,
    end: string,
    breakMinutes = 0,
  ) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: new Date(`${date}T00:00:00Z`),
        startTime: new Date(`${date}T${start}:00Z`),
        endTime: new Date(`${date}T${end}:00Z`),
        breakMinutes,
        type: "WORK",
        source: "MANUAL",
      },
    });
  }

  function leave(
    employeeId: string,
    leaveTypeId: string,
    start: string,
    end: string,
    extra: Record<string, unknown> = {},
  ) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId,
        startDate: new Date(`${start}T00:00:00Z`),
        endDate: new Date(`${end}T00:00:00Z`),
        days: 1,
        status: "APPROVED",
        ...extra,
      } as never,
    });
  }

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  function get(token: string | null, url: string) {
    return app.inject({
      method: "GET",
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  }

  async function trend(token: string, query = ""): Promise<Trend> {
    const res = await get(token, `/api/v1/dashboard/team-trend${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Trend;
  }

  /** What the browser used to compute: Σ rows of GET /reports/monthly for the same caller. */
  async function reportSums(token: string, month: string) {
    const [y, m] = month.split("-").map(Number);
    const res = await get(token, `/api/v1/reports/monthly?year=${y}&month=${m}`);
    expect(res.statusCode, res.body).toBe(200);
    const rows = (JSON.parse(res.body) as { rows: ReportRow[] }).rows;
    return {
      workedMinutes: Math.round(rows.reduce((s, r) => s + r.workedHours * 60, 0)),
      shouldMinutes: Math.round(rows.reduce((s, r) => s + r.shouldHours * 60, 0)),
      sickDays: rows.reduce((s, r) => s + r.sickDays, 0),
    };
  }

  async function customRole(tenantId: string, permissions: string[]) {
    const name = `Trend84 ${crypto.randomBytes(3).toString("hex")}`;
    return app.prisma.accessRole.create({
      data: {
        tenantId,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(permissions),
      },
    });
  }

  function assign(
    tenantId: string,
    userId: string,
    accessRoleId: string,
    scope: { scopeType: "TENANT" | "SALONS"; salonIds?: string[] },
  ) {
    return app.prisma.roleAssignment.create({
      data: {
        tenantId,
        userId,
        accessRoleId,
        scopeType: scope.scopeType,
        salonIds: scope.salonIds ?? [],
        employeeIds: [],
      },
    });
  }

  // ── Task 1 — unfiltered, equal to the monthly report ──────────────────────────────────────

  describe("unfiltered series equals the monthly report (AC-1, AC-3, D-07, D-17)", () => {
    let data: Awaited<ReturnType<typeof seedTestData>>;
    let salonA: { id: string };
    let salonB: { id: string };
    let scopedAllToken: string;
    let overviewOnlyToken: string;
    let partialCoverageToken: string;
    let salonManagerToken: string;

    beforeAll(async () => {
      data = await seedTestData(app, "tt84a");
      salonA = { id: data.salonId };
      salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "Trend84 B" });
      const sick = await app.prisma.leaveType.create({
        data: { tenantId: data.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
      });

      // pFixed: fixed contract, Stammsalon A, worked in BOTH salons in June (counts once), a
      // closed March whose snapshot differs from the entries, three kinds of sick leave.
      const pFixed = await createPerson(data.tenant.id, "fixed");
      await home(data.tenant.id, pFixed.employee.id, salonA.id);
      await entry(pFixed.employee.id, salonA.id, "2026-06-08", "08:00", "16:00"); // 480
      await entry(pFixed.employee.id, salonB.id, "2026-06-09", "08:00", "12:00"); // 240
      await entry(pFixed.employee.id, salonA.id, "2026-05-12", "08:00", "17:00", 30); // 510
      await entry(pFixed.employee.id, salonA.id, "2026-03-10", "08:00", "12:00"); // 240 (snapshot differs)
      await entry(pFixed.employee.id, salonA.id, "2026-02-10", "08:00", "15:00"); // 420
      const march = saldoSnapshotPeriodBounds(new Date("2026-03-15T00:00:00.000Z"));
      await app.prisma.saldoSnapshot.create({
        data: {
          employeeId: pFixed.employee.id,
          periodType: "MONTHLY",
          periodStart: march.start,
          periodEnd: march.end,
          workedMinutes: 9660,
          expectedMinutes: 9600,
          balanceMinutes: 60,
          carryOver: 60,
          closedAt: new Date("2026-04-02T08:00:00Z"),
          closedBy: "test-system",
          superseded: false,
        },
      });
      await leave(pFixed.employee.id, sick.id, "2026-05-05", "2026-05-05", { halfDay: true });
      await leave(pFixed.employee.id, sick.id, "2026-04-29", "2026-05-02"); // cross-month
      await leave(pFixed.employee.id, sick.id, "2026-02-06", "2026-02-08"); // Fri-Sun

      // pUntracked: MONTHLY_HOURS without a budget — Ist only, no Soll. Stammsalon B.
      const pUntracked = await createPerson(data.tenant.id, "untracked", {
        schedule: "MONTHLY_NO_BUDGET",
      });
      await home(data.tenant.id, pUntracked.employee.id, salonB.id);
      await entry(pUntracked.employee.id, salonB.id, "2026-06-10", "08:00", "12:00"); // 240
      await entry(pUntracked.employee.id, salonB.id, "2026-05-06", "08:00", "11:00"); // 180

      // pExempt: no time tracking — sick days still count, Ist is 0.
      const pExempt = await createPerson(data.tenant.id, "exempt", {
        schedule: "NONE",
        exempt: true,
      });
      await home(data.tenant.id, pExempt.employee.id, salonA.id);
      await leave(pExempt.employee.id, sick.id, "2026-06-01", "2026-06-02");

      // Callers. Each manager is an employee of its own with no Stammsalon (not in anyone's reach).
      const scopedAll = await createPerson(data.tenant.id, "scoped-all", { schedule: "NONE" });
      const roleAll = await customRole(data.tenant.id, [
        "team-overview:read:ZUGEWIESEN",
        "report:read:ZUGEWIESEN",
        "overtime:read:ZUGEWIESEN",
      ]);
      await assign(data.tenant.id, scopedAll.user.id, roleAll.id, {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      scopedAllToken = await login(scopedAll.user.email);

      const overviewOnly = await createPerson(data.tenant.id, "overview-only", {
        schedule: "NONE",
      });
      const roleOverview = await customRole(data.tenant.id, ["team-overview:read:ZUGEWIESEN"]);
      await assign(data.tenant.id, overviewOnly.user.id, roleOverview.id, {
        scopeType: "TENANT",
      });
      overviewOnlyToken = await login(overviewOnly.user.email);

      const partial = await createPerson(data.tenant.id, "partial", { schedule: "NONE" });
      await assign(data.tenant.id, partial.user.id, roleOverview.id, { scopeType: "TENANT" });
      const roleOvertime = await customRole(data.tenant.id, ["overtime:read:ZUGEWIESEN"]);
      await assign(data.tenant.id, partial.user.id, roleOvertime.id, {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      partialCoverageToken = await login(partial.user.email);

      const manager = await createPerson(data.tenant.id, "salon-manager", { schedule: "NONE" });
      await assign(data.tenant.id, manager.user.id, SYSTEM_ROLE_IDS.SALON_MANAGER, {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      salonManagerToken = await login(manager.user.email);
    });

    afterAll(async () => {
      try {
        await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data.tenant.id } });
        await app.prisma.accessRole.deleteMany({ where: { tenantId: data.tenant.id } });
        await cleanupTestData(app, data.tenant.id);
      } catch (err) {
        console.error("dashboard-team-trend-84 cleanup failed:", err);
      }
    });

    it("whole-tenant admin: every month equals the sum of the /reports/monthly rows", async () => {
      const body = await trend(data.adminToken);
      expect(body.salonId).toBeNull();
      expect(body.workedBasis).toBe("ACCOUNT");
      expect(body.sollUnavailableReason).toBeNull();
      expect(body.months.map((m) => m.month)).toEqual([...MONTHS]);
      for (const m of body.months) {
        const report = await reportSums(data.adminToken, m.month);
        expect(m.workedMinutes, `${m.month} worked`).toBe(report.workedMinutes);
        expect(m.shouldMinutes, `${m.month} should`).toBe(report.shouldMinutes);
        expect(m.sickDays, `${m.month} sick`).toBe(report.sickDays);
      }
      // Non-vacuous: the closed March is the snapshot value, not the 240 minutes of entries.
      expect(body.months[2].workedMinutes).toBeGreaterThanOrEqual(9660);
      expect(body.months.some((m) => m.sickDays > 0)).toBe(true);
      expect(body.months.some((m) => (m.shouldMinutes ?? 0) > 0)).toBe(true);
    });

    it("a person who worked in two salons contributes once (June, SALONS [A] caller)", async () => {
      const body = await trend(scopedAllToken);
      const report = await reportSums(scopedAllToken, "2026-06");
      const june = body.months[5];
      expect(june.workedMinutes).toBe(report.workedMinutes);
      // pFixed: 480 in A + 240 in B, exactly once. pExempt adds 0.
      expect(june.workedMinutes).toBe(720);
    });

    it("SALONS [A] caller with report and overtime reach: equal to the report that same user receives", async () => {
      const body = await trend(scopedAllToken);
      expect(body.sollUnavailableReason).toBeNull();
      for (const m of body.months) {
        const report = await reportSums(scopedAllToken, m.month);
        expect(m.workedMinutes, `${m.month} worked`).toBe(report.workedMinutes);
        expect(m.shouldMinutes, `${m.month} should`).toBe(report.shouldMinutes);
        expect(m.sickDays, `${m.month} sick`).toBe(report.sickDays);
      }
      // Closed March: the snapshot, verbatim.
      expect(body.months[2].workedMinutes).toBe(9660);
      expect(body.months[2].shouldMinutes).toBe(9600);
      // Sick days of the A population: Feb 3 (Fri-Sun), Apr 2 (29.-30.), May 2 + half day, Jun 2.
      expect(body.months.map((m) => m.sickDays)).toEqual([0, 3, 0, 2, 2.5, 2]);
    });

    it("team-overview only (tenant scope): Ist and sick days as the admin, no Soll", async () => {
      const admin = await trend(data.adminToken);
      const body = await trend(overviewOnlyToken);
      expect(body.sollUnavailableReason).toBe("NO_PERMISSION");
      for (let i = 0; i < MONTHS.length; i++) {
        expect(body.months[i].shouldMinutes).toBeNull();
        expect(body.months[i].workedMinutes).toBe(admin.months[i].workedMinutes);
        expect(body.months[i].sickDays).toBe(admin.months[i].sickDays);
      }
    });

    it("overtime reach that does not cover every shown person: Soll is null (D-17)", async () => {
      const admin = await trend(data.adminToken);
      const body = await trend(partialCoverageToken);
      expect(body.sollUnavailableReason).toBe("NO_PERMISSION");
      for (let i = 0; i < MONTHS.length; i++) {
        expect(body.months[i].shouldMinutes).toBeNull();
        expect(body.months[i].workedMinutes).toBe(admin.months[i].workedMinutes);
        expect(body.months[i].sickDays).toBe(admin.months[i].sickDays);
      }
    });

    it("Salonmanager of A: Ist and sick over A's Stammsalon population, Soll null", async () => {
      const full = await trend(scopedAllToken);
      const body = await trend(salonManagerToken);
      expect(body.sollUnavailableReason).toBe("NO_PERMISSION");
      for (let i = 0; i < MONTHS.length; i++) {
        expect(body.months[i].shouldMinutes).toBeNull();
        expect(body.months[i].workedMinutes).toBe(full.months[i].workedMinutes);
        expect(body.months[i].sickDays).toBe(full.months[i].sickDays);
      }
    });

    it("rejects a plain employee (403), an anonymous call (401) and a bad months value (400)", async () => {
      expect((await get(data.empToken, "/api/v1/dashboard/team-trend")).statusCode).toBe(403);
      expect((await get(null, "/api/v1/dashboard/team-trend")).statusCode).toBe(401);
      for (const bad of ["0", "13", "abc"]) {
        const res = await get(data.adminToken, `/api/v1/dashboard/team-trend?months=${bad}`);
        expect(res.statusCode, `months=${bad}`).toBe(400);
      }
    });

    it("months defaults to 6 and a smaller window ends with the same current month", async () => {
      const six = await trend(data.adminToken);
      expect(six.months).toHaveLength(6);
      const three = await trend(data.adminToken, "?months=3");
      expect(three.months.map((m) => m.month)).toEqual(["2026-04", "2026-05", "2026-06"]);
      expect(three.months).toEqual(six.months.slice(3));
    });
  });

  // ── Task 3 — with salonId ─────────────────────────────────────────────────────────────────

  describe("with salonId: time by entry salon, sick days by Stammsalon per day, no per-salon Soll (D-02..D-05, D-12, D-13, D-16)", () => {
    const NOT_FOUND_BODY = JSON.stringify({ error: "Salon nicht gefunden" });
    let data: Awaited<ReturnType<typeof seedTestData>>;
    let foreign: Awaited<ReturnType<typeof seedTestData>>;
    let salonA: { id: string };
    let salonB: { id: string };
    let salonGone: { id: string };
    let overviewOnlyToken: string;
    let salonManagerToken: string;

    beforeAll(async () => {
      data = await seedTestData(app, "tt84b");
      foreign = await seedTestData(app, "tt84c");
      salonA = { id: data.salonId };
      salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "Trend84 B2" });
      salonGone = await createTestSalon(app.prisma, data.tenant.id, { name: "Trend84 C2" });
      await app.prisma.salon.update({ where: { id: salonGone.id }, data: { isActive: false } });
      const sick = await app.prisma.leaveType.create({
        data: { tenantId: data.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
      });

      // P: Stammsalon A, 360 min in A and 180 min in B in June; sick 11.-13.05. (3 days, A).
      const p = await createPerson(data.tenant.id, "p");
      await home(data.tenant.id, p.employee.id, salonA.id);
      await entry(p.employee.id, salonA.id, "2026-06-08", "08:00", "14:00");
      await entry(p.employee.id, salonB.id, "2026-06-09", "08:00", "11:00");
      await leave(p.employee.id, sick.id, "2026-05-11", "2026-05-13");

      // Q: Stammsalon B, 240 min in B; sick 18.-19.05. (2 days, B).
      const q = await createPerson(data.tenant.id, "q");
      await home(data.tenant.id, q.employee.id, salonB.id);
      await entry(q.employee.id, salonB.id, "2026-06-10", "08:00", "12:00");
      await leave(q.employee.id, sick.id, "2026-05-18", "2026-05-19");

      // R: Stammsalon A until 10.04., B from 11.04.; sick 08.-12.04. splits 3 / 2.
      const r = await createPerson(data.tenant.id, "r");
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId: data.tenant.id,
          employeeId: r.employee.id,
          salonId: salonA.id,
          kind: "HOME",
          validFrom: new Date("2024-01-01T00:00:00Z"),
          validUntil: new Date("2026-04-10T00:00:00Z"),
        },
      });
      await home(data.tenant.id, r.employee.id, salonB.id, "2026-04-11");
      await leave(r.employee.id, sick.id, "2026-04-08", "2026-04-12");

      // S: entries that must never count in June: closed today (the live saldo never includes
      // today, #438), an invalid one and an open one.
      const sPerson = await createPerson(data.tenant.id, "s");
      await home(data.tenant.id, sPerson.employee.id, salonA.id);
      await entry(sPerson.employee.id, salonA.id, "2026-06-15", "08:00", "09:00");
      await app.prisma.timeEntry.create({
        data: {
          employeeId: sPerson.employee.id,
          salonId: salonA.id,
          date: new Date("2026-06-11T00:00:00Z"),
          startTime: new Date("2026-06-11T08:00:00Z"),
          endTime: new Date("2026-06-11T10:00:00Z"),
          breakMinutes: 0,
          type: "WORK",
          source: "MANUAL",
          isInvalid: true,
        },
      });
      await app.prisma.timeEntry.create({
        data: {
          employeeId: sPerson.employee.id,
          salonId: salonA.id,
          date: new Date("2026-06-12T00:00:00Z"),
          startTime: new Date("2026-06-12T08:00:00Z"),
          endTime: null,
          breakMinutes: 0,
          type: "WORK",
          source: "MANUAL",
        },
      });

      // Azubi with a Berufsschule day on 20.05. and 480 min in A on 19.05.: the Berufsschule
      // credit is no salon time.
      const azubi = await createPerson(data.tenant.id, "azubi");
      await app.prisma.employee.update({
        where: { id: azubi.employee.id },
        data: { classification: "AZUBI", birthDate: new Date("2010-06-01") },
      });
      await home(data.tenant.id, azubi.employee.id, salonA.id);
      await entry(azubi.employee.id, salonA.id, "2026-05-19", "08:00", "16:00");
      await app.prisma.absence.create({
        data: {
          employeeId: azubi.employee.id,
          type: "VOCATIONAL_SCHOOL",
          source: "PATTERN",
          startDate: new Date("2026-05-20T00:00:00.000Z"),
          endDate: new Date("2026-05-20T00:00:00.000Z"),
          days: 1,
          halfDay: false,
          createdBy: "system",
        },
      });

      const overviewOnly = await createPerson(data.tenant.id, "overview-only2", {
        schedule: "NONE",
      });
      const roleOverview = await customRole(data.tenant.id, ["team-overview:read:ZUGEWIESEN"]);
      await assign(data.tenant.id, overviewOnly.user.id, roleOverview.id, {
        scopeType: "TENANT",
      });
      overviewOnlyToken = await login(overviewOnly.user.email);

      const manager = await createPerson(data.tenant.id, "salon-manager2", { schedule: "NONE" });
      await assign(data.tenant.id, manager.user.id, SYSTEM_ROLE_IDS.SALON_MANAGER, {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      salonManagerToken = await login(manager.user.email);
    });

    afterAll(async () => {
      try {
        await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data.tenant.id } });
        await app.prisma.accessRole.deleteMany({ where: { tenantId: data.tenant.id } });
        await cleanupTestData(app, data.tenant.id);
        await cleanupTestData(app, foreign.tenant.id);
      } catch (err) {
        console.error("dashboard-team-trend-84 filter cleanup failed:", err);
      }
    });

    const byMonth = (t: Trend, month: string) => t.months.find((m) => m.month === month)!;

    it("attributes June time to the entry's salon: unfiltered 780, A 360, B 420", async () => {
      const all = await trend(data.adminToken);
      const a = await trend(data.adminToken, `?salonId=${salonA.id}`);
      const b = await trend(data.adminToken, `?salonId=${salonB.id}`);
      expect(byMonth(all, "2026-06").workedMinutes).toBe(780);
      expect(byMonth(a, "2026-06").workedMinutes).toBe(360);
      expect(byMonth(b, "2026-06").workedMinutes).toBe(420);
    });

    it("attributes sick days to the Stammsalon per day: May 5 / 3 / 2, April 5 / 3 / 2 across a change on the 11th", async () => {
      const all = await trend(data.adminToken);
      const a = await trend(data.adminToken, `?salonId=${salonA.id}`);
      const b = await trend(data.adminToken, `?salonId=${salonB.id}`);
      expect([
        byMonth(all, "2026-05").sickDays,
        byMonth(a, "2026-05").sickDays,
        byMonth(b, "2026-05").sickDays,
      ]).toEqual([5, 3, 2]);
      expect([
        byMonth(all, "2026-04").sickDays,
        byMonth(a, "2026-04").sickDays,
        byMonth(b, "2026-04").sickDays,
      ]).toEqual([5, 3, 2]);
    });

    it("sums over the active salons to the unfiltered figure (AC-3), except the Berufsschule credit", async () => {
      const all = await trend(data.adminToken);
      const a = await trend(data.adminToken, `?salonId=${salonA.id}`);
      const b = await trend(data.adminToken, `?salonId=${salonB.id}`);
      for (const m of MONTHS) {
        expect(byMonth(a, m).sickDays + byMonth(b, m).sickDays, `${m} sick`).toBe(
          byMonth(all, m).sickDays,
        );
        if (m === "2026-05") continue;
        expect(byMonth(a, m).workedMinutes + byMonth(b, m).workedMinutes, `${m} worked`).toBe(
          byMonth(all, m).workedMinutes,
        );
      }
    });

    it("attributes the Berufsschule credit to no salon: May is entry minutes only and below the account's Ist", async () => {
      const all = await trend(data.adminToken);
      const a = await trend(data.adminToken, `?salonId=${salonA.id}`);
      const b = await trend(data.adminToken, `?salonId=${salonB.id}`);
      expect(byMonth(a, "2026-05").workedMinutes + byMonth(b, "2026-05").workedMinutes).toBe(480);
      expect(byMonth(all, "2026-05").workedMinutes).toBeGreaterThan(480);
    });

    it("counts neither today's closed entry, nor an invalid one, nor an open one", async () => {
      const a = await trend(data.adminToken, `?salonId=${salonA.id}`);
      // P's 360 only; S's three entries (60 + 120 + open) add nothing.
      expect(byMonth(a, "2026-06").workedMinutes).toBe(360);
    });

    it("never splits Soll: filtered responses carry no Soll and name the reason (D-05)", async () => {
      const admin = await trend(data.adminToken, `?salonId=${salonA.id}`);
      expect(admin.salonId).toBe(salonA.id);
      expect(admin.workedBasis).toBe("SALON_ENTRIES");
      expect(admin.sollUnavailableReason).toBe("SALON_FILTER");
      expect(admin.months.every((m) => m.shouldMinutes === null)).toBe(true);

      const overview = await trend(overviewOnlyToken, `?salonId=${salonA.id}`);
      expect(overview.sollUnavailableReason).toBe("NO_PERMISSION");
      expect(overview.months.every((m) => m.shouldMinutes === null)).toBe(true);
    });

    it("answers a foreign, unknown, inactive and out-of-reach salon with the byte-identical 404", async () => {
      const probes: Array<[string, string, string]> = [
        ["foreign tenant's salon", data.adminToken, foreign.salonId],
        ["unknown id", data.adminToken, crypto.randomUUID()],
        ["own deactivated salon", data.adminToken, salonGone.id],
        ["salon B for the Salonmanager of A", salonManagerToken, salonB.id],
      ];
      for (const [label, token, salonId] of probes) {
        const res = await get(token, `/api/v1/dashboard/team-trend?salonId=${salonId}`);
        expect(res.statusCode, label).toBe(404);
        expect(res.body, label).toBe(NOT_FOUND_BODY);
      }
    });

    it("lets the Salonmanager of A filter on A, and rejects a malformed id with 400", async () => {
      const res = await get(salonManagerToken, `/api/v1/dashboard/team-trend?salonId=${salonA.id}`);
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body) as Trend;
      expect(body.sollUnavailableReason).toBe("NO_PERMISSION");
      expect(byMonth(body, "2026-06").workedMinutes).toBe(360);
      const bad = await get(data.adminToken, "/api/v1/dashboard/team-trend?salonId=not-a-uuid");
      expect(bad.statusCode).toBe(400);
    });
  });
});
