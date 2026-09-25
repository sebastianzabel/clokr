/**
 * Phase 71b Plan 06 (issue #71, D-09/D-10/D-11/AC-7/AC-13) — `GET`/`POST /api/v1/holidays` become
 * salon-aware: manual holidays now belong to a salon (D-02), and the route resolves the salon
 * itself instead of the tenant's federal state.
 *
 * `salonId` is pinned HERE rather than in `lint-t100-09-routes.json` because it is
 * query/body-carried, not a `:param` — that register covers path parameters only (the precedent
 * is the `DELETE /api/v1/integrations/phorest/couplings/:salonId` entry, whose OTHER,
 * body/query-carried salon routes are pinned in their own API tests the same way).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";

function getHolidays(app: FastifyInstance, token: string, query: string) {
  return app.inject({
    method: "GET",
    url: `/api/v1/holidays${query}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

function postHoliday(app: FastifyInstance, token: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/v1/holidays",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });
}

function deleteHoliday(app: FastifyInstance, token: string, id: string) {
  return app.inject({
    method: "DELETE",
    url: `/api/v1/holidays/${id}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("Single-salon tenant: GET/POST /api/v1/holidays default to it (D-09)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "hps-single");
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
  });

  it("GET without salonId 200s with the default salon's calendar", async () => {
    const res = await getHolidays(app, data.adminToken, "?year=2026");
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    const body = JSON.parse(res.body) as Array<{ isManual: boolean; salonId: string }>;
    expect(body.length).toBeGreaterThan(0);
    for (const entry of body) expect(entry.salonId).toBe(data.salonId);
  });

  it("POST without salonId 201s, row lands on the default salon, and audits salonId (D-11)", async () => {
    const res = await postHoliday(app, data.adminToken, {
      date: "2025-11-20",
      name: "Testfeiertag Single",
    });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.salonId).toBe(data.salonId);

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "CREATE", entity: "PublicHoliday", entityId: body.id },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect((audit?.newValue as { salonId?: string } | null)?.salonId).toBe(data.salonId);
  });
});

describe("Two-salon tenant: SALON_REQUIRED, per-salon manual holidays, byte-identical T-100-09 (D-09/D-10)", () => {
  let app: FastifyInstance;
  let data: Omit<Awaited<ReturnType<typeof seedTestData>>, "salonId"> & { salonId: string | null };
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  const unknownId = "00000000-0000-4000-8000-000000000042";

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "hps-two", { withDefaultSalon: false });
    foreign = await seedTestData(app, "hps-foreign");

    salonA = await createTestSalon(app.prisma, data.tenant.id, {
      name: "Salon A (Bayern)",
      federalState: "BAYERN",
    });
    salonB = await createTestSalon(app.prisma, data.tenant.id, {
      name: "Salon B (Niedersachsen)",
      federalState: "NIEDERSACHSEN",
    });
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await cleanupTestData(app, foreign.tenant.id);
  });

  // D-09 REVISED (coordinator decision, 2026-09-25): a read must not require a salon. GET without
  // `salonId` on a multi-salon tenant no longer 400s — it returns the concatenated calendars of
  // every active salon, each item carrying its own `salonId`. WRITES are unchanged (still require
  // `salonId` on a multi-salon tenant, 400 SALON_REQUIRED).
  it("GET without salonId 200s with both salons' calendars, each item tagged with its salonId (D-09 revised)", async () => {
    const getRes = await getHolidays(app, data.adminToken, "?year=2026");
    expect(getRes.statusCode, getRes.body.slice(0, 400)).toBe(200);
    const body = JSON.parse(getRes.body) as Array<{ date: string; salonId: string }>;
    const salonIdsSeen = new Set(body.map((e) => e.salonId));
    expect(salonIdsSeen).toEqual(new Set([salonA.id, salonB.id]));
    // Fronleichnam is Bavaria-only — must appear tagged with salonA, not salonB.
    const fronleichnamEntries = body.filter((e) => e.date === "2026-06-04");
    expect(fronleichnamEntries.map((e) => e.salonId)).toEqual([salonA.id]);
  });

  it("POST without salonId still 400 SALON_REQUIRED (writes unchanged by D-09)", async () => {
    const postRes = await postHoliday(app, data.adminToken, {
      date: "2026-07-01",
      name: "Ohne Salon",
    });
    expect(postRes.statusCode).toBe(400);
    expect(JSON.parse(postRes.body)).toEqual({
      error: "Bitte einen Salon angeben — der Mandant hat mehrere aktive Salons.",
      code: "SALON_REQUIRED",
    });
  });

  it("AC-7: Fronleichnam (2026-06-04) shows for the Bavarian salon only", async () => {
    const resA = await getHolidays(app, data.adminToken, `?year=2026&salonId=${salonA.id}`);
    expect(resA.statusCode, resA.body.slice(0, 400)).toBe(200);
    const bodyA = JSON.parse(resA.body) as Array<{ date: string; name: string; isManual: boolean }>;
    const fronA = bodyA.find((e) => e.date === "2026-06-04");
    expect(fronA?.name).toBe("Fronleichnam");
    expect(fronA?.isManual).toBe(false);

    const resB = await getHolidays(app, data.adminToken, `?year=2026&salonId=${salonB.id}`);
    expect(resB.statusCode, resB.body.slice(0, 400)).toBe(200);
    const bodyB = JSON.parse(resB.body) as Array<{ date: string }>;
    expect(bodyB.find((e) => e.date === "2026-06-04")).toBeUndefined();
  });

  it("AC-7: a manual holiday posted for salon A does not leak into salon B; the same date is free for B too", async () => {
    const postA = await postHoliday(app, data.adminToken, {
      date: "2026-06-10",
      name: "Stadtfest A",
      salonId: salonA.id,
    });
    expect(postA.statusCode, postA.body.slice(0, 400)).toBe(201);
    const holidayA = JSON.parse(postA.body);
    expect(holidayA.salonId).toBe(salonA.id);
    expect(holidayA.isManual).toBe(true);

    const resAAfter = await getHolidays(app, data.adminToken, `?year=2026&salonId=${salonA.id}`);
    const bodyAAfter = JSON.parse(resAAfter.body) as Array<{
      date: string;
      isManual: boolean;
      salonId: string;
    }>;
    const entryA = bodyAAfter.find((e) => e.date === "2026-06-10");
    expect(entryA?.isManual).toBe(true);
    expect(entryA?.salonId).toBe(salonA.id);

    const resBAfter = await getHolidays(app, data.adminToken, `?year=2026&salonId=${salonB.id}`);
    const bodyBAfter = JSON.parse(resBAfter.body) as Array<{ date: string }>;
    expect(bodyBAfter.find((e) => e.date === "2026-06-10")).toBeUndefined();

    // Uniqueness is per salon, not per tenant — the same date on salon B is a separate row.
    const postB = await postHoliday(app, data.adminToken, {
      date: "2026-06-10",
      name: "Stadtfest B",
      salonId: salonB.id,
    });
    expect(postB.statusCode, postB.body.slice(0, 400)).toBe(201);
    expect(JSON.parse(postB.body).salonId).toBe(salonB.id);
  });

  it("T-100-09: a foreign tenant's real salon and a nonexistent salon answer byte-identical status+body on GET and POST, and POST writes nothing", async () => {
    const holidaysBeforeA = await app.prisma.publicHoliday.count({ where: { salonId: salonA.id } });
    const holidaysBeforeForeign = await app.prisma.publicHoliday.count({
      where: { tenantId: foreign.tenant.id },
    });
    const auditCountBefore = await app.prisma.auditLog.count({
      where: { action: "CREATE", entity: "PublicHoliday" },
    });

    // salonA belongs to `data`, not `foreign` — from foreign's own admin token it is a foreign
    // tenant's real salon; the same token against an id that exists nowhere must answer
    // byte-identically.
    const getForeignRes = await getHolidays(
      app,
      foreign.adminToken,
      `?year=2026&salonId=${salonA.id}`,
    );
    const getUnknownRes = await getHolidays(
      app,
      foreign.adminToken,
      `?year=2026&salonId=${unknownId}`,
    );
    expect(getForeignRes.statusCode).toBe(getUnknownRes.statusCode);
    expect(getForeignRes.body).toBe(getUnknownRes.body);
    expect(getForeignRes.statusCode).toBe(404);
    expect(JSON.parse(getForeignRes.body)).toEqual({ error: "Salon nicht gefunden" });

    const postForeignRes = await postHoliday(app, foreign.adminToken, {
      date: "2026-08-01",
      name: "T-100-09 Foreign",
      salonId: salonA.id,
    });
    const postUnknownRes = await postHoliday(app, foreign.adminToken, {
      date: "2026-08-01",
      name: "T-100-09 Unknown",
      salonId: unknownId,
    });
    expect(postForeignRes.statusCode).toBe(postUnknownRes.statusCode);
    expect(postForeignRes.body).toBe(postUnknownRes.body);
    expect(postForeignRes.statusCode).toBe(404);
    expect(JSON.parse(postForeignRes.body)).toEqual({ error: "Salon nicht gefunden" });

    const holidaysAfterA = await app.prisma.publicHoliday.count({ where: { salonId: salonA.id } });
    const holidaysAfterForeign = await app.prisma.publicHoliday.count({
      where: { tenantId: foreign.tenant.id },
    });
    expect(holidaysAfterA).toBe(holidaysBeforeA);
    expect(holidaysAfterForeign).toBe(holidaysBeforeForeign);

    const auditCountAfter = await app.prisma.auditLog.count({
      where: { action: "CREATE", entity: "PublicHoliday" },
    });
    expect(auditCountAfter).toBe(auditCountBefore);
  });

  it("DELETE keeps its current 404-for-foreign-id behavior unchanged, and the DELETE audit carries salonId (D-10/D-11)", async () => {
    const created = await postHoliday(app, data.adminToken, {
      date: "2026-09-15",
      name: "Zu löschen",
      salonId: salonA.id,
    });
    expect(created.statusCode, created.body.slice(0, 400)).toBe(201);
    const holidayId = JSON.parse(created.body).id;

    const foreignDelete = await deleteHoliday(app, foreign.adminToken, holidayId);
    expect(foreignDelete.statusCode).toBe(404);
    expect(JSON.parse(foreignDelete.body)).toEqual({ error: "Feiertag nicht gefunden" });

    const ownDelete = await deleteHoliday(app, data.adminToken, holidayId);
    expect(ownDelete.statusCode).toBe(204);

    const auditLog = await app.prisma.auditLog.findFirst({
      where: { action: "DELETE", entity: "PublicHoliday", entityId: holidayId },
      orderBy: { createdAt: "desc" },
    });
    expect(auditLog).not.toBeNull();
    expect((auditLog?.oldValue as { salonId?: string } | null)?.salonId).toBe(salonA.id);
  });

  it("an explicitly named INACTIVE own salon is still accepted by GET (history stays readable)", async () => {
    const inactiveSalon = await createTestSalon(app.prisma, data.tenant.id, {
      name: "Ehemaliger Salon",
      federalState: "NIEDERSACHSEN",
      isActive: false,
    });
    const res = await getHolidays(app, data.adminToken, `?year=2026&salonId=${inactiveSalon.id}`);
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
  });

  it("company Christmas Eve rule stays tenant-wide across both salons; a manual holiday on the same day wins over it", async () => {
    await app.prisma.tenantConfig.upsert({
      where: { tenantId: data.tenant.id },
      update: { christmasEveRule: "FULL_DAY_OFF", holidayRulesValidFromYear: 2020 },
      create: {
        tenantId: data.tenant.id,
        christmasEveRule: "FULL_DAY_OFF",
        holidayRulesValidFromYear: 2020,
      },
    });

    const resA = await getHolidays(app, data.adminToken, `?year=2026&salonId=${salonA.id}`);
    const resB = await getHolidays(app, data.adminToken, `?year=2026&salonId=${salonB.id}`);
    const bodyA = JSON.parse(resA.body) as Array<{ date: string; name: string; isManual: boolean }>;
    const bodyB = JSON.parse(resB.body) as Array<{ date: string; name: string; isManual: boolean }>;
    expect(bodyA.find((e) => e.date === "2026-12-24")?.name).toBe("Heiligabend (frei)");
    expect(bodyB.find((e) => e.date === "2026-12-24")?.name).toBe("Heiligabend (frei)");

    const postManual = await postHoliday(app, data.adminToken, {
      date: "2026-12-24",
      name: "Manuell schließt an Heiligabend",
      salonId: salonA.id,
    });
    expect(postManual.statusCode, postManual.body.slice(0, 400)).toBe(201);

    const resAAfter = await getHolidays(app, data.adminToken, `?year=2026&salonId=${salonA.id}`);
    const bodyAAfter = JSON.parse(resAAfter.body) as Array<{
      date: string;
      name: string;
      isManual: boolean;
    }>;
    const entry = bodyAAfter.find((e) => e.date === "2026-12-24");
    expect(entry?.isManual).toBe(true);
    expect(entry?.name).toBe("Manuell schließt an Heiligabend");
  });
});

/**
 * AC-13 — a manual holiday posted into a period whose month is already closed and locked must
 * leave that month's `SaldoSnapshot` byte-identical: `recalculateSnapshots` skips locked months
 * (research A5), and this proves the salon-aware POST path still goes through it unchanged.
 */
describe("AC-13: POST /api/v1/holidays into a closed, locked month leaves its SaldoSnapshot untouched", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // A fixed "now" safely after June 2026, so June can be closed while the token is still valid.
  const PINNED_NOW = new Date("2026-07-16T10:00:00.000Z");

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "hps-locked");

    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { hireDate: new Date("2026-06-01T00:00:00Z") },
    });

    for (const d of ["2026-06-01", "2026-06-02", "2026-06-03"]) {
      await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          salonId: data.salonId!,
          date: new Date(`${d}T00:00:00Z`),
          startTime: new Date(`${d}T08:00:00Z`),
          endTime: new Date(`${d}T16:00:00Z`),
          breakMinutes: 30,
        },
      });
    }

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PINNED_NOW);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/overtime/close-month",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { employeeId: data.employee.id, year: 2026, month: 6, confirmGaps: true },
      });
      expect(res.statusCode, res.body).toBe(201);
    } finally {
      vi.useRealTimers();
    }
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
  });

  it("SaldoSnapshot for June 2026 is byte-identical before and after the POST", async () => {
    // periodStart is not literally "2026-06-01" — closeEmployeeMonth's month-bounds helper casts
    // the lower bound to the previous day for a UTC+ tenant (CLAUDE.md "Testing" note) — so this
    // reads by employeeId alone and pins the count instead of a periodStart literal.
    const before = await app.prisma.saldoSnapshot.findMany({
      where: { employeeId: data.employee.id },
      orderBy: { id: "asc" },
    });
    expect(before.length).toBeGreaterThan(0);

    const res = await postHoliday(app, data.adminToken, {
      date: "2026-06-17",
      name: "Nachtrag in gesperrtem Monat",
      salonId: data.salonId,
    });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(201);

    const after = await app.prisma.saldoSnapshot.findMany({
      where: { employeeId: data.employee.id },
      orderBy: { id: "asc" },
    });
    expect(after).toEqual(before);
  });
});
