/**
 * Phase 71b Plan 06 (issue #71), D-13/AC-18 — `PUT /api/v1/settings/work` changing
 * `Tenant.federalState` must NOT touch any `Salon.federalState` or any `PublicHoliday` row. Mirrors
 * `settings-store-hours-salon-mirror.test.ts`'s structure with the OPPOSITE expectation: that file
 * proves a `storeHours` write DOES mirror into a salon; this one proves `federalState` never does.
 *
 * `seedTestData()` does not create a Salon here — this file opts out via `{ withDefaultSalon:
 * false }`, matching the mirror test's own convention, and builds its own two-salon topology.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import type { FastifyInstance } from "fastify";

function putWork(app: FastifyInstance, token: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "PUT",
    url: "/api/v1/settings/work",
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

describe("PUT /api/v1/settings/work — D-13 federalState does not leak into Salon/PublicHoliday", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  it("Tenant.federalState changes; both salons and both manual holidays stay byte-identical; no Salon audit row from this call; a salon created afterwards without a state inherits the NEW tenant state", async () => {
    const data = await seedTestData(app, "fedstate-no-leak", { withDefaultSalon: false });
    try {
      const salonNi = await createTestSalon(app.prisma, data.tenant.id, {
        name: "Niedersachsen-Salon",
        federalState: "NIEDERSACHSEN",
      });
      const salonHh = await createTestSalon(app.prisma, data.tenant.id, {
        name: "Hamburg-Salon",
        federalState: "HAMBURG",
      });

      const holidayNi = await app.prisma.publicHoliday.create({
        data: {
          tenantId: data.tenant.id,
          salonId: salonNi.id,
          date: new Date("2026-05-01T00:00:00Z"),
          name: "NI Testfeiertag",
          federalState: "NIEDERSACHSEN",
          year: 2026,
        },
      });
      const holidayHh = await app.prisma.publicHoliday.create({
        data: {
          tenantId: data.tenant.id,
          salonId: salonHh.id,
          date: new Date("2026-05-02T00:00:00Z"),
          name: "HH Testfeiertag",
          federalState: "HAMBURG",
          year: 2026,
        },
      });

      const salonNiBefore = await app.prisma.salon.findUniqueOrThrow({ where: { id: salonNi.id } });
      const salonHhBefore = await app.prisma.salon.findUniqueOrThrow({ where: { id: salonHh.id } });
      const holidayNiBefore = await app.prisma.publicHoliday.findUniqueOrThrow({
        where: { id: holidayNi.id },
      });
      const holidayHhBefore = await app.prisma.publicHoliday.findUniqueOrThrow({
        where: { id: holidayHh.id },
      });
      const salonAuditCountBefore = await app.prisma.auditLog.count({
        where: { entity: "Salon", entityId: { in: [salonNi.id, salonHh.id] } },
      });

      const res = await putWork(app, data.adminToken, { federalState: "BAYERN" });
      expect(res.statusCode, res.body.slice(0, 400)).toBe(200);

      const tenant = await app.prisma.tenant.findUniqueOrThrow({ where: { id: data.tenant.id } });
      expect(tenant.federalState).toBe("BAYERN");

      const salonNiAfter = await app.prisma.salon.findUniqueOrThrow({ where: { id: salonNi.id } });
      const salonHhAfter = await app.prisma.salon.findUniqueOrThrow({ where: { id: salonHh.id } });
      expect(salonNiAfter).toEqual(salonNiBefore);
      expect(salonHhAfter).toEqual(salonHhBefore);
      expect(salonNiAfter.federalState).toBe("NIEDERSACHSEN");
      expect(salonHhAfter.federalState).toBe("HAMBURG");

      const holidayNiAfter = await app.prisma.publicHoliday.findUniqueOrThrow({
        where: { id: holidayNi.id },
      });
      const holidayHhAfter = await app.prisma.publicHoliday.findUniqueOrThrow({
        where: { id: holidayHh.id },
      });
      expect(holidayNiAfter).toEqual(holidayNiBefore);
      expect(holidayHhAfter).toEqual(holidayHhBefore);

      const salonAuditCountAfter = await app.prisma.auditLog.count({
        where: { entity: "Salon", entityId: { in: [salonNi.id, salonHh.id] } },
      });
      expect(salonAuditCountAfter).toBe(salonAuditCountBefore);

      // D-01 closure: a salon created AFTER this PUT, without an explicit state, inherits the
      // tenant's NEW federalState (BAYERN) — the tenant value is still the DEFAULT a new salon
      // inherits, just never something an EXISTING salon's own state mirrors.
      const postRes = await app.inject({
        method: "POST",
        url: "/api/v1/salons",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          name: "Nach dem PUT angelegt",
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
      expect(postRes.statusCode, postRes.body.slice(0, 400)).toBe(201);
      expect(JSON.parse(postRes.body).federalState).toBe("BAYERN");
    } finally {
      await cleanupTestData(app, data.tenant.id);
    }
  });
});
