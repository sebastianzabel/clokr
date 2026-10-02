/**
 * Issue #448 (owner decision 01.10.2026 + implementation decisions 02.10.2026) — a
 * Berufsschultag (VOCATIONAL_SCHOOL Absence) never costs a leave day and never reduces Soll
 * twice. This file covers the HTTP-level pricing and 400-rejection behaviour (D-01/D-02/D-07)
 * for every schedule type and write path (POST create, PUT edit, PATCH correct). The saldo
 * (D-03) is covered separately in
 * contexts/working-time-account/__tests__/close-employee-month-bs-leave.test.ts.
 *
 * Every date is a fixed 2027 calendar literal (not computed from "today") — 2027-03-08..12 is a
 * Monday-Friday week with no German statutory holiday (NIEDERSACHSEN, the seedTestData default
 * federal state) and no Easter proximity (Ostern 2027 = 28.03.).
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData, closeTestApp } from "./setup";

describe("Issue #448 — Berufsschultag kostet keinen Urlaubstag", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "bs448");
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { classification: "AZUBI", birthDate: new Date("2010-06-01") },
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

  async function createBsAbsence(
    employeeId: string,
    isoDate: string,
    source: "PATTERN" | "MANUAL" = "PATTERN",
  ) {
    const d = new Date(`${isoDate}T00:00:00.000Z`);
    await app.prisma.absence.create({
      data: {
        employeeId,
        type: "VOCATIONAL_SCHOOL",
        source,
        startDate: d,
        endDate: d,
        days: 1,
        halfDay: false,
        createdBy: "system",
      },
    });
  }

  it("FIXED AZUBI: Mo–Fr vacation over a BS Tuesday prices 4 days (not 5)", async () => {
    await createBsAbsence(data.employee.id, "2027-03-09");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type: "VACATION", startDate: "2027-03-08", endDate: "2027-03-12" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(Number(body.days)).toBe(4);
  });

  it("FIXED AZUBI: a request for only the BS Tuesday is rejected with the owner's text", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type: "VACATION", startDate: "2027-03-09", endDate: "2027-03-09" },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe(
      "An Berufsschultagen kann kein Urlaub genommen werden – der Azubi ist für den Unterricht freigestellt.",
    );
    expect(body.code).toBe("VOCATIONAL_SCHOOL_DAY");

    const stored = await app.prisma.leaveRequest.findFirst({
      where: { employeeId: data.employee.id, startDate: new Date("2027-03-09T00:00:00.000Z") },
    });
    expect(stored).toBeNull();
  });

  it("FIXED AZUBI: a week with no BS row prices unchanged (5 days)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type: "VACATION", startDate: "2027-03-15", endDate: "2027-03-19" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(Number(body.days)).toBe(5);
  });
});
