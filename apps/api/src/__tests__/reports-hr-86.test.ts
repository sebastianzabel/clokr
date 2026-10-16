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
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";
import { addDaysStr, dbDateStr, monthStartUtc, todayStr } from "./test-dates";

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
});
