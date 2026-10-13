/**
 * Phase 566 (#566), plan 01 — booked packages per tenant: the one decider, the salon limit on
 * activation, the database CHECK and the neutral fixture.
 *
 * Package tests create Grundversion tenants explicitly (`seedGrundversionTenant`); the shared
 * `seedTestData` fixture books everything (D-10), pinned in the last block.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  seedTestData,
  seedGrundversionTenant,
  createTestSalon,
  cleanupTestData,
  FIXTURE_PACKAGES,
} from "./setup";
import { DEFAULT_SALON_OPENING_HOURS } from "../contexts/platform/facade/salons";
import {
  GRUNDVERSION,
  ModuleNotBookedError,
  SALON_QUOTA_REACHED_MESSAGE,
  TENANT_MODULES,
  assertModuleBooked,
  isModuleBooked,
  moduleBookedIn,
  normalizeStoredPackages,
  packagesForDisplay,
  salonLimit,
} from "../contexts/platform/tenant-packages";

describe("salon activation against the booked limit (Phase 566, D-04, AC-566-02)", () => {
  let app: FastifyInstance;
  let grund: Awaited<ReturnType<typeof seedGrundversionTenant>>;
  let chainTenant: Awaited<ReturnType<typeof seedGrundversionTenant>>;
  let noChainTenant: Awaited<ReturnType<typeof seedGrundversionTenant>>;

  function activate(token: string, salonId: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/salons/${salonId}/activate`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    grund = await seedGrundversionTenant(app, "pkg566-grund");
    chainTenant = await seedGrundversionTenant(app, "pkg566-chain");
    noChainTenant = await seedGrundversionTenant(app, "pkg566-nochain");
  });

  afterAll(async () => {
    for (const t of [grund, chainTenant, noChainTenant]) {
      try {
        await cleanupTestData(app, t.tenant.id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  it("(a) refuses activation beyond the Grundversion limit with exactly { error, code } and writes nothing", async () => {
    const inactive = await createTestSalon(app.prisma, grund.tenant.id, {
      name: "Vorbereiteter Salon",
      isActive: false,
    });
    const before = await app.prisma.auditLog.count({ where: { entityId: inactive.id } });

    const res = await activate(grund.adminToken, inactive.id);

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(Object.keys(body).sort((a, b) => a.localeCompare(b))).toEqual(["code", "error"]);
    expect(body.code).toBe("SALON_QUOTA_REACHED");
    expect(body.error).toBe(SALON_QUOTA_REACHED_MESSAGE);
    expect(String(body.error)).toContain("Ketten-Paket");

    const row = await app.prisma.salon.findUniqueOrThrow({ where: { id: inactive.id } });
    expect(row.isActive).toBe(false);
    expect(await app.prisma.auditLog.count({ where: { entityId: inactive.id } })).toBe(before);
  });

  it("(b) activates below the limit with CHAIN and a quota of 2, refuses the next one", async () => {
    await app.prisma.tenant.update({
      where: { id: chainTenant.tenant.id },
      data: { bookedModules: ["CHAIN"], salonQuota: 2 },
    });
    // The fixture tenant already owns one active default salon, so the quota of 2 has one free slot.
    const second = await createTestSalon(app.prisma, chainTenant.tenant.id, {
      name: "Zweiter Salon",
      isActive: false,
    });
    const third = await createTestSalon(app.prisma, chainTenant.tenant.id, {
      name: "Dritter Salon",
      isActive: false,
    });

    const ok = await activate(chainTenant.adminToken, second.id);
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).isActive).toBe(true);

    const refused = await activate(chainTenant.adminToken, third.id);
    expect(refused.statusCode).toBe(409);
    expect(JSON.parse(refused.body).code).toBe("SALON_QUOTA_REACHED");
  });

  it("(c) a quota above 1 without CHAIN has no effect (D-02)", async () => {
    await app.prisma.tenant.update({
      where: { id: noChainTenant.tenant.id },
      data: { bookedModules: ["INTEGRATIONS"], salonQuota: 3 },
    });
    const inactive = await createTestSalon(app.prisma, noChainTenant.tenant.id, {
      name: "Zweiter Salon",
      isActive: false,
    });

    const res = await activate(noChainTenant.adminToken, inactive.id);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("SALON_QUOTA_REACHED");
  });

  it("(d) an unknown salon id on a tenant at its limit keeps the unchanged 404", async () => {
    const atLimit = await activate(grund.adminToken, randomUUID());
    expect(atLimit.statusCode).toBe(404);
    expect(JSON.parse(atLimit.body)).toEqual({ error: "Salon nicht gefunden" });
  });

  it("(e) an already-active salon on a tenant at its limit keeps the unchanged already-active reply", async () => {
    const active = await app.prisma.salon.findFirstOrThrow({
      where: { tenantId: grund.tenant.id, isActive: true },
    });
    const res = await activate(grund.adminToken, active.id);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: "Der Salon ist bereits aktiv." });
  });
});

describe("Tenant_salonQuota_positive (Phase 566, D-01, T-566-04)", () => {
  let app: FastifyInstance;
  let fixture: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    fixture = await seedTestData(app, "pkg566-check");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, fixture.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("(f) the database rejects a salon quota below 1 and names the constraint", async () => {
    const attempt = app.prisma
      .$executeRaw`UPDATE "Tenant" SET "salonQuota" = 0 WHERE "id" = ${fixture.tenant.id}`;
    await expect(attempt).rejects.toThrow(/Tenant_salonQuota_positive/);
    const row = await app.prisma.tenant.findUniqueOrThrow({ where: { id: fixture.tenant.id } });
    expect(row.salonQuota).toBe(FIXTURE_PACKAGES.salonQuota);
  });
});

describe("the decider as pure functions (Phase 566, D-02/D-03)", () => {
  let app: FastifyInstance;
  let fixture: Awaited<ReturnType<typeof seedGrundversionTenant>>;

  beforeAll(async () => {
    app = await getTestApp();
    fixture = await seedGrundversionTenant(app, "pkg566-unit");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, fixture.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("(g) salonLimit is the quota only with CHAIN", () => {
    expect(salonLimit({ bookedModules: ["CHAIN"], salonQuota: 5 })).toBe(5);
    expect(salonLimit({ bookedModules: ["INTEGRATIONS", "ANALYTICS"], salonQuota: 5 })).toBe(1);
    expect(salonLimit({ bookedModules: ["CHAIN"], salonQuota: 1 })).toBe(1);
    expect(salonLimit(GRUNDVERSION)).toBe(1);
  });

  it("(g) normalizeStoredPackages reads NULL as empty and orders canonically without duplicates", () => {
    expect(normalizeStoredPackages({ bookedModules: null, salonQuota: 1 })).toEqual({
      bookedModules: [],
      salonQuota: 1,
    });
    expect(
      normalizeStoredPackages({
        bookedModules: ["ANALYTICS", "CHAIN", "ANALYTICS", "HARDWARE_CLOCK"],
        salonQuota: 4,
      }),
    ).toEqual({ bookedModules: ["CHAIN", "HARDWARE_CLOCK", "ANALYTICS"], salonQuota: 4 });
    expect(TENANT_MODULES).toEqual(["CHAIN", "INTEGRATIONS", "HARDWARE_CLOCK", "ANALYTICS"]);
    expect(moduleBookedIn({ bookedModules: ["CHAIN"] }, "CHAIN")).toBe(true);
    expect(moduleBookedIn({ bookedModules: ["CHAIN"] }, "ANALYTICS")).toBe(false);
  });

  it("(g) isModuleBooked answers true, false and false for an unknown tenant", async () => {
    await app.prisma.tenant.update({
      where: { id: fixture.tenant.id },
      data: { bookedModules: ["INTEGRATIONS"] },
    });
    expect(await isModuleBooked(app.prisma, fixture.tenant.id, "INTEGRATIONS")).toBe(true);
    expect(await isModuleBooked(app.prisma, fixture.tenant.id, "ANALYTICS")).toBe(false);
    expect(await isModuleBooked(app.prisma, randomUUID(), "INTEGRATIONS")).toBe(false);
  });

  it("(g) packagesForDisplay shows the Grundversion for an unknown tenant", async () => {
    expect(await packagesForDisplay(app.prisma, randomUUID())).toEqual({
      bookedModules: [],
      salonLimit: 1,
    });
  });

  it("(g) assertModuleBooked throws a 409 MODULE_NOT_BOOKED naming the module", async () => {
    const error = await assertModuleBooked(app.prisma, fixture.tenant.id, "HARDWARE_CLOCK").then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ModuleNotBookedError);
    const refusal = error as ModuleNotBookedError;
    expect(refusal.code).toBe("MODULE_NOT_BOOKED");
    expect(refusal.statusCode).toBe(409);
    expect(refusal.message).toContain("Hardware-Stempeln");
  });
});

describe("the shared fixture books everything (Phase 566, D-10)", () => {
  let app: FastifyInstance;
  let fixture: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    fixture = await seedTestData(app, "pkg566-fixture");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, fixture.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("(h) a seedTestData tenant reads back all four modules and quota 500", async () => {
    const row = await app.prisma.tenant.findUniqueOrThrow({ where: { id: fixture.tenant.id } });
    expect(row.bookedModules).toEqual([...TENANT_MODULES]);
    expect(row.salonQuota).toBe(500);
    expect(fixture.tenant.salonQuota).toBe(500);
  });
});

describe("salon creation against the booked limit (Phase 566, D-04, AC-566-02)", () => {
  let app: FastifyInstance;
  let grund: Awaited<ReturnType<typeof seedGrundversionTenant>>;
  let chainTenant: Awaited<ReturnType<typeof seedGrundversionTenant>>;

  function create(token: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/salons",
      headers: { authorization: `Bearer ${token}` },
      payload: { openingHours: DEFAULT_SALON_OPENING_HOURS, ...body },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    grund = await seedGrundversionTenant(app, "pkg566-create-grund");
    chainTenant = await seedGrundversionTenant(app, "pkg566-create-chain");
  });

  afterAll(async () => {
    for (const t of [grund, chainTenant]) {
      try {
        await cleanupTestData(app, t.tenant.id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  it("(a) refuses an active create beyond the Grundversion limit with exactly { error, code } and persists nothing", async () => {
    const name = `Zweiter Salon ${randomUUID().slice(0, 8)}`;
    const salonsBefore = await app.prisma.salon.count({ where: { tenantId: grund.tenant.id } });

    const res = await create(grund.adminToken, { name });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(Object.keys(body).sort((a, b) => a.localeCompare(b))).toEqual(["code", "error"]);
    expect(body.code).toBe("SALON_QUOTA_REACHED");
    expect(body.error).toBe(SALON_QUOTA_REACHED_MESSAGE);

    // Nothing leaked: no Salon row and no audit row carrying the refused name.
    expect(await app.prisma.salon.count({ where: { tenantId: grund.tenant.id } })).toBe(
      salonsBefore,
    );
    expect(await app.prisma.salon.count({ where: { tenantId: grund.tenant.id, name } })).toBe(0);
    expect(
      await app.prisma.auditLog.count({
        where: { entity: "Salon", action: "CREATE", newValue: { path: ["name"], equals: name } },
      }),
    ).toBe(0);
  });

  it("(b) an inactive create is never refused, even at the limit", async () => {
    const res = await create(grund.adminToken, { name: "Vorbereitet", isActive: false });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.isActive).toBe(false);
    expect(body.deactivatedAt).not.toBeNull();
  });

  it("(c) with CHAIN and a quota of 2 the first active create passes and the second is refused", async () => {
    await app.prisma.tenant.update({
      where: { id: chainTenant.tenant.id },
      data: { bookedModules: ["CHAIN"], salonQuota: 2 },
    });
    // The fixture tenant already owns one active default salon, so one slot is free.
    const first = await create(chainTenant.adminToken, { name: "Zweiter Salon" });
    expect(first.statusCode).toBe(201);

    const second = await create(chainTenant.adminToken, { name: "Dritter Salon" });
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).code).toBe("SALON_QUOTA_REACHED");
  });
});
