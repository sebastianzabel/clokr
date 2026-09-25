/**
 * Phase 71b (issue #71), D-01/AC-1 — tracer: a new salon without an explicit `federalState`
 * inherits the tenant's CURRENT state; an explicit state is stored as given; an invalid state is
 * rejected; the CREATE audit row's `newValue` carries the stored state; `GET /api/v1/salons`
 * lists `federalState` for every salon; `seedTestData`'s own default salon (NI tenant) has
 * `federalState === "NIEDERSACHSEN"`.
 *
 * Phase 71b Plan 06 (issue #71), D-12 — the second describe block below: `PATCH
 * /api/v1/salons/:id` may change `federalState` only while nothing (`TimeEntry`, including
 * soft-deleted; `EmployeeSalonAssignment`, including ended/voided) references the salon yet.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";

describe("Phase 71b — Salon.federalState (D-01, AC-1)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "71b-fedstate");
    await app.prisma.tenant.update({
      where: { id: data.tenant.id },
      data: { federalState: "BAYERN" },
    });
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
  });

  it("seedTestData's default salon (NI tenant, created before the BAYERN update) has federalState NIEDERSACHSEN", async () => {
    const salon = await app.prisma.salon.findUniqueOrThrow({ where: { id: data.salonId! } });
    expect(salon.federalState).toBe("NIEDERSACHSEN");
  });

  it("POST /api/v1/salons without federalState stores the tenant's CURRENT federalState (BAYERN)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/salons",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        name: "71b tracer salon (default state)",
        openingHours: [
          { day: 0, open: "08:00", close: "20:00" },
          { day: 1, open: "08:00", close: "20:00" },
          { day: 2, open: "08:00", close: "20:00" },
          { day: 3, open: "08:00", close: "20:00" },
          { day: 4, open: "08:00", close: "20:00" },
          { day: 5, open: "08:00", close: "20:00" },
          { day: 6, open: "08:00", close: "20:00", closed: true },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.federalState).toBe("BAYERN");

    const auditRow = await app.prisma.auditLog.findFirst({
      where: { entity: "Salon", entityId: body.id, action: "CREATE" },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRow).not.toBeNull();
    expect((auditRow!.newValue as Record<string, unknown>).federalState).toBe("BAYERN");
  });

  it("POST /api/v1/salons with an explicit federalState stores that state, not the tenant's", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/salons",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        name: "71b tracer salon (explicit HAMBURG)",
        federalState: "HAMBURG",
        openingHours: [
          { day: 0, open: "08:00", close: "20:00" },
          { day: 1, open: "08:00", close: "20:00" },
          { day: 2, open: "08:00", close: "20:00" },
          { day: 3, open: "08:00", close: "20:00" },
          { day: 4, open: "08:00", close: "20:00" },
          { day: 5, open: "08:00", close: "20:00" },
          { day: 6, open: "08:00", close: "20:00", closed: true },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.federalState).toBe("HAMBURG");
  });

  it("POST /api/v1/salons with an invalid federalState is rejected with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/salons",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        name: "71b tracer salon (invalid state)",
        federalState: "ATLANTIS",
        openingHours: [
          { day: 0, open: "08:00", close: "20:00" },
          { day: 1, open: "08:00", close: "20:00" },
          { day: 2, open: "08:00", close: "20:00" },
          { day: 3, open: "08:00", close: "20:00" },
          { day: 4, open: "08:00", close: "20:00" },
          { day: 5, open: "08:00", close: "20:00" },
          { day: 6, open: "08:00", close: "20:00", closed: true },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/v1/salons lists federalState for every salon", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/salons?includeInactive=true",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as { salons: Array<{ id: string; federalState: string }> };
    expect(body.salons.length).toBeGreaterThan(0);
    for (const salon of body.salons) {
      expect(typeof salon.federalState).toBe("string");
      expect(salon.federalState.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Phase 71b Plan 06 (issue #71), D-12 — "a salon does not move": `federalState` is changeable
 * only while nothing references the salon yet.
 */
describe("PATCH /api/v1/salons/:id — D-12 federalState guard", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  function patchSalon(token: string, id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/salons/${id}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify(payload),
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "71b-fedstate-guard");
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
  });

  it("an unreferenced salon: federalState changes, 200, exactly one audited UPDATE with old/new state", async () => {
    const salon = await createTestSalon(app.prisma, data.tenant.id, {
      name: "Unreferenziert",
      federalState: "NIEDERSACHSEN",
    });

    const res = await patchSalon(data.adminToken, salon.id, { federalState: "BAYERN" });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    expect(JSON.parse(res.body).federalState).toBe("BAYERN");

    const fresh = await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } });
    expect(fresh.federalState).toBe("BAYERN");

    const audits = await app.prisma.auditLog.findMany({
      where: { action: "UPDATE", entity: "Salon", entityId: salon.id },
    });
    expect(audits.length).toBe(1);
    expect((audits[0].oldValue as { federalState?: string } | null)?.federalState).toBe(
      "NIEDERSACHSEN",
    );
    expect((audits[0].newValue as { federalState?: string } | null)?.federalState).toBe("BAYERN");
  });

  it("with an EmployeeSalonAssignment (including an ENDED or VOIDED one) → 409 FEDERAL_STATE_IN_USE, state unchanged, no UPDATE audit", async () => {
    const salon = await createTestSalon(app.prisma, data.tenant.id, {
      name: "Mit Zuordnung",
      federalState: "NIEDERSACHSEN",
    });
    // An ENDED assignment (validUntil in the past) — still history against this salon.
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: data.employee.id,
        salonId: salon.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2020-01-01"),
        validUntil: new Date("2020-01-31"),
        weekdays: [],
      },
    });

    const res = await patchSalon(data.adminToken, salon.id, { federalState: "BAYERN" });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ code: "FEDERAL_STATE_IN_USE" });

    const fresh = await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } });
    expect(fresh.federalState).toBe("NIEDERSACHSEN");

    const audits = await app.prisma.auditLog.count({
      where: { action: "UPDATE", entity: "Salon", entityId: salon.id },
    });
    expect(audits).toBe(0);

    // A VOIDED row (validUntil = validFrom - 1 day, D-03) blocks the change just as much.
    const salon2 = await createTestSalon(app.prisma, data.tenant.id, {
      name: "Mit voider Zuordnung",
      federalState: "NIEDERSACHSEN",
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: data.employee.id,
        salonId: salon2.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2026-03-02"),
        validUntil: new Date("2026-03-01"),
        weekdays: [],
      },
    });
    const res2 = await patchSalon(data.adminToken, salon2.id, { federalState: "BAYERN" });
    expect(res2.statusCode, res2.body.slice(0, 400)).toBe(409);
    expect(JSON.parse(res2.body)).toMatchObject({ code: "FEDERAL_STATE_IN_USE" });
  });

  it("with a TimeEntry (including a soft-deleted one) → 409 FEDERAL_STATE_IN_USE", async () => {
    const salon = await createTestSalon(app.prisma, data.tenant.id, {
      name: "Mit Zeiteintrag",
      federalState: "NIEDERSACHSEN",
    });
    await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        salonId: salon.id,
        date: new Date("2026-01-05T00:00:00Z"),
        startTime: new Date("2026-01-05T08:00:00Z"),
        endTime: new Date("2026-01-05T16:00:00Z"),
        breakMinutes: 30,
        deletedAt: new Date(),
      },
    });

    const res = await patchSalon(data.adminToken, salon.id, { federalState: "BAYERN" });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ code: "FEDERAL_STATE_IN_USE" });

    const fresh = await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } });
    expect(fresh.federalState).toBe("NIEDERSACHSEN");
  });

  it("the SAME state as already stored on a referenced salon is a no-op, not a move: 200", async () => {
    const salon = await createTestSalon(app.prisma, data.tenant.id, {
      name: "Gleicher Zustand",
      federalState: "NIEDERSACHSEN",
    });
    await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        salonId: salon.id,
        date: new Date("2026-01-06T00:00:00Z"),
        startTime: new Date("2026-01-06T08:00:00Z"),
        endTime: new Date("2026-01-06T16:00:00Z"),
        breakMinutes: 30,
      },
    });

    const res = await patchSalon(data.adminToken, salon.id, { federalState: "NIEDERSACHSEN" });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
  });

  it("{ name } only on a referenced salon succeeds: the guard is about the STATE, not the salon", async () => {
    const salon = await createTestSalon(app.prisma, data.tenant.id, {
      name: "Nur Name geändert",
      federalState: "NIEDERSACHSEN",
    });
    await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        salonId: salon.id,
        date: new Date("2026-01-07T00:00:00Z"),
        startTime: new Date("2026-01-07T08:00:00Z"),
        endTime: new Date("2026-01-07T16:00:00Z"),
        breakMinutes: 30,
      },
    });

    const res = await patchSalon(data.adminToken, salon.id, { name: "Neuer Name" });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    expect(JSON.parse(res.body).name).toBe("Neuer Name");
  });

  it("an invalid federalState 400s", async () => {
    const salon = await createTestSalon(app.prisma, data.tenant.id, { name: "Ungültig" });
    const res = await patchSalon(data.adminToken, salon.id, { federalState: "ATLANTIS" });
    expect(res.statusCode).toBe(400);
  });

  it("a foreign salon still gets the shared byte-identical 404 (T-100-09 unchanged by D-12)", async () => {
    const foreign = await seedTestData(app, "71b-fedstate-guard-foreign");
    try {
      const res = await patchSalon(foreign.adminToken, data.salonId!, { federalState: "BAYERN" });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: "Salon nicht gefunden" });
    } finally {
      await cleanupTestData(app, foreign.tenant.id);
    }
  });

  it("structural pin (D-12): updateSalon takes the FOR UPDATE lock before counting either reference", () => {
    const file = join(__dirname, "..", "contexts", "platform", "facade", "salons.ts");
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const fn = sf.statements.find(
      (s): s is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(s) && s.name?.text === "updateSalon",
    );
    expect(fn?.body, "updateSalon not found in facade/salons.ts").toBeDefined();
    const body = fn!.body!.getText(sf);

    const lockIndex = body.indexOf("FOR UPDATE");
    const assignmentCountIndex = body.indexOf("employeeSalonAssignment.count");
    const timeEntryCountIndex = body.indexOf("countTimeEntriesForSalon(");

    expect(lockIndex, "FOR UPDATE lock not found in updateSalon's body").toBeGreaterThan(-1);
    expect(assignmentCountIndex, "employeeSalonAssignment.count(...) not found").toBeGreaterThan(
      -1,
    );
    expect(timeEntryCountIndex, "countTimeEntriesForSalon(...) not found").toBeGreaterThan(-1);
    expect(lockIndex).toBeLessThan(assignmentCountIndex);
    expect(lockIndex).toBeLessThan(timeEntryCountIndex);
  });
});
