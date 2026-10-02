/**
 * Issue #448 (D-05, plan 03) — every reader that shows a leave day shows a Berufsschultag inside
 * a VACATION request as the server's own classification, computed once in Abwesenheiten:
 * GET /leave/hours-preview, GET /leave/requests, and the dashboard's per-day status
 * (/dashboard/team-week and /dashboard/my-week).
 *
 * Every date is a fixed 2027 calendar literal — 2027-03-08..12 is a Monday-Friday week with no
 * German statutory holiday (NIEDERSACHSEN, the seedTestData default federal state).
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getTestApp,
  seedTestData,
  seedEntitlementYears,
  cleanupTestData,
  closeTestApp,
} from "./setup";
import { leaveTypeFields } from "../contexts/absence/leave-type";

describe("Issue #448 — Berufsschultag-Klassifikation in Vorschau, Antragsliste und Dashboard", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let sickTypeId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "bs448disp");
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { classification: "AZUBI", birthDate: new Date("2010-06-01") },
    });
    await seedEntitlementYears(app, {
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      years: [2027, 2028],
    });
    const sickType = await app.prisma.leaveType.create({
      data: { tenantId: data.tenant.id, ...leaveTypeFields("SICK") },
    });
    sickTypeId = sickType.id;

    await app.prisma.absence.create({
      data: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: new Date("2027-03-09T00:00:00.000Z"),
        endDate: new Date("2027-03-09T00:00:00.000Z"),
        days: 1,
        halfDay: false,
        createdBy: "system",
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("GET /leave/hours-preview", () => {
    it("VACATION over a BS Tuesday: days 4, vocationalSchoolDates [09.03.], vocationalSchoolOnly false", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/leave/hours-preview?startDate=2027-03-08&endDate=2027-03-12&type=VACATION",
        headers: { authorization: `Bearer ${data.empToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Number(body.days)).toBe(4);
      expect(body.vocationalSchoolDates).toEqual(["2027-03-09"]);
      expect(body.vocationalSchoolOnly).toBe(false);
    });

    it("VACATION on only the BS Tuesday: days 0, vocationalSchoolOnly true", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/leave/hours-preview?startDate=2027-03-09&endDate=2027-03-09&type=VACATION",
        headers: { authorization: `Bearer ${data.empToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Number(body.days)).toBe(0);
      expect(body.vocationalSchoolOnly).toBe(true);
    });

    it("SICK over the same range: vocationalSchoolDates [], days unchanged (5)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/leave/hours-preview?startDate=2027-03-08&endDate=2027-03-12&type=SICK",
        headers: { authorization: `Bearer ${data.empToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Number(body.days)).toBe(5);
      expect(body.vocationalSchoolDates).toEqual([]);
    });

    it("employee without any BS row: vocationalSchoolDates [], vocationalSchoolOnly false, days byte-identical", async () => {
      const other = await seedTestData(app, "bs448dispNoBs");
      try {
        const res = await app.inject({
          method: "GET",
          url: "/api/v1/leave/hours-preview?startDate=2027-03-08&endDate=2027-03-12&type=VACATION",
          headers: { authorization: `Bearer ${other.empToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(Number(body.days)).toBe(5);
        expect(body.vocationalSchoolDates).toEqual([]);
        expect(body.vocationalSchoolOnly).toBe(false);
      } finally {
        await cleanupTestData(app, other.tenant.id);
      }
    });
  });

  describe("GET /leave/requests", () => {
    it("VACATION item over the BS week carries vocationalSchoolDates; a SICK item carries []; a foreign-tenant BS row never leaks in", async () => {
      const foreign = await seedTestData(app, "bs448dispForeign");
      try {
        await app.prisma.absence.create({
          data: {
            employeeId: foreign.employee.id,
            type: "VOCATIONAL_SCHOOL",
            source: "PATTERN",
            startDate: new Date("2027-03-09T00:00:00.000Z"),
            endDate: new Date("2027-03-09T00:00:00.000Z"),
            days: 1,
            halfDay: false,
            createdBy: "system",
          },
        });

        const vacRes = await app.inject({
          method: "POST",
          url: "/api/v1/leave/requests",
          headers: { authorization: `Bearer ${data.empToken}` },
          payload: { type: "VACATION", startDate: "2027-03-08", endDate: "2027-03-12" },
        });
        expect(vacRes.statusCode).toBe(201);
        const vacId = JSON.parse(vacRes.body).id;

        await app.prisma.leaveEntitlement.create({
          data: {
            employeeId: data.employee.id,
            leaveTypeId: sickTypeId,
            year: 2027,
            totalDays: 0,
            usedDays: 0,
          },
        });
        const sickRes = await app.inject({
          method: "POST",
          url: "/api/v1/leave/requests",
          headers: { authorization: `Bearer ${data.empToken}` },
          payload: { type: "SICK", startDate: "2027-05-10", endDate: "2027-05-10" },
        });
        expect(sickRes.statusCode).toBe(201);
        const sickId = JSON.parse(sickRes.body).id;

        const listRes = await app.inject({
          method: "GET",
          url: `/api/v1/leave/requests?employeeId=${data.employee.id}`,
          headers: { authorization: `Bearer ${data.adminToken}` },
        });
        expect(listRes.statusCode).toBe(200);
        const list = JSON.parse(listRes.body) as Array<{
          id: string;
          vocationalSchoolDates: string[];
        }>;
        const vacItem = list.find((r) => r.id === vacId);
        const sickItem = list.find((r) => r.id === sickId);
        expect(vacItem?.vocationalSchoolDates).toEqual(["2027-03-09"]);
        expect(sickItem?.vocationalSchoolDates).toEqual([]);
      } finally {
        await cleanupTestData(app, foreign.tenant.id);
      }
    });
  });

  describe("Dashboard — BS displaces vacation for that day only", () => {
    it("/dashboard/my-week: BS Tuesday shows absenceType VOCATIONAL_SCHOOL and no vacation leaveType; Monday stays vacation", async () => {
      // Own, non-overlapping week (2027-04-12..16, Mo-Fr) with its own BS Tuesday — independent
      // of the GET /requests describe block above (Issue #436 week-union otherwise interacts).
      await app.prisma.absence.create({
        data: {
          employeeId: data.employee.id,
          type: "VOCATIONAL_SCHOOL",
          source: "PATTERN",
          startDate: new Date("2027-04-13T00:00:00.000Z"),
          endDate: new Date("2027-04-13T00:00:00.000Z"),
          days: 1,
          halfDay: false,
          createdBy: "system",
        },
      });
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { type: "VACATION", startDate: "2027-04-12", endDate: "2027-04-16" },
      });
      expect(createRes.statusCode).toBe(201);
      const { id: requestId } = JSON.parse(createRes.body);
      const reviewRes = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${requestId}/review`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { status: "APPROVED", reviewNote: "Genehmigt" },
      });
      expect(reviewRes.statusCode).toBe(200);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/my-week?date=2027-04-13",
        headers: { authorization: `Bearer ${data.empToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        days: Array<{ date: string; leaveType: string | null; absenceType: string | null }>;
      };
      const tue = body.days.find((d) => d.date === "2027-04-13");
      const mon = body.days.find((d) => d.date === "2027-04-12");
      expect(tue?.absenceType).toBe("VOCATIONAL_SCHOOL");
      expect(tue?.leaveType).toBeNull();
      expect(mon?.leaveType).not.toBeNull();
    });
  });
});
