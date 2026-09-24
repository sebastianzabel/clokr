/**
 * Phase 64b Plan 04 (issue #64, D-16/D-17) — `PUT /api/v1/settings/work`'s `storeHours` write now
 * mirrors into a tenant's SOLE active salon, atomically and audited, while leaving a multi-salon
 * tenant's salons alone and never renaming a salon via `tenantName`.
 *
 * `seedTestData()` does not create a Salon (D-18 exemption) — every fixture salon this file needs
 * is created directly via `app.prisma.salon.create(...)`, matching `salons.test.ts`'s own pattern.
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

const DUPLICATE_DAY = DEFAULT_SALON_OPENING_HOURS.map((d, i) => (i === 6 ? { ...d, day: 0 } : d));

const OPEN_GTE_CLOSE = DEFAULT_SALON_OPENING_HOURS.map((d, i) =>
  i === 0 ? { ...d, open: "20:00", close: "08:00", closed: false } : d,
);

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
    const data = await seedTestData(app, "sh-mirror-one");
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
    const data = await seedTestData(app, "sh-mirror-two");
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
    const data = await seedTestData(app, "sh-mirror-mix");
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
    const data = await seedTestData(app, "sh-mirror-notouch");
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

  it("PUT with a duplicate day, or open >= close on an open day, is rejected 400 — nothing written", async () => {
    const data = await seedTestData(app, "sh-mirror-invalid");
    try {
      const salon = await app.prisma.salon.create({
        data: {
          tenantId: data.tenant.id,
          name: "Bleibt gleich",
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: true,
        },
      });

      const resDup = await putWork(app, data.adminToken, { storeHours: DUPLICATE_DAY });
      expect(resDup.statusCode).toBe(400);

      const resOpenGte = await putWork(app, data.adminToken, { storeHours: OPEN_GTE_CLOSE });
      expect(resOpenGte.statusCode).toBe(400);

      const fresh = await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } });
      expect(fresh.openingHours).toEqual(DEFAULT_SALON_OPENING_HOURS);

      const config = await app.prisma.tenantConfig.findUniqueOrThrow({
        where: { tenantId: data.tenant.id },
      });
      expect(config.storeHours).toEqual(DEFAULT_SALON_OPENING_HOURS);

      const audits = await app.prisma.auditLog.findMany({
        where: { action: "UPDATE", entity: "Salon", entityId: salon.id },
      });
      expect(audits.length).toBe(0);
    } finally {
      await cleanupTestData(app, data.tenant.id);
    }
  });

  it("PUT with tenantName renames the tenant, not the default salon (D-17)", async () => {
    const data = await seedTestData(app, "sh-mirror-rename");
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
