/**
 * Phase 64b Plan 04 (issue #64, D-16/D-17) — `PUT /api/v1/settings/work`'s `storeHours` write now
 * mirrors into a tenant's SOLE active salon, atomically and audited, while leaving a multi-salon
 * tenant's salons alone and never renaming a salon via `tenantName`.
 *
 * `seedTestData()` does not create a Salon here — this file opts out via
 * `{ withDefaultSalon: false }` (Phase 325, issue #325, D-17) — every fixture salon this file
 * needs is created directly via `app.prisma.salon.create(...)`, matching `salons.test.ts`'s own
 * pattern.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { DEFAULT_SALON_OPENING_HOURS } from "../contexts/platform/facade/salons";
import type { FastifyInstance } from "fastify";

// Differs from DEFAULT_SALON_OPENING_HOURS in exactly one field (day 0's `closed`), so any test
// that mirrors this in should observe a real, non-vacuous change.
const DAY0_CLOSED = DEFAULT_SALON_OPENING_HOURS.map((d, i) =>
  i === 0 ? { ...d, closed: true } : d,
);

// Legal under the pre-64b legacy storeHours schema (7 entries, `HH:MM` format), rejected by the
// Salon facade's stricter salonOpeningHoursSchema (open >= close on an open day) — the shape a
// tenant's stored hours can already have, and that the admin UI sends back unchanged (WR-03).
const OPEN_GTE_CLOSE = DEFAULT_SALON_OPENING_HOURS.map((d, i) =>
  i === 0 ? { ...d, open: "20:00", close: "08:00", closed: false } : d,
);

// Invalid even under the legacy schema (6 entries instead of 7).
const SIX_DAYS = DEFAULT_SALON_OPENING_HOURS.slice(0, 6);

async function putWork(app: FastifyInstance, token: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "PUT",
    url: "/api/v1/settings/work",
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

describe("PUT /api/v1/settings/work — D-16 storeHours <-> salon mirror", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  it("one active salon + storeHours with day 0 closed: salon.openingHours updates, exactly one audited UPDATE Salon row", async () => {
    const data = await seedTestData(app, "sh-mirror-one", { withDefaultSalon: false });
    try {
      const salon = await app.prisma.salon.create({
        data: {
          tenantId: data.tenant.id,
          name: "Einziger Salon",
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: true,
        },
      });

      const res = await putWork(app, data.adminToken, { storeHours: DAY0_CLOSED });
      expect(res.statusCode, res.body.slice(0, 400)).toBe(200);

      const updated = await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } });
      expect(updated.openingHours).toEqual(DAY0_CLOSED);

      const audits = await app.prisma.auditLog.findMany({
        where: { action: "UPDATE", entity: "Salon", entityId: salon.id },
      });
      expect(audits.length).toBe(1);
      const [audit] = audits;
      expect((audit.oldValue as { openingHours: unknown }).openingHours).toEqual(
        DEFAULT_SALON_OPENING_HOURS,
      );
      expect((audit.newValue as { openingHours: unknown }).openingHours).toEqual(DAY0_CLOSED);

      // Same PUT again (identical hours) -> no additional Salon UPDATE audit row.
      const res2 = await putWork(app, data.adminToken, { storeHours: DAY0_CLOSED });
      expect(res2.statusCode, res2.body.slice(0, 400)).toBe(200);
      const auditsAfter = await app.prisma.auditLog.findMany({
        where: { action: "UPDATE", entity: "Salon", entityId: salon.id },
      });
      expect(auditsAfter.length).toBe(1);
    } finally {
      await cleanupTestData(app, data.tenant.id);
    }
  });

  it("two active salons: storeHours leaves both salons unchanged and writes no Salon audit row; TenantConfig.storeHours is still updated", async () => {
    const data = await seedTestData(app, "sh-mirror-two", { withDefaultSalon: false });
    try {
      const salonA = await app.prisma.salon.create({
        data: {
          tenantId: data.tenant.id,
          name: "Salon A",
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: true,
        },
      });
      const salonB = await app.prisma.salon.create({
        data: {
          tenantId: data.tenant.id,
          name: "Salon B",
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: true,
        },
      });

      const res = await putWork(app, data.adminToken, { storeHours: DAY0_CLOSED });
      expect(res.statusCode, res.body.slice(0, 400)).toBe(200);

      const [freshA, freshB] = await Promise.all([
        app.prisma.salon.findUniqueOrThrow({ where: { id: salonA.id } }),
        app.prisma.salon.findUniqueOrThrow({ where: { id: salonB.id } }),
      ]);
      expect(freshA.openingHours).toEqual(DEFAULT_SALON_OPENING_HOURS);
      expect(freshB.openingHours).toEqual(DEFAULT_SALON_OPENING_HOURS);

      const audits = await app.prisma.auditLog.findMany({
        where: { action: "UPDATE", entity: "Salon", entityId: { in: [salonA.id, salonB.id] } },
      });
      expect(audits.length).toBe(0);

      const config = await app.prisma.tenantConfig.findUniqueOrThrow({
        where: { tenantId: data.tenant.id },
      });
      expect(config.storeHours).toEqual(DAY0_CLOSED);
    } finally {
      await cleanupTestData(app, data.tenant.id);
    }
  });

  it("one active + one inactive salon: the active one is mirrored, the inactive one untouched", async () => {
    const data = await seedTestData(app, "sh-mirror-mix", { withDefaultSalon: false });
    try {
      const active = await app.prisma.salon.create({
        data: {
          tenantId: data.tenant.id,
          name: "Aktiv",
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: true,
        },
      });
      const inactive = await app.prisma.salon.create({
        data: {
          tenantId: data.tenant.id,
          name: "Inaktiv",
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: false,
          deactivatedAt: new Date(),
        },
      });

      const res = await putWork(app, data.adminToken, { storeHours: DAY0_CLOSED });
      expect(res.statusCode, res.body.slice(0, 400)).toBe(200);

      const [freshActive, freshInactive] = await Promise.all([
        app.prisma.salon.findUniqueOrThrow({ where: { id: active.id } }),
        app.prisma.salon.findUniqueOrThrow({ where: { id: inactive.id } }),
      ]);
      expect(freshActive.openingHours).toEqual(DAY0_CLOSED);
      expect(freshInactive.openingHours).toEqual(DEFAULT_SALON_OPENING_HOURS);
    } finally {
      await cleanupTestData(app, data.tenant.id);
    }
  });

  it("PUT without storeHours (e.g. only overtimeThreshold) leaves the salon untouched", async () => {
    const data = await seedTestData(app, "sh-mirror-notouch", { withDefaultSalon: false });
    try {
      const salon = await app.prisma.salon.create({
        data: {
          tenantId: data.tenant.id,
          name: "Unberührt",
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: true,
        },
      });

      const res = await putWork(app, data.adminToken, { overtimeThreshold: 50 });
      expect(res.statusCode, res.body.slice(0, 400)).toBe(200);

      const fresh = await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } });
      expect(fresh.openingHours).toEqual(DEFAULT_SALON_OPENING_HOURS);

      const audits = await app.prisma.auditLog.findMany({
        where: { action: "UPDATE", entity: "Salon", entityId: salon.id },
      });
      expect(audits.length).toBe(0);
    } finally {
      await cleanupTestData(app, data.tenant.id);
    }
  });

  it("WR-02: a PUT resending the UNCHANGED tenant storeHours (e.g. only shiftStoreHoursMode changed) does not overwrite a salon edited via PATCH, and writes no Salon audit row", async () => {
    const data = await seedTestData(app, "sh-mirror-unchanged", { withDefaultSalon: false });
    try {
      const salon = await app.prisma.salon.create({
        data: {
          tenantId: data.tenant.id,
          name: "Per PATCH geändert",
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: true,
        },
      });

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/v1/salons/${salon.id}`,
        headers: { authorization: `Bearer ${data.adminToken}`, "content-type": "application/json" },
        payload: JSON.stringify({ openingHours: DAY0_CLOSED }),
      });
      expect(patchRes.statusCode, patchRes.body.slice(0, 400)).toBe(200);
      const auditsAfterPatch = await app.prisma.auditLog.count({
        where: { action: "UPDATE", entity: "Salon", entityId: salon.id },
      });
      expect(auditsAfterPatch).toBe(1);

      const configBefore = await app.prisma.tenantConfig.findUniqueOrThrow({
        where: { tenantId: data.tenant.id },
      });
      // The admin UI's save of the Öffnungszeiten section: the stored week sent back unchanged,
      // plus a changed shift mode.
      const newMode = configBefore.shiftStoreHoursMode === "OFF" ? "STRICT" : "OFF";
      const res = await putWork(app, data.adminToken, {
        storeHours: configBefore.storeHours,
        shiftStoreHoursMode: newMode,
      });
      expect(res.statusCode, res.body.slice(0, 400)).toBe(200);

      const configAfter = await app.prisma.tenantConfig.findUniqueOrThrow({
        where: { tenantId: data.tenant.id },
      });
      expect(configAfter.shiftStoreHoursMode).toBe(newMode);

      const fresh = await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } });
      expect(fresh.openingHours).toEqual(DAY0_CLOSED);

      const auditsAfterPut = await app.prisma.auditLog.count({
        where: { action: "UPDATE", entity: "Salon", entityId: salon.id },
      });
      expect(auditsAfterPut).toBe(1);
    } finally {
      await cleanupTestData(app, data.tenant.id);
    }
  });

  it("WR-03: storeHours keeps the pre-64b legacy schema — a week the stricter salon schema would reject (open >= close on an open day) is accepted and mirrored verbatim (D-04); a 6-day week still 400s with nothing written", async () => {
    const data = await seedTestData(app, "sh-mirror-legacy", { withDefaultSalon: false });
    try {
      const salon = await app.prisma.salon.create({
        data: {
          tenantId: data.tenant.id,
          name: "Legacy-Zeiten",
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: true,
        },
      });

      // Invalid under the legacy schema too: rejected, nothing written.
      const resSix = await putWork(app, data.adminToken, { storeHours: SIX_DAYS });
      expect(resSix.statusCode).toBe(400);
      const untouched = await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } });
      expect(untouched.openingHours).toEqual(DEFAULT_SALON_OPENING_HOURS);

      // Legal under the legacy schema: accepted, stored on the tenant, and copied verbatim.
      const res = await putWork(app, data.adminToken, { storeHours: OPEN_GTE_CLOSE });
      expect(res.statusCode, res.body.slice(0, 400)).toBe(200);

      const config = await app.prisma.tenantConfig.findUniqueOrThrow({
        where: { tenantId: data.tenant.id },
      });
      expect(config.storeHours).toEqual(OPEN_GTE_CLOSE);

      const fresh = await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } });
      expect(fresh.openingHours).toEqual(OPEN_GTE_CLOSE);

      const audits = await app.prisma.auditLog.findMany({
        where: { action: "UPDATE", entity: "Salon", entityId: salon.id },
      });
      expect(audits.length).toBe(1);
    } finally {
      await cleanupTestData(app, data.tenant.id);
    }
  });

  it("PUT with tenantName renames the tenant, not the default salon (D-17)", async () => {
    const data = await seedTestData(app, "sh-mirror-rename", { withDefaultSalon: false });
    try {
      const salon = await app.prisma.salon.create({
        data: {
          tenantId: data.tenant.id,
          name: "Bleibt beim alten Namen",
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: true,
        },
      });

      const res = await putWork(app, data.adminToken, { tenantName: "Neuer Name" });
      expect(res.statusCode, res.body.slice(0, 400)).toBe(200);

      const tenant = await app.prisma.tenant.findUniqueOrThrow({ where: { id: data.tenant.id } });
      expect(tenant.name).toBe("Neuer Name");

      const fresh = await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } });
      expect(fresh.name).toBe("Bleibt beim alten Namen");
    } finally {
      await cleanupTestData(app, data.tenant.id);
    }
  });
});
