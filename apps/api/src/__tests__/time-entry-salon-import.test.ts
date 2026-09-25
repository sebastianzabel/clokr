/**
 * Phase 68b Plan 02, Task 2 (issue #68, D-11/D-13/D-14) — the CSV importer's optional
 * `salonId` / `Salon-ID` column, resolved through the same `resolveEntrySalon` rule as
 * every other TimeEntry writer, plus `GET /time-entries` exposing `salonId` per entry.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { addDaysStr, mondayOfWeekStr } from "./test-dates";

describe("CSV import salon column + GET salonId (Phase 68b, issue #68, D-11/D-13/D-14)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let noneTenant: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let salonC: { id: string };
  let salonX: { id: string };
  const ghost = randomUUID();

  // A run of distinct past Mondays — CSV import is exempt from the retro-window guard
  // (isCorrectionByManager: true), so only "distinct" matters, one row per employee/day.
  const baseMonday = addDaysStr(mondayOfWeekStr(), -7);
  const mondayWeeksAgo = (n: number) => addDaysStr(baseMonday, -7 * (n - 1));

  const dateSalonIdHeader = mondayWeeksAgo(1);
  const dateSalonIdAlias = mondayWeeksAgo(2);
  const dateNoColumnMonday = mondayWeeksAgo(3);
  const dateNoColumnThursday = addDaysStr(dateNoColumnMonday, 3); // Thursday
  const dateInactiveX = mondayWeeksAgo(4);
  const dateForeignGhost = mondayWeeksAgo(5);
  const dateNonUuidBad = mondayWeeksAgo(6);
  const dateNonUuidGood = addDaysStr(dateNonUuidBad, 1);
  const dateGetExplicit = mondayWeeksAgo(7);
  const dateGetDerived = addDaysStr(dateGetExplicit, 1);
  const dateNoActiveSalon = mondayWeeksAgo(1); // separate tenant, no collision

  function csv(rows: string[], header = "nr;datum;von;bis;pause;notiz"): string {
    return [header, ...rows].join("\n");
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "tes-imp"); // seed.salonId = the tenant's default salon (D)
    foreign = await seedTestData(app, "tes-imp-foreign"); // foreign.salonId = F
    noneTenant = await seedTestData(app, "tes-imp-none");

    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon A (HOME)" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon B (Thursday DEPLOYMENT)",
    });
    salonC = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon C (no assignment)" });
    salonX = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon X (inactive)",
      isActive: false,
    });

    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        employeeId: seed.employee.id,
        salonId: salonA.id,
        kind: "HOME",
        validFrom: new Date("2024-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        employeeId: seed.employee.id,
        salonId: salonB.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2024-01-01"),
        validUntil: null,
        weekdays: [3], // Thursday
      },
    });

    await app.prisma.salon.updateMany({
      where: { tenantId: noneTenant.tenant.id },
      data: { isActive: false, deactivatedAt: new Date() },
    });
  });

  afterAll(async () => {
    for (const t of [seed, foreign, noneTenant]) {
      try {
        await cleanupTestData(app, t.tenant.id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  it("D-11: a Salon-ID column with value C is honoured although salonForDay would say A", async () => {
    const empNo = seed.employee.employeeNumber;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports/time-entries",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        csv: csv(
          [`${empNo};${dateSalonIdHeader};08:00;16:00;30;Salon-ID-Test;${salonC.id}`],
          "nr;datum;von;bis;pause;notiz;Salon-ID",
        ),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.imported).toBe(1);

    const entry = await app.prisma.timeEntry.findFirst({
      where: { employeeId: seed.employee.id, date: new Date(dateSalonIdHeader), deletedAt: null },
    });
    expect(entry?.salonId).toBe(salonC.id);

    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "TimeEntry", entityId: entry!.id, action: "CREATE" },
      orderBy: { createdAt: "desc" },
    });
    expect((audit?.newValue as { salonId?: string } | null)?.salonId).toBe(salonC.id);
  });

  it("D-11: the salonId alias header is honoured the same way", async () => {
    const empNo = seed.employee.employeeNumber;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports/time-entries",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        csv: csv(
          [`${empNo};${dateSalonIdAlias};08:00;16:00;30;alias-Test;${salonC.id}`],
          "nr;datum;von;bis;pause;notiz;salonId",
        ),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.imported).toBe(1);

    const entry = await app.prisma.timeEntry.findFirst({
      where: { employeeId: seed.employee.id, date: new Date(dateSalonIdAlias), deletedAt: null },
    });
    expect(entry?.salonId).toBe(salonC.id);
  });

  it("D-11: without a salon column the row falls back to the derived salon (A Monday, B Thursday)", async () => {
    const empNo = seed.employee.employeeNumber;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports/time-entries",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        csv: csv([
          `${empNo};${dateNoColumnMonday};08:00;16:00;30;no-salon-col-monday`,
          `${empNo};${dateNoColumnThursday};08:00;16:00;30;no-salon-col-thursday`,
        ]),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.imported).toBe(2);

    const mondayEntry = await app.prisma.timeEntry.findFirst({
      where: { employeeId: seed.employee.id, date: new Date(dateNoColumnMonday), deletedAt: null },
    });
    expect(mondayEntry?.salonId).toBe(salonA.id);
    const thursdayEntry = await app.prisma.timeEntry.findFirst({
      where: {
        employeeId: seed.employee.id,
        date: new Date(dateNoColumnThursday),
        deletedAt: null,
      },
    });
    expect(thursdayEntry?.salonId).toBe(salonB.id);
  });

  it("D-11: an inactive salon value (X) errors the row with the exact German text, no entry", async () => {
    const empNo = seed.employee.employeeNumber;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports/time-entries",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        csv: csv(
          [`${empNo};${dateInactiveX};08:00;16:00;30;inactive-test;${salonX.id}`],
          "nr;datum;von;bis;pause;notiz;Salon-ID",
        ),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.errors).toBe(1);
    expect(body.details[0].error).toBe("Salon ist deaktiviert");

    const entry = await app.prisma.timeEntry.findFirst({
      where: { employeeId: seed.employee.id, date: new Date(dateInactiveX), deletedAt: null },
    });
    expect(entry).toBeNull();
  });

  it("T-100-09: a foreign tenant's real salon and a nonexistent id answer byte-identical whole responses", async () => {
    const empNo = seed.employee.employeeNumber;
    const header = "nr;datum;von;bis;pause;notiz;Salon-ID";
    const foreignRes = await app.inject({
      method: "POST",
      url: "/api/v1/imports/time-entries",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        csv: csv([`${empNo};${dateForeignGhost};08:00;16:00;30;t10009;${foreign.salonId}`], header),
      },
    });
    const ghostRes = await app.inject({
      method: "POST",
      url: "/api/v1/imports/time-entries",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        csv: csv([`${empNo};${dateForeignGhost};08:00;16:00;30;t10009;${ghost}`], header),
      },
    });
    expect(foreignRes.statusCode).toBe(200);
    expect(ghostRes.statusCode).toBe(200);
    expect(foreignRes.body).toBe(ghostRes.body);
    const body = JSON.parse(foreignRes.body);
    expect(body.errors).toBe(1);
    expect(body.details[0].error).toBe("Salon nicht gefunden");

    const entry = await app.prisma.timeEntry.findFirst({
      where: { employeeId: seed.employee.id, date: new Date(dateForeignGhost), deletedAt: null },
    });
    expect(entry).toBeNull();
  });

  it("D-11: a non-UUID salon value errors only its own row; the other rows of the same file still import", async () => {
    const empNo = seed.employee.employeeNumber;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports/time-entries",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        csv: csv(
          [
            `${empNo};${dateNonUuidBad};08:00;16:00;30;bad-salon;not-a-uuid`,
            `${empNo};${dateNonUuidGood};08:00;16:00;30;good-row;${salonC.id}`,
          ],
          "nr;datum;von;bis;pause;notiz;Salon-ID",
        ),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.imported).toBe(1);
    expect(body.errors).toBe(1);

    const badEntry = await app.prisma.timeEntry.findFirst({
      where: { employeeId: seed.employee.id, date: new Date(dateNonUuidBad), deletedAt: null },
    });
    expect(badEntry).toBeNull();
    const goodEntry = await app.prisma.timeEntry.findFirst({
      where: { employeeId: seed.employee.id, date: new Date(dateNonUuidGood), deletedAt: null },
    });
    expect(goodEntry?.salonId).toBe(salonC.id);
  });

  it("D-11: a tenant without any active salon and an employee without assignment errors with the exact text", async () => {
    const empNo = noneTenant.employee.employeeNumber;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports/time-entries",
      headers: { authorization: `Bearer ${noneTenant.adminToken}` },
      payload: {
        csv: csv([`${empNo};${dateNoActiveSalon};08:00;16:00;30;no-active-salon`]),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.errors).toBe(1);
    expect(body.details[0].error).toBe("Kein aktiver Salon vorhanden.");

    const entry = await app.prisma.timeEntry.findFirst({
      where: { employeeId: noneTenant.employee.id, date: new Date(dateNoActiveSalon) },
    });
    expect(entry).toBeNull();
  });

  it("D-14: GET /time-entries returns salonId per entry for both ADMIN (employeeId) and EMPLOYEE (own)", async () => {
    const empNo = seed.employee.employeeNumber;
    const importRes = await app.inject({
      method: "POST",
      url: "/api/v1/imports/time-entries",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        csv: csv(
          [
            `${empNo};${dateGetExplicit};08:00;16:00;30;get-explicit;${salonC.id}`,
            `${empNo};${dateGetDerived};08:00;16:00;30;get-derived`,
          ],
          "nr;datum;von;bis;pause;notiz;Salon-ID",
        ),
      },
    });
    expect(JSON.parse(importRes.body).imported).toBe(2);

    const adminRes = await app.inject({
      method: "GET",
      url: `/api/v1/time-entries?employeeId=${seed.employee.id}&from=${dateGetExplicit}&to=${dateGetDerived}`,
      headers: { authorization: `Bearer ${seed.adminToken}` },
    });
    expect(adminRes.statusCode).toBe(200);
    const adminEntries = JSON.parse(adminRes.body) as { date: string; salonId: string }[];
    const adminExplicit = adminEntries.find((e) => e.date.startsWith(dateGetExplicit));
    const adminDerived = adminEntries.find((e) => e.date.startsWith(dateGetDerived));
    expect(adminExplicit?.salonId).toBe(salonC.id);
    expect(adminDerived?.salonId).toBe(salonA.id);

    const empRes = await app.inject({
      method: "GET",
      url: `/api/v1/time-entries?from=${dateGetExplicit}&to=${dateGetDerived}`,
      headers: { authorization: `Bearer ${seed.empToken}` },
    });
    expect(empRes.statusCode).toBe(200);
    const empEntries = JSON.parse(empRes.body) as { date: string; salonId: string }[];
    const empExplicit = empEntries.find((e) => e.date.startsWith(dateGetExplicit));
    const empDerived = empEntries.find((e) => e.date.startsWith(dateGetDerived));
    expect(empExplicit?.salonId).toBe(salonC.id);
    expect(empDerived?.salonId).toBe(salonA.id);
  });
});
