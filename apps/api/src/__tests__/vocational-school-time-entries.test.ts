// Phase 63 Plan 03 — JArbSchG POST/PUT integration tests (BERSCH-07).
//
// Verifies the route-level wiring of checkJArbSchG into POST + PUT /time-entries:
//   - Hard-block returns HTTP 400 with `{ error: "JARBSCHG_MINOR_LIMIT", message }`
//     where the message is the verbatim D-11 German string.
//   - Soft-warn appends `{ code: MAX_DAILY_EXCEEDED, severity: warning, message }`
//     to the response `warnings` array AND emits a `JARBSCHG_SOFT_WARN` audit row.
//   - Non-AZUBI passes through unchanged.
//   - LOCKED-month entries return 403 (existing message) — NOT 400 JARBSCHG_MINOR_LIMIT
//     (D-13: locked-month gate runs BEFORE JArbSchG).
//   - birthDate null on AZUBI → fail-open (HTTP 201).
//
// Test date: 2026-05-15 (Friday). Past relative to system today = 2026-06-01.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { AbsenceType } from "@clokr/db";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

const WORK_DATE_STR = "2026-05-15";
const WORK_DATE = utcDate(WORK_DATE_STR);

// Birthdates positioned relative to WORK_DATE:
//   AGE_17 — turns 17 in 2025; on 2026-05-15 is age 17.
//   AGE_19 — turns 19 in 2026 (before May); on 2026-05-15 is 19.
const BIRTH_AGE_17 = utcDate("2008-12-15");
const BIRTH_AGE_19 = utcDate("2007-01-15");

async function seedBsAbsence(app: FastifyInstance, employeeId: string, date: Date) {
  return app.prisma.absence.create({
    data: {
      employeeId,
      type: AbsenceType.VOCATIONAL_SCHOOL,
      source: "PATTERN",
      startDate: date,
      endDate: date,
      days: 1.0,
      createdBy: "time-entries-test",
      deletedAt: null,
    },
  });
}

describe("POST /api/v1/time-entries — JArbSchG pre-check (Phase 63 Plan 03)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "vs-te-post");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    await app.prisma.absence.deleteMany({ where: { employeeId: data.employee.id } });
    await app.prisma.timeEntry.deleteMany({ where: { employeeId: data.employee.id } });
    await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: data.employee.id } });
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { classification: "AZUBI", birthDate: null },
    });
  });

  it("AZUBI < 18 + BS day + 6h planned → HTTP 400 JARBSCHG_MINOR_LIMIT + no DB row", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { birthDate: BIRTH_AGE_17 },
    });
    await seedBsAbsence(app, data.employee.id, WORK_DATE);

    // 6h work (06:00 - 12:00 Berlin = 04:00 - 10:00 UTC, no break) = 360 min > 225
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: WORK_DATE_STR,
        startTime: `${WORK_DATE_STR}T04:00:00.000Z`,
        endTime: `${WORK_DATE_STR}T10:00:00.000Z`,
        breakMinutes: 0,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("JARBSCHG_MINOR_LIMIT");
    expect(body.message).toContain("JArbSchG §9 Abs. 1 Nr. 2 untersagt");

    // No TimeEntry row created
    const count = await app.prisma.timeEntry.count({
      where: { employeeId: data.employee.id, date: WORK_DATE, deletedAt: null },
    });
    expect(count).toBe(0);
  });

  it("AZUBI < 18 + BS day + 3h planned (≤ 225 min) → HTTP 201, entry created", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { birthDate: BIRTH_AGE_17 },
    });
    await seedBsAbsence(app, data.employee.id, WORK_DATE);

    // 3h work = 180 min ≤ 225
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: WORK_DATE_STR,
        startTime: `${WORK_DATE_STR}T04:00:00.000Z`,
        endTime: `${WORK_DATE_STR}T07:00:00.000Z`,
        breakMinutes: 0,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.entry).toBeDefined();
  });

  it("AZUBI age 19 + BS day + 6h planned → HTTP 201 + soft-warn in body + JARBSCHG_SOFT_WARN audit row", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { birthDate: BIRTH_AGE_19 },
    });
    await seedBsAbsence(app, data.employee.id, WORK_DATE);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: WORK_DATE_STR,
        startTime: `${WORK_DATE_STR}T04:00:00.000Z`,
        endTime: `${WORK_DATE_STR}T10:00:00.000Z`,
        breakMinutes: 0,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.warnings)).toBe(true);
    const softWarn = body.warnings.find(
      (w: { code: string; message: string }) =>
        w.code === "MAX_DAILY_EXCEEDED" && w.message.includes("JArbSchG-Empfehlung"),
    );
    expect(softWarn).toBeDefined();

    // Audit-log row exists
    const auditRow = await app.prisma.auditLog.findFirst({
      where: {
        action: "JARBSCHG_SOFT_WARN",
        entity: "TimeEntry",
        entityId: body.entry.id,
      },
    });
    expect(auditRow).not.toBeNull();
  });

  it("Non-AZUBI on BS day + 8h planned → HTTP 201, no JArbSchG warning", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { classification: "VOLLZEIT", birthDate: BIRTH_AGE_17 },
    });
    await seedBsAbsence(app, data.employee.id, WORK_DATE);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: WORK_DATE_STR,
        startTime: `${WORK_DATE_STR}T04:00:00.000Z`,
        endTime: `${WORK_DATE_STR}T12:00:00.000Z`,
        breakMinutes: 0,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    const jarbWarn = (body.warnings || []).find((w: { message: string }) =>
      w.message?.includes("JArbSchG-Empfehlung"),
    );
    expect(jarbWarn).toBeUndefined();
  });

  it("AZUBI < 18 + BS day + 6h planned BUT birthDate null → HTTP 201 (fail-open)", async () => {
    // No birthDate set
    await seedBsAbsence(app, data.employee.id, WORK_DATE);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date: WORK_DATE_STR,
        startTime: `${WORK_DATE_STR}T04:00:00.000Z`,
        endTime: `${WORK_DATE_STR}T10:00:00.000Z`,
        breakMinutes: 0,
      },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("PUT /api/v1/time-entries/:id — JArbSchG pre-check (Phase 63 Plan 03)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "vs-te-put");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    await app.prisma.absence.deleteMany({ where: { employeeId: data.employee.id } });
    await app.prisma.timeEntry.deleteMany({ where: { employeeId: data.employee.id } });
    await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: data.employee.id } });
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { classification: "AZUBI", birthDate: null },
    });
  });

  it("PUT AZUBI < 18 + BS day + plannedNetWorkMin > 225 → HTTP 400, no DB update", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { birthDate: BIRTH_AGE_17 },
    });
    await seedBsAbsence(app, data.employee.id, WORK_DATE);
    // Pre-existing entry: 2h. Then PUT extends to 6h → blocked.
    const initial = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: WORK_DATE,
        startTime: new Date(`${WORK_DATE_STR}T04:00:00.000Z`),
        endTime: new Date(`${WORK_DATE_STR}T06:00:00.000Z`),
        breakMinutes: 0,
        source: "MANUAL",
        type: "WORK",
      },
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/time-entries/${initial.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        startTime: `${WORK_DATE_STR}T04:00:00.000Z`,
        endTime: `${WORK_DATE_STR}T10:00:00.000Z`, // 6h
        breakMinutes: 0,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("JARBSCHG_MINOR_LIMIT");
    expect(body.message).toContain("JArbSchG §9 Abs. 1 Nr. 2 untersagt");

    // DB unchanged
    const after = await app.prisma.timeEntry.findUnique({ where: { id: initial.id } });
    expect(after!.endTime!.toISOString()).toBe(initial.endTime!.toISOString());
  });

  it("PUT on a LOCKED month entry returns 403 with locked-month message — NOT 400 (Pitfall #3 + D-13)", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { birthDate: BIRTH_AGE_17 },
    });
    await seedBsAbsence(app, data.employee.id, WORK_DATE);

    // Pre-existing LOCKED entry
    const initial = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: WORK_DATE,
        startTime: new Date(`${WORK_DATE_STR}T04:00:00.000Z`),
        endTime: new Date(`${WORK_DATE_STR}T06:00:00.000Z`),
        breakMinutes: 0,
        source: "MANUAL",
        type: "WORK",
        isLocked: true,
        lockedAt: new Date(),
      },
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/time-entries/${initial.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        startTime: `${WORK_DATE_STR}T04:00:00.000Z`,
        endTime: `${WORK_DATE_STR}T10:00:00.000Z`,
        breakMinutes: 0,
      },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    // Existing locked-month message — NOT the JArbSchG one
    expect(body.error).toContain("gesperrt");
    expect(body.error).not.toContain("JARBSCHG");
  });

  it("PUT AZUBI age 19 + BS day + 6h → HTTP 200 + soft-warn + JARBSCHG_SOFT_WARN audit row", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { birthDate: BIRTH_AGE_19 },
    });
    await seedBsAbsence(app, data.employee.id, WORK_DATE);
    const initial = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: WORK_DATE,
        startTime: new Date(`${WORK_DATE_STR}T04:00:00.000Z`),
        endTime: new Date(`${WORK_DATE_STR}T06:00:00.000Z`),
        breakMinutes: 0,
        source: "MANUAL",
        type: "WORK",
      },
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/time-entries/${initial.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        startTime: `${WORK_DATE_STR}T04:00:00.000Z`,
        endTime: `${WORK_DATE_STR}T10:00:00.000Z`,
        breakMinutes: 0,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const softWarn = (body.warnings || []).find(
      (w: { code: string; message: string }) =>
        w.code === "MAX_DAILY_EXCEEDED" && w.message.includes("JArbSchG-Empfehlung"),
    );
    expect(softWarn).toBeDefined();

    const auditRow = await app.prisma.auditLog.findFirst({
      where: {
        action: "JARBSCHG_SOFT_WARN",
        entity: "TimeEntry",
        entityId: initial.id,
      },
    });
    expect(auditRow).not.toBeNull();
  });
});
