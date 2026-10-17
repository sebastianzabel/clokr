/**
 * Phase 86b (Issue #86, owner decision 16.10.2026) — the Personalabteilung system-role template
 * (`SYSTEM_ROLE_IDS.HR`) gained `report:read:ZUGEWIESEN` and `salon:read:ZUGEWIESEN`. This file
 * proves, against the SHIPPED template row (never an ad-hoc role), what that does and does not
 * open:
 *
 * - the three `report:read` JSON routes and the salon list answer 200, every other report route
 *   and every salon write stays 403;
 * - the three JSON responses carry only per-person / per-month aggregates, never a per-day
 *   structure (Task 2: key-path allow-list + day-level detector, D-03).
 *
 * No person names in fixtures (CLAUDE.md PII rule), synthetic `@example.invalid` e-mails.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  seedEntitlementYears,
} from "./setup";
import { deriveMatrixRoutes } from "./neutrality/route-derivation";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";
import { addDaysStr, dbDateStr, futureDateStr, monthStartUtc, todayStr } from "./test-dates";

const PASSWORD = "test1234";

describe("Issue #86 (Phase 86b) — HR template: report:read and salon:read, nothing more", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let employeeX: { id: string };
  let hrToken: string;
  let hrPermissions: string[];

  const year = Number(todayStr().slice(0, 4));
  // The previous calendar month, derived from "now" in the tenant timezone (never hard-coded).
  const prevMonthStart = monthStartUtc(1);
  const prevYear = prevMonthStart.getUTCFullYear();
  const prevMonth = prevMonthStart.getUTCMonth() + 1;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "rhr86");
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    // Employee X: a closed WORK entry in the previous month, so the monthly report has a row.
    const xUser = await app.prisma.user.create({
      data: {
        email: `x-${suffix}@example.invalid`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    employeeX = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: xUser.id,
        employeeNumber: `RX${suffix}`.toUpperCase().slice(0, 20),
        firstName: "Fixture",
        lastName: "ReportsHr86X",
        hireDate: new Date("2024-01-01"),
      },
    });
    const entryDay = addDaysStr(dbDateStr(prevMonthStart), 9);
    await app.prisma.timeEntry.create({
      data: {
        employeeId: employeeX.id,
        salonId: data.salonId,
        date: new Date(entryDay),
        startTime: new Date(`${entryDay}T08:00:00Z`),
        endTime: new Date(`${entryDay}T16:00:00Z`),
        source: "MANUAL",
      },
    });

    // An approved vacation of X in the previous month and a VACATION entitlement with carry-over
    // expiring inside the default horizon, so every read route returns at least one row for X.
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: employeeX.id,
        leaveTypeId: data.vacationType.id,
        startDate: new Date(addDaysStr(dbDateStr(prevMonthStart), 13)),
        endDate: new Date(addDaysStr(dbDateStr(prevMonthStart), 15)),
        days: 3,
        status: "APPROVED",
        reviewedBy: data.adminUser.id,
        reviewedAt: new Date(),
      },
    });
    await seedEntitlementYears(app, {
      employeeId: employeeX.id,
      leaveTypeId: data.vacationType.id,
      years: [year],
    });
    await app.prisma.leaveEntitlement.update({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: employeeX.id,
          leaveTypeId: data.vacationType.id,
          year,
        },
      },
      data: { carriedOverDays: 5, carryOverDeadline: new Date(`${futureDateStr(20)}T00:00:00Z`) },
    });

    // The HR principal: ONLY the shipped HR template, TENANT scope.
    const hrUser = await app.prisma.user.create({
      data: {
        email: `hr-${suffix}@example.invalid`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: hrUser.id,
        employeeNumber: `RH${suffix}`.toUpperCase().slice(0, 20),
        firstName: "Fixture",
        lastName: "ReportsHr86Hr",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: hrUser.id,
        accessRoleId: SYSTEM_ROLE_IDS.HR,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: hrUser.email, password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const body = JSON.parse(login.body) as {
      accessToken: string;
      user: { permissions: string[] };
    };
    hrToken = body.accessToken;
    hrPermissions = body.user.permissions;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  function asHr(method: "GET" | "POST", url: string, payload?: Record<string, unknown>) {
    return app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${hrToken}` },
      ...(payload ? { payload } : {}),
    });
  }

  describe("tracer: what the widened template opens", () => {
    it("the login carries report:read and salon:read, and no report:export", () => {
      expect(hrPermissions).toContain("report:read:ZUGEWIESEN");
      expect(hrPermissions).toContain("salon:read:ZUGEWIESEN");
      expect(hrPermissions.filter((k) => k.startsWith("report:export:"))).toEqual([]);
      expect(hrPermissions.filter((k) => k.startsWith("report:notify:"))).toEqual([]);
    });

    it("GET /reports/leave-overview → 200", async () => {
      const res = await asHr("GET", `/reports/leave-overview?year=${year}`);
      expect(res.statusCode).toBe(200);
    });

    it("GET /reports/monthly/pdf → 403 (report:export is not held)", async () => {
      const res = await asHr(
        "GET",
        `/reports/monthly/pdf?employeeId=${employeeX.id}&year=${prevYear}&month=${prevMonth}`,
      );
      expect(res.statusCode).toBe(403);
    });

    it("GET /salons → 200", async () => {
      const res = await asHr("GET", "/salons");
      expect(res.statusCode).toBe(200);
    });

    it("POST /salons → 403 (salon:manage is not held)", async () => {
      const res = await asHr("POST", "/salons", { name: "Fixture Salon" });
      expect(res.statusCode).toBe(403);
    });
  });

  // ── Task 2 (D-03): the report:read answers carry no per-day structure ─────────────────

  /** `GET`s as the HR principal and as the seed admin; the admin answer is the shape reference. */
  function monthlyUrl() {
    return `/reports/monthly?employeeId=${employeeX.id}&year=${prevYear}&month=${prevMonth}`;
  }
  const READ_ROUTES = [
    { name: "GET /reports/monthly", url: () => monthlyUrl() },
    { name: "GET /reports/leave-overview", url: () => `/reports/leave-overview?year=${year}` },
    { name: "GET /reports/carryover-at-risk", url: () => "/reports/carryover-at-risk" },
    // Issue #612: the period report sums the account's month answers; aggregates only.
    {
      name: "GET /reports/period",
      url: () =>
        `/reports/period?from=${prevYear}-${pad2(prevMonth)}&to=${prevYear}-${pad2(prevMonth)}`,
    },
  ] as const;

  async function adminGet(url: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
  }

  describe("the report:read answers are aggregates only (D-03)", () => {
    // Every key path below is a per-person or per-month aggregate (identity, a sum, a count, an
    // entitlement figure, one deadline). A per-day structure here would be a finding against the
    // owner decision of 16.10.2026, never something to pin.
    const ALLOW_LIST: Record<string, readonly string[]> = {
      "GET /reports/monthly": [
        // envelope: the requested month
        "$.month",
        "$.year",
        "$.rows",
        "$.rows[]",
        // identity of the person the row is about
        "$.rows[].employeeId",
        "$.rows[].employeeName",
        "$.rows[].employeeNumber",
        // monthly sums of hours (Soll/Ist/overtime) — never a per-day series
        "$.rows[].shouldHours",
        "$.rows[].workedHours",
        "$.rows[].overtimeHours",
        "$.rows[].overtimeConfirmed",
        "$.rows[].balanceAdjustmentHours",
        // monthly day COUNTS per absence kind (a count, not a list of days)
        "$.rows[].vacationDays",
        "$.rows[].sickDays",
        "$.rows[].sickDaysWithAttest",
        "$.rows[].sickDaysWithoutAttest",
        "$.rows[].specialLeaveDays",
        "$.rows[].unpaidDays",
        "$.rows[].parentalDays",
        "$.rows[].maternityDays",
        "$.rows[].educationDays",
        "$.rows[].overtimeCompDays",
        "$.rows[].totalAbsenceDays",
        "$.rows[].section9DaysThisMonth",
      ],
      "GET /reports/leave-overview": [
        "$[]",
        // identity of the person and the leave type the entitlement belongs to
        "$[].employee",
        "$[].employee.id",
        "$[].employee.employeeNumber",
        "$[].employee.firstName",
        "$[].employee.lastName",
        "$[].leaveType",
        "$[].leaveType.id",
        "$[].leaveType.tenantId",
        "$[].leaveType.code",
        "$[].leaveType.name",
        "$[].leaveType.color",
        "$[].leaveType.isPaid",
        "$[].leaveType.requiresApproval",
        "$[].leaveType.allowHalfDay",
        "$[].leaveType.leadTimeDays",
        "$[].leaveType.maxDaysPerYear",
        "$[].leaveType.createdAt",
        // yearly entitlement figures per person and type (day counts of the year, no day list)
        "$[].year",
        "$[].totalDays",
        "$[].usedDays",
        "$[].pendingDays",
        "$[].remainingDays",
        "$[].carriedOverDays",
        "$[].carriedOverEffectiveDays",
        "$[].carriedOverExpiredDays",
        "$[].atRiskDays",
        "$[].exitReductionDays",
        // Issue #617: per-person yearly day counts of the Urlaubsuebersicht (verfuegbar, genommen,
        // genehmigt) - counts of the year from the Resturlaub facade, still no day list.
        "$[].availableDays",
        "$[].takenDays",
        "$[].approvedUpcomingDays",
        "$[].entitlementWarning",
        "$[].missingEntitlement",
      ],
      "GET /reports/period": [
        // envelope and months of the period (year-month pairs, never a day)
        "$.from",
        "$.to",
        "$.months",
        "$.months[]",
        "$.months[].year",
        "$.months[].month",
        // KPI sums over the rows (minutes and counts) and the day the closing figure runs through
        "$.kpis",
        "$.kpis.personCount",
        "$.kpis.saldoPersonCount",
        "$.kpis.workedMinutes",
        "$.kpis.expectedMinutes",
        "$.kpis.balanceMinutes",
        "$.kpis.closingBalanceMinutes",
        "$.kpis.closingAsOf",
        "$.kpis.closingConfirmed",
        "$.kpis.allMonthsConfirmed",
        "$.kpis.sickDays",
        // one row per person: identity and period sums of minutes and day counts
        "$.rows",
        "$.rows[]",
        "$.rows[].employeeId",
        "$.rows[].employeeName",
        "$.rows[].employeeNumber",
        "$.rows[].workedMinutes",
        "$.rows[].expectedMinutes",
        "$.rows[].balanceMinutes",
        "$.rows[].openingBalanceMinutes",
        "$.rows[].closingBalanceMinutes",
        "$.rows[].monthCount",
        "$.rows[].confirmedMonthCount",
        "$.rows[].labelled",
        "$.rows[].sickDays",
        // the per-month series: one entry per month with monthly sums - never a per-day series
        "$.rows[].months",
        "$.rows[].months[]",
        "$.rows[].months[].year",
        "$.rows[].months[].month",
        "$.rows[].months[].workedMinutes",
        "$.rows[].months[].expectedMinutes",
        "$.rows[].months[].balanceMinutes",
        "$.rows[].months[].closingBalanceMinutes",
        "$.rows[].months[].confirmed",
        "$.rows[].months[].labelled",
        "$.rows[].months[].sickDays",
      ],
      "GET /reports/carryover-at-risk": [
        // envelope: the horizon and the three KPI sums
        "$.horizonDays",
        "$.summary",
        "$.summary.employeesAtRisk",
        "$.summary.totalDaysAtRisk",
        "$.summary.warnedLast30",
        "$.rows",
        "$.rows[]",
        // one row per entitlement: identity, a day count and the single deadline of the carry-over
        "$.rows[].entitlementId",
        "$.rows[].employee",
        "$.rows[].employee.id",
        "$.rows[].employee.employeeNumber",
        "$.rows[].employee.firstName",
        "$.rows[].employee.lastName",
        "$.rows[].leaveType",
        "$.rows[].leaveType.id",
        "$.rows[].leaveType.code",
        "$.rows[].leaveType.name",
        "$.rows[].year",
        "$.rows[].carriedOverDays",
        "$.rows[].atRiskDays",
        "$.rows[].deadline",
        "$.rows[].daysUntilDeadline",
        "$.rows[].lastWarningSentAt",
      ],
    };

    /** The row of employee X inside a body, so a vacuous (empty) answer cannot pass. */
    function rowsOfX(name: string, body: unknown): unknown[] {
      if (name === "GET /reports/monthly" || name === "GET /reports/period") {
        return (body as { rows: Array<{ employeeId: string }> }).rows.filter(
          (r) => r.employeeId === employeeX.id,
        );
      }
      const rows =
        name === "GET /reports/leave-overview" ? body : (body as { rows: unknown[] }).rows;
      return (rows as Array<{ employee: { id: string } }>).filter(
        (r) => r.employee.id === employeeX.id,
      );
    }

    it("the allow-list covers exactly the read routes (input proof)", () => {
      expect(Object.keys(ALLOW_LIST).sort((a, b) => (a < b ? -1 : 1))).toEqual(
        READ_ROUTES.map((r) => r.name).sort((a, b) => (a < b ? -1 : 1)),
      );
    });

    for (const route of READ_ROUTES) {
      it(`${route.name}: employee X appears in the answer, its key paths equal the allow-list, the admin gets the same shape`, async () => {
        const hr = await asHr("GET", route.url());
        expect(hr.statusCode).toBe(200);
        const hrBody = JSON.parse(hr.body);
        expect(
          rowsOfX(route.name, hrBody).length,
          "the fixture yields a row for X",
        ).toBeGreaterThan(0);

        const hrPaths = [...keyPaths(hrBody)].sort((a, b) => (a < b ? -1 : 1));
        expect(hrPaths).toEqual([...ALLOW_LIST[route.name]].sort((a, b) => (a < b ? -1 : 1)));

        const admin = await adminGet(route.url());
        expect(admin.statusCode).toBe(200);
        const adminPaths = [...keyPaths(JSON.parse(admin.body))].sort((a, b) => (a < b ? -1 : 1));
        expect(adminPaths).toEqual(hrPaths);
      });

      it(`${route.name}: the day-level detector finds nothing`, async () => {
        const res = await asHr("GET", route.url());
        expect(findDayLevelStructures(JSON.parse(res.body))).toEqual([]);
      });
    }

    it("positive control: the detector finds the day series of the admin's month-saldo answer", async () => {
      const res = await adminGet(
        `/overtime/month-saldo/${employeeX.id}?year=${prevYear}&month=${prevMonth}`,
      );
      expect(res.statusCode).toBe(200);
      const findings = findDayLevelStructures(JSON.parse(res.body));
      expect(findings.some((f) => f.includes("days"))).toBe(true);
    });

    it("positive control: the detector finds a synthetic list of dated rows", () => {
      const findings = findDayLevelStructures({ rows: [{ date: pastDay() }] });
      expect(findings.length).toBeGreaterThan(0);
    });

    it("positive control: the detector finds a bare list of calendar days and a clock time", () => {
      expect(findDayLevelStructures({ missing: [pastDay(), pastDay()] }).length).toBeGreaterThan(0);
      expect(findDayLevelStructures({ label: "08:30" }).length).toBeGreaterThan(0);
    });
  });

  describe("the whole /reports route family, classified for the HR-only principal", () => {
    // Completeness is checked both ways against the routes derived from source: a new route under
    // /reports must be classified here, and a classified route must still exist.
    const EXPECTED_STATUS: Record<string, number> = {
      "GET /api/v1/reports/monthly": 200,
      "GET /api/v1/reports/leave-overview": 200,
      "GET /api/v1/reports/carryover-at-risk": 200,
      "GET /api/v1/reports/period": 200,
      "POST /api/v1/reports/carryover-warn": 403,
      "GET /api/v1/reports/datev": 403,
      "GET /api/v1/reports/datev/employee": 403,
      "GET /api/v1/reports/monthly-export/pdf": 403,
      "GET /api/v1/reports/monthly/pdf": 403,
    };

    function queryFor(route: string): string {
      const q = `year=${prevYear}&month=${prevMonth}`;
      if (route.endsWith("/monthly") || route.endsWith("/monthly/pdf")) {
        return `?employeeId=${employeeX.id}&${q}`;
      }
      if (route.endsWith("/leave-overview")) {
        return `?year=${year}`;
      }
      if (route.endsWith("/period")) {
        return `?from=${prevYear}-${pad2(prevMonth)}&to=${prevYear}-${pad2(prevMonth)}`;
      }
      if (route.endsWith("/datev/employee")) return `?employeeId=${employeeX.id}&${q}`;
      return `?${q}`;
    }

    const derived = deriveMatrixRoutes().filter((r) =>
      r.split(" ")[1].startsWith("/api/v1/reports/"),
    );

    it("the derived route set is non-empty and equals the classified set", () => {
      expect(derived.length).toBeGreaterThan(0);
      expect([...derived].sort((a, b) => (a < b ? -1 : 1))).toEqual(
        Object.keys(EXPECTED_STATUS).sort((a, b) => (a < b ? -1 : 1)),
      );
    });

    for (const [route, status] of Object.entries(EXPECTED_STATUS)) {
      it(`${route} → ${status}`, async () => {
        const [method, url] = route.split(" ");
        const body = method === "POST" ? { entitlementId: employeeX.id } : undefined;
        const res = await app.inject({
          method: method as "GET" | "POST",
          url: `${url}${method === "GET" ? queryFor(url) : ""}`,
          headers: { authorization: `Bearer ${hrToken}` },
          ...(body ? { payload: body } : {}),
        });
        expect(res.statusCode).toBe(status);
      });
    }
  });
});

/** Zero-padded month for the `YYYY-MM` query of the period report (Issue #612). */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** The JSON key paths of a body, array indices collapsed to `[]`. */
function keyPaths(value: unknown, prefix = "$", out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    out.add(`${prefix}[]`);
    for (const el of value) keyPaths(el, `${prefix}[]`, out);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.add(`${prefix}.${k}`);
      keyPaths(v, `${prefix}.${k}`, out);
    }
  }
  return out;
}

/** A calendar day safely in the past, derived from "now". */
function pastDay(): string {
  return addDaysStr(todayStr(), -40);
}

const DAY_LEVEL_KEYS = new Set([
  "days",
  "entries",
  "breaks",
  "startTime",
  "endTime",
  "clockIn",
  "clockOut",
]);
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_TIME = /^\d{1,2}:\d{2}(:\d{2})?$/;

/**
 * Reports every per-day structure of a JSON body: an array whose elements are calendar-day strings
 * or objects carrying a `date` key, a string shaped like a clock time `HH:MM`, and any key named
 * like a day list or a clock/break field. Empty result = day-free.
 */
function findDayLevelStructures(value: unknown, path = "$"): string[] {
  const findings: string[] = [];
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((el) => typeof el === "string" && CALENDAR_DAY.test(el))) {
      findings.push(`${path}: array of calendar days`);
    }
    value.forEach((el, i) => {
      if (el !== null && typeof el === "object" && !Array.isArray(el) && "date" in el) {
        findings.push(`${path}[${i}]: element carries a date key`);
      }
      findings.push(...findDayLevelStructures(el, `${path}[${i}]`));
    });
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DAY_LEVEL_KEYS.has(k)) findings.push(`${path}.${k}: day-level key "${k}"`);
      findings.push(...findDayLevelStructures(v, `${path}.${k}`));
    }
  } else if (typeof value === "string" && CLOCK_TIME.test(value)) {
    findings.push(`${path}: clock time "${value}"`);
  }
  return findings;
}
