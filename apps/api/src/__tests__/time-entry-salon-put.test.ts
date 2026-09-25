/**
 * Phase 68b Plan 02, Task 3 (issue #68, D-12/D-15) — PUT /time-entries/:id may change the
 * salon: a different salon is validated per D-07, a locked entry rejects it like any other
 * change, the same value is an accepted no-op even if now inactive, a date/time change never
 * re-derives the salon, a rejection leaves the Break rows and every other field untouched, and
 * the existing audit carries old/new salonId automatically.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { addDaysStr, mondayOfWeekStr, pastDateStr } from "./test-dates";

describe("PUT /time-entries/:id salon change (Phase 68b, issue #68, D-12/D-15)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  const ghost = randomUUID();

  let salonA: { id: string };
  let salonB: { id: string };
  let salonC: { id: string };
  let salonX: { id: string };

  const baseMonday = addDaysStr(mondayOfWeekStr(), -7);
  const mondayWeeksAgo = (n: number) => addDaysStr(baseMonday, -7 * (n - 1));

  function iso(dateStr: string, hhmm: string): string {
    return `${dateStr}T${hhmm}:00.000Z`;
  }

  async function createEntry(
    dateStr: string,
    overrides: { salonId?: string; isLocked?: boolean; note?: string | null } = {},
  ) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId: seed.employee.id,
        date: new Date(dateStr),
        startTime: new Date(iso(dateStr, "08:00")),
        endTime: new Date(iso(dateStr, "16:00")),
        breakMinutes: 30,
        source: "MANUAL",
        salonId: overrides.salonId ?? salonA.id,
        isLocked: overrides.isLocked ?? false,
        note: overrides.note ?? null,
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "tes-put"); // seed.salonId = the tenant's default salon (D)
    foreign = await seedTestData(app, "tes-put-foreign"); // foreign.salonId = F

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
  });

  afterAll(async () => {
    for (const t of [seed, foreign]) {
      try {
        await cleanupTestData(app, t.tenant.id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  it("D-12: ADMIN correction changes the salon from A to C, MANAGER_CORRECTION audit carries old A / new C", async () => {
    const dateStr = mondayWeeksAgo(1);
    const entry = await createEntry(dateStr, { salonId: salonA.id });
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/time-entries/${entry.id}`,
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: { salonId: salonC.id, reason: "68b-02 salon change" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { entry: { salonId: string } };
    expect(body.entry.salonId).toBe(salonC.id);

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "MANAGER_CORRECTION", entity: "TimeEntry", entityId: entry.id },
      orderBy: { createdAt: "desc" },
    });
    expect((audit?.oldValue as { salonId?: string } | null)?.salonId).toBe(salonA.id);
    expect((audit?.newValue as { salonId?: string } | null)?.salonId).toBe(salonC.id);
  });

  it("D-12: a locked entry rejects the salon change like any other change, 403, salon unchanged", async () => {
    const dateStr = mondayWeeksAgo(2);
    const entry = await createEntry(dateStr, { salonId: salonA.id, isLocked: true });
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/time-entries/${entry.id}`,
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: { salonId: salonC.id, reason: "68b-02 locked" },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: "Eintrag ist gesperrt und kann nicht bearbeitet werden",
    });

    const after = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
    expect(after?.salonId).toBe(salonA.id);
  });

  it("D-07/D-12: a different, inactive salon (X) is rejected with 400 SALON_INACTIVE, unchanged", async () => {
    const dateStr = mondayWeeksAgo(3);
    const entry = await createEntry(dateStr, { salonId: salonA.id });
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/time-entries/${entry.id}`,
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: { salonId: salonX.id, reason: "68b-02 inactive" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "Salon ist deaktiviert",
      code: "SALON_INACTIVE",
    });

    const after = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
    expect(after?.salonId).toBe(salonA.id);
  });

  it("T-100-09 + D-10 zero-state: a foreign salon and a nonexistent id answer byte-identical 404, Break rows and note untouched", async () => {
    const dateStr = mondayWeeksAgo(4);
    const entry = await createEntry(dateStr, { salonId: salonA.id, note: "original note" });
    const originalBreak = await app.prisma.break.create({
      data: {
        timeEntryId: entry.id,
        startTime: new Date(iso(dateStr, "11:00")),
        endTime: new Date(iso(dateStr, "11:30")),
      },
    });

    const payloadFor = (salonId: string) => ({
      salonId,
      note: "changed note — must not persist",
      breaks: [{ startTime: iso(dateStr, "12:00"), endTime: iso(dateStr, "12:45") }],
      reason: "68b-02 T-100-09",
    });

    const foreignRes = await app.inject({
      method: "PUT",
      url: `/api/v1/time-entries/${entry.id}`,
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: payloadFor(foreign.salonId),
    });
    expect(foreignRes.statusCode).toBe(404);

    const afterForeign = await app.prisma.timeEntry.findUnique({
      where: { id: entry.id },
      include: { breaks: true },
    });
    expect(afterForeign?.salonId).toBe(salonA.id);
    expect(afterForeign?.note).toBe("original note");
    expect(afterForeign?.breaks).toHaveLength(1);
    expect(afterForeign?.breaks[0].id).toBe(originalBreak.id);
    expect(afterForeign?.breaks[0].startTime.toISOString()).toBe(
      originalBreak.startTime.toISOString(),
    );
    expect(afterForeign?.breaks[0].endTime.toISOString()).toBe(originalBreak.endTime.toISOString());

    const ghostRes = await app.inject({
      method: "PUT",
      url: `/api/v1/time-entries/${entry.id}`,
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: payloadFor(ghost),
    });
    expect(ghostRes.statusCode).toBe(404);
    expect(foreignRes.body).toBe(ghostRes.body);
    expect(foreignRes.body).toBe('{"error":"Salon nicht gefunden"}');

    const afterGhost = await app.prisma.timeEntry.findUnique({
      where: { id: entry.id },
      include: { breaks: true },
    });
    expect(afterGhost?.salonId).toBe(salonA.id);
    expect(afterGhost?.note).toBe("original note");
    expect(afterGhost?.breaks).toHaveLength(1);
    expect(afterGhost?.breaks[0].id).toBe(originalBreak.id);
  });

  it("D-15: re-sending the current salon (A) is an accepted no-op even after A has since been deactivated", async () => {
    const dateStr = mondayWeeksAgo(5);
    const entry = await createEntry(dateStr, { salonId: salonA.id });

    await app.prisma.salon.update({
      where: { id: salonA.id },
      data: { isActive: false, deactivatedAt: new Date() },
    });
    try {
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/time-entries/${entry.id}`,
        headers: { authorization: `Bearer ${seed.adminToken}` },
        payload: { salonId: salonA.id, note: "resend same salon", reason: "68b-02 no-op" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { entry: { salonId: string } };
      expect(body.entry.salonId).toBe(salonA.id);

      const getRes = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?employeeId=${seed.employee.id}&from=${dateStr}&to=${dateStr}`,
        headers: { authorization: `Bearer ${seed.adminToken}` },
      });
      const entries = JSON.parse(getRes.body) as { id: string; salonId: string }[];
      expect(entries.find((e) => e.id === entry.id)?.salonId).toBe(salonA.id);

      // A note-only PUT (no salonId field at all) must also succeed and leave the salon as-is.
      const noteOnlyRes = await app.inject({
        method: "PUT",
        url: `/api/v1/time-entries/${entry.id}`,
        headers: { authorization: `Bearer ${seed.adminToken}` },
        payload: { note: "note-only edit", reason: "68b-02 note-only" },
      });
      expect(noteOnlyRes.statusCode).toBe(200);
      const noteOnlyBody = JSON.parse(noteOnlyRes.body) as { entry: { salonId: string } };
      expect(noteOnlyBody.entry.salonId).toBe(salonA.id);
    } finally {
      await app.prisma.salon.update({
        where: { id: salonA.id },
        data: { isActive: true, deactivatedAt: null },
      });
    }
  });

  it("D-12: moving the entry from Monday (A) to Thursday never re-derives the salon, although salonForDay would now say B", async () => {
    const dateStr = mondayWeeksAgo(6);
    const thursdayStr = addDaysStr(dateStr, 3);
    const entry = await createEntry(dateStr, { salonId: salonA.id });

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/time-entries/${entry.id}`,
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        date: thursdayStr,
        startTime: iso(thursdayStr, "08:00"),
        endTime: iso(thursdayStr, "16:00"),
        reason: "68b-02 no re-home",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { entry: { salonId: string; date: string } };
    expect(body.entry.salonId).toBe(salonA.id);
  });

  it("D-07/D-12: an EMPLOYEE editing their own entry inside the retro window with an explicit salon of their tenant is stored", async () => {
    const dateStr = pastDateStr(2);
    const entry = await createEntry(dateStr, { salonId: salonA.id });

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/time-entries/${entry.id}`,
      headers: { authorization: `Bearer ${seed.empToken}` },
      payload: { salonId: salonC.id },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { entry: { salonId: string } };
    expect(body.entry.salonId).toBe(salonC.id);
  });

  it("D-07: a sent salonId:null is rejected with 400 Validierungsfehler (null is deliberately not accepted), unchanged", async () => {
    const dateStr = mondayWeeksAgo(7);
    const entry = await createEntry(dateStr, { salonId: salonA.id });

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/time-entries/${entry.id}`,
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: { salonId: null, reason: "68b-02 null" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("Validierungsfehler");

    const after = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
    expect(after?.salonId).toBe(salonA.id);
  });
});
