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
import { createPopulationPerson } from "./population-fixtures-613";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";
import { addDaysStr, dbDateStr, futureDateStr, monthStartUtc, todayStr } from "./test-dates";

const PASSWORD = "test1234";

describe("Issue #86 (Phase 86b) — HR template: report:read and salon:read, nothing more", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let employeeX: { id: string };
  // Issue #714 (P-714-10): a person homed in the fixture's salon, so the filtered period answer has a
  // row (employee X has no Stammsalon and appears there as a helper).
  let employeeZ: { employeeId: string };
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

    employeeZ = await createPopulationPerson(app, {
      tenantId: data.tenant.id,
      salonId: data.salonId,
      tag: "HRZ",
      hireDate: new Date("2024-01-01T00:00:00Z"),
    });
    const entryDayZ = addDaysStr(dbDateStr(prevMonthStart), 10);
    await app.prisma.timeEntry.create({
      data: {
        employeeId: employeeZ.employeeId,
        salonId: data.salonId,
        date: new Date(entryDayZ),
        startTime: new Date(`${entryDayZ}T08:00:00Z`),
        endTime: new Date(`${entryDayZ}T12:00:00Z`),
        source: "MANUAL",
      },
    });

    // Z takes the same vacation, so the filtered answer (Z's circle) carries an absence statistic too.
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: employeeZ.employeeId,
        leaveTypeId: data.vacationType.id,
        startDate: new Date(addDaysStr(dbDateStr(prevMonthStart), 13)),
        endDate: new Date(addDaysStr(dbDateStr(prevMonthStart), 15)),
        days: 3,
        status: "APPROVED",
        reviewedBy: data.adminUser.id,
        reviewedAt: new Date(),
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
    // Issue #714 (P-714-10): the same period answer under a salon filter - the Stammsalon rows, the
    // salon hours and the Aushilfen; it too must stay day-free and carry only the listed paths.
    {
      name: "GET /reports/period (Salon)",
      url: () =>
        `/reports/period?from=${prevYear}-${pad2(prevMonth)}&to=${prevYear}-${pad2(prevMonth)}&salonId=${data.salonId}`,
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
        // vacation KPIs: sums of the period-end year's Urlaub table (day counts of the year) and
        // the Stichtag they are read at - the very columns of the table below
        "$.kpis.vacationYear",
        "$.kpis.vacationAsOf",
        "$.kpis.vacationTakenDays",
        "$.kpis.vacationApprovedDays",
        "$.kpis.vacationEntitlementDays",
        // one row per person: identity and period sums of minutes and day counts
        "$.rows",
        "$.rows[]",
        "$.rows[].employeeId",
        "$.rows[].employeeName",
        "$.rows[].employeeNumber",
        // two facts about the person, never a day: whether any working time was ever recorded, and
        // the calendar day the employment ended when that is inside the period
        "$.rows[].hasRecordedTime",
        "$.rows[].exitDay",
        "$.rows[].workedMinutes",
        "$.rows[].expectedMinutes",
        "$.rows[].balanceMinutes",
        "$.rows[].openingBalanceMinutes",
        "$.rows[].closingBalanceMinutes",
        // closing figures: the exact confirmed/open split of the closing saldo (minutes) and the
        // count of unclosed months behind it - sums, never a day
        "$.rows[].closingConfirmedMinutes",
        "$.rows[].closingOpenMinutes",
        "$.rows[].unconfirmedMonths",
        "$.rows[].monthCount",
        "$.rows[].confirmedMonthCount",
        "$.rows[].labelled",
        "$.rows[].sickDays",
        // Issue #713 (D-07): counts per leave-type code for the period, never a day
        "$.rows[].absence",
        "$.rows[].absence.SICK",
        "$.rows[].absence.SICK_CHILD",
        "$.rows[].absence.VACATION",
        "$.rows[].absence.OVERTIME_COMP",
        "$.rows[].absence.SPECIAL",
        "$.rows[].absence.VOCATIONAL_SCHOOL",
        "$.rows[].absence.EDUCATION",
        "$.rows[].absence.UNPAID",
        "$.rows[].absence.MATERNITY",
        "$.rows[].absence.PARENTAL",
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
        // vacation year figures per person and calendar year the period touches: day counts of the
        // year (as on the leave-overview), one carry-over deadline and one notice date per
        // entitlement - the very columns of the Urlaubsuebersicht and the Verfall-Warnungen, no day list
        "$.vacation",
        "$.vacation.year",
        "$.vacation.asOf",
        "$.vacation.years",
        "$.vacation.years[]",
        "$.vacation.years[].year",
        "$.vacation.years[].asOf",
        "$.vacation.years[].rows",
        "$.vacation.years[].rows[]",
        "$.vacation.years[].rows[].employeeId",
        "$.vacation.years[].rows[].employeeName",
        "$.vacation.years[].rows[].employeeNumber",
        "$.vacation.years[].rows[].year",
        "$.vacation.years[].rows[].entitlementId",
        "$.vacation.years[].rows[].entitlementDays",
        "$.vacation.years[].rows[].carriedOverDays",
        "$.vacation.years[].rows[].carriedOverEffectiveDays",
        "$.vacation.years[].rows[].carriedOverExpiredDays",
        "$.vacation.years[].rows[].exitReductionDays",
        "$.vacation.years[].rows[].availableDays",
        "$.vacation.years[].rows[].takenDays",
        "$.vacation.years[].rows[].approvedUpcomingDays",
        "$.vacation.years[].rows[].pendingDays",
        "$.vacation.years[].rows[].remainingDays",
        "$.vacation.years[].rows[].atRiskDays",
        "$.vacation.years[].rows[].carryOverDeadline",
        "$.vacation.years[].rows[].lastWarningSentAt",
        "$.vacation.years[].rows[].missingEntitlement",
        "$.vacation.years[].rows[].entitlementWarning",
        // absence statistics by leave-type code: day COUNTS per kind with the number of persons,
        // never who or when
        "$.absences",
        "$.absences[]",
        "$.absences[].code",
        "$.absences[].unit",
        "$.absences[].personCount",
        "$.absences[].totalDays",
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
    // Issue #714: under a salon filter the period answer keeps every path above and adds exactly
    // these - identity and minutes of the Aushilfen, the salon hours as a figure of its own, the basis
    // marker and the reach kind. Hours only: no Soll, saldo, status, month or day for a helper.
    ALLOW_LIST["GET /reports/period (Salon)"] = [
      ...ALLOW_LIST["GET /reports/period"],
      // envelope of a salon view: the salon id, the person basis, the caller's reach kind
      "$.salonId",
      "$.personBasis",
      "$.helpersReach",
      // the number of persons without a Stammsalon in an active salon - one count, never who
      "$.withoutHomeSalonCount",
      // the Aushilfen of other salons: identity and the hours worked in the salon, nothing else
      "$.helpers",
      "$.helpers[]",
      "$.helpers[].employeeId",
      "$.helpers[].employeeName",
      "$.helpers[].employeeNumber",
      "$.helpers[].salonWorkedMinutes",
      // hours worked in the salon: KPI sum, per row and per month - minutes, never a day
      "$.kpis.salonWorkedMinutes",
      "$.rows[].salonWorkedMinutes",
      "$.rows[].months[].salonWorkedMinutes",
    ];

    /** The row of employee X inside a body, so a vacuous (empty) answer cannot pass. */
    function rowsOfX(name: string, body: unknown): unknown[] {
      if (name === "GET /reports/period (Salon)") {
        // Z is a Stammsalon row, X (no Stammsalon, an entry in the salon) is an Aushilfe.
        const salon = body as {
          rows: Array<{ employeeId: string }>;
          helpers: Array<{ employeeId: string }>;
        };
        return [
          ...salon.rows.filter((r) => r.employeeId === employeeZ.employeeId),
          ...salon.helpers.filter((h) => h.employeeId === employeeX.id),
        ];
      }
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

    it("GET /reports/period (Salon): Z is a Stammsalon row and X an Aushilfe, so both groups are really checked", async () => {
      const res = await asHr("GET", READ_ROUTES[READ_ROUTES.length - 1].url());
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        rows: Array<{ employeeId: string }>;
        helpers: Array<{ employeeId: string }>;
      };
      expect(body.rows.map((r) => r.employeeId)).toContain(employeeZ.employeeId);
      expect(body.rows.map((r) => r.employeeId)).not.toContain(employeeX.id);
      expect(body.helpers.map((h) => h.employeeId)).toEqual([employeeX.id]);
    });

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
      // Issue #612: the period table as a file is an export - report:read alone is refused.
      "GET /api/v1/reports/period/csv": 403,
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
      if (route.endsWith("/period") || route.endsWith("/period/csv")) {
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
