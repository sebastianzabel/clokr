/**
 * Phase 64b Plan 01 (issue #64) — GET /api/v1/salons role gate, includeInactive, isMultiSalon.
 *
 * `seedTestData()` creates ONE active default salon for its tenant (Phase 67b Plan 03, D-24) —
 * every describe below that needs a specific salon COUNT deletes that seeded default first (it
 * carries no assignment row, so nothing blocks the delete) and creates its own fixture salons
 * directly via `app.prisma.salon.create(...)`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import {
  DEFAULT_SALON_OPENING_HOURS,
  findSalon,
  deactivateSalon,
} from "../contexts/platform/facade/salons";

describe("GET /api/v1/salons", () => {
  let app: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof seedTestData>>;
  let managerToken: string;
  let activeSalonId: string;
  let inactiveSalonId: string;

  beforeAll(async () => {
    app = await getTestApp();
    tenant = await seedTestData(app, "salons-route");
    // Phase 67b Plan 03 (D-24): seedTestData now seeds its own active default salon — this
    // describe wants ITS OWN "one active, one inactive" pair below to be the tenant's only
    // salons, so the seeded default is removed here (it carries no assignment row, so the
    // Restrict FK never blocks this delete).
    await app.prisma.salon.delete({ where: { id: tenant.defaultSalon.id } });

    // Inline MANAGER, same pattern as tenant-isolation.test.ts's SEC-V1814-01 block.
    const s = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const passwordHash = await bcrypt.hash("test1234", 10);
    const mgrUser = await app.prisma.user.create({
      data: {
        email: `mgr-salons-${s}@test.de`,
        passwordHash,
        role: "MANAGER",
        isActive: true,
      },
    });
    const mgrEmployee = await app.prisma.employee.create({
      data: {
        tenantId: tenant.tenant.id,
        userId: mgrUser.id,
        employeeNumber: `MG-${s}`,
        firstName: "Manager",
        lastName: "Salons",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: mgrEmployee.id,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: mgrEmployee.id, balanceHours: 0 },
    });
    const mgrLoginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: mgrUser.email, password: "test1234" },
    });
    managerToken = JSON.parse(mgrLoginRes.body).accessToken;

    // One active, one inactive salon for this tenant.
    const active = await app.prisma.salon.create({
      data: {
        tenantId: tenant.tenant.id,
        name: "Aktiver Salon",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
    activeSalonId = active.id;
    const inactive = await app.prisma.salon.create({
      data: {
        tenantId: tenant.tenant.id,
        name: "Inaktiver Salon",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: false,
        deactivatedAt: new Date(),
      },
    });
    inactiveSalonId = inactive.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenant.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("rejects EMPLOYEE with 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/salons",
      headers: { authorization: `Bearer ${tenant.empToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("allows MANAGER with 200, hides inactive salons by default, isMultiSalon false with one active", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/salons",
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.isMultiSalon).toBe(false);
    const ids = body.salons.map((s: { id: string }) => s.id);
    expect(ids).toContain(activeSalonId);
    expect(ids).not.toContain(inactiveSalonId);
  });

  it("allows ADMIN with 200 (D-11)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/salons",
      headers: { authorization: `Bearer ${tenant.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("?includeInactive=true lists both active and inactive salons", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/salons?includeInactive=true",
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const ids = body.salons.map((s: { id: string }) => s.id);
    expect(ids).toContain(activeSalonId);
    expect(ids).toContain(inactiveSalonId);
  });

  it("AC-5: isMultiSalon becomes true once a second ACTIVE salon exists", async () => {
    const secondActive = await app.prisma.salon.create({
      data: {
        tenantId: tenant.tenant.id,
        name: "Zweiter aktiver Salon",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/salons",
        headers: { authorization: `Bearer ${managerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.isMultiSalon).toBe(true);
    } finally {
      await app.prisma.salon.delete({ where: { id: secondActive.id } });
    }
  });
});

/**
 * Phase 64b Plan 02 (issue #64, AC-1/AC-2/AC-4/AC-5/AC-6) — the full salon lifecycle: read by id,
 * create, update, deactivate, re-activate. Each write audited in its own `$transaction`; every
 * `/:id` route T-100-09-safe (byte-identical 404 for a foreign tenant's real salon vs. a
 * nonexistent id).
 */
async function createManagerFor(app: FastifyInstance, tenantId: string, labelPrefix: string) {
  const s = labelPrefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const passwordHash = await bcrypt.hash("test1234", 10);
  const mgrUser = await app.prisma.user.create({
    data: { email: `${s}@test.de`, passwordHash, role: "MANAGER", isActive: true },
  });
  const mgrEmployee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: mgrUser.id,
      employeeNumber: `MG-${s}`.slice(0, 20),
      firstName: "Manager",
      lastName: "Lifecycle",
      hireDate: new Date("2024-01-01"),
    },
  });
  await app.prisma.workSchedule.create({
    data: {
      employeeId: mgrEmployee.id,
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      validFrom: new Date("2024-01-01"),
    },
  });
  await app.prisma.overtimeAccount.create({
    data: { employeeId: mgrEmployee.id, balanceHours: 0 },
  });
  const loginRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: mgrUser.email, password: "test1234" },
  });
  return JSON.parse(loginRes.body).accessToken as string;
}

describe("Salon lifecycle: read by id, create, update, deactivate, activate (Phase 64b Plan 02, issue #64)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  let managerToken: string;
  let salonA: { id: string; name: string };

  const unknownId = "00000000-0000-4000-8000-000000000099";

  function postSalon(token: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/salons",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify(payload),
    });
  }

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
    tenantA = await seedTestData(app, "salon-lifecycle-a");
    tenantB = await seedTestData(app, "salon-lifecycle-b");
    managerToken = await createManagerFor(app, tenantA.tenant.id, "mgr-lifecycle-");

    salonA = await app.prisma.salon.create({
      data: {
        tenantId: tenantA.tenant.id,
        name: "Salon A",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (tenantA):", err);
    }
    try {
      await cleanupTestData(app, tenantB.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (tenantB):", err);
    }
  });

  it("AC-1/D-09: findSalon returns null for a foreign tenant's real salon AND for a nonexistent id, strictly equal — and the row for the owning tenant", async () => {
    const forForeign = await findSalon(app.prisma, tenantB.tenant.id, salonA.id);
    const forUnknown = await findSalon(app.prisma, tenantB.tenant.id, unknownId);
    expect(forForeign).toBeNull();
    expect(forUnknown).toBeNull();
    expect(forForeign).toStrictEqual(forUnknown);

    const forOwner = await findSalon(app.prisma, tenantA.tenant.id, salonA.id);
    expect(forOwner?.id).toBe(salonA.id);
  });

  it("D-13: GET /:id answers a foreign tenant's real salon and a nonexistent id byte-identically, auditing CROSS_TENANT_ACCESS_DENIED only for the real foreign salon", async () => {
    const foreignRes = await app.inject({
      method: "GET",
      url: `/api/v1/salons/${salonA.id}`,
      headers: { authorization: `Bearer ${tenantB.adminToken}` },
    });
    const unknownRes = await app.inject({
      method: "GET",
      url: `/api/v1/salons/${unknownId}`,
      headers: { authorization: `Bearer ${tenantB.adminToken}` },
    });
    expect(foreignRes.statusCode).toBe(404);
    expect(unknownRes.statusCode).toBe(404);
    expect(foreignRes.body).toBe(unknownRes.body);
    expect(JSON.parse(foreignRes.body)).toEqual({ error: "Salon nicht gefunden" });

    const auditForForeign = await app.prisma.auditLog.findFirst({
      where: { action: "CROSS_TENANT_ACCESS_DENIED", entity: "Salon", entityId: salonA.id },
    });
    expect(auditForForeign).not.toBeNull();

    const auditForUnknown = await app.prisma.auditLog.findFirst({
      where: { action: "CROSS_TENANT_ACCESS_DENIED", entity: "Salon", entityId: unknownId },
    });
    expect(auditForUnknown).toBeNull();
  });

  it("GET /:id: MANAGER 200, ADMIN 200, EMPLOYEE 403", async () => {
    const mgrRes = await app.inject({
      method: "GET",
      url: `/api/v1/salons/${salonA.id}`,
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(mgrRes.statusCode).toBe(200);

    const adminRes = await app.inject({
      method: "GET",
      url: `/api/v1/salons/${salonA.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
    expect(adminRes.statusCode).toBe(200);

    const empRes = await app.inject({
      method: "GET",
      url: `/api/v1/salons/${salonA.id}`,
      headers: { authorization: `Bearer ${tenantA.empToken}` },
    });
    expect(empRes.statusCode).toBe(403);
  });

  it("POST /: creates a salon, trims the name, normalises an empty street to null, audits CREATE with the full row as newValue and no oldValue", async () => {
    const res = await postSalon(tenantA.adminToken, {
      name: "  Mitte  ",
      street: "",
      openingHours: DEFAULT_SALON_OPENING_HOURS,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.name).toBe("Mitte");
    expect(body.street).toBeNull();

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "CREATE", entity: "Salon", entityId: body.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.oldValue).toBeNull();
    expect((audit?.newValue as { name?: string } | null)?.name).toBe("Mitte");
  });

  it("POST / with isActive: false stores isActive false and sets deactivatedAt", async () => {
    const res = await postSalon(tenantA.adminToken, {
      name: "Vorbereitet",
      openingHours: DEFAULT_SALON_OPENING_HOURS,
      isActive: false,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.isActive).toBe(false);
    expect(body.deactivatedAt).not.toBeNull();
  });

  it("D-05: a second salon with the SAME name is accepted — no uniqueness constraint", async () => {
    const first = await postSalon(tenantA.adminToken, {
      name: "Doppelt",
      openingHours: DEFAULT_SALON_OPENING_HOURS,
    });
    const second = await postSalon(tenantA.adminToken, {
      name: "Doppelt",
      openingHours: DEFAULT_SALON_OPENING_HOURS,
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
  });

  it("POST / validation: missing name, name > 100 chars, wrong day count, duplicate day, bad time format, and open >= close on an open day all 400", async () => {
    expect(
      (await postSalon(tenantA.adminToken, { openingHours: DEFAULT_SALON_OPENING_HOURS }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await postSalon(tenantA.adminToken, {
          name: "a".repeat(101),
          openingHours: DEFAULT_SALON_OPENING_HOURS,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await postSalon(tenantA.adminToken, {
          name: "X",
          openingHours: DEFAULT_SALON_OPENING_HOURS.slice(0, 6),
        })
      ).statusCode,
    ).toBe(400);

    const duplicateDay = DEFAULT_SALON_OPENING_HOURS.map((d, i) =>
      i === 6 ? { ...d, day: 0 } : d,
    );
    expect(
      (await postSalon(tenantA.adminToken, { name: "X", openingHours: duplicateDay })).statusCode,
    ).toBe(400);

    const badTime = DEFAULT_SALON_OPENING_HOURS.map((d, i) =>
      i === 0 ? { ...d, open: "25:00" } : d,
    );
    expect(
      (await postSalon(tenantA.adminToken, { name: "X", openingHours: badTime })).statusCode,
    ).toBe(400);

    const openGteClose = DEFAULT_SALON_OPENING_HOURS.map((d, i) =>
      i === 0 ? { ...d, open: "20:00", close: "08:00", closed: false } : d,
    );
    expect(
      (await postSalon(tenantA.adminToken, { name: "X", openingHours: openGteClose })).statusCode,
    ).toBe(400);
  });

  it("POST /: open >= close on a day marked closed:true is accepted; that day comes back closed", async () => {
    const openGteCloseButClosed = DEFAULT_SALON_OPENING_HOURS.map((d, i) =>
      i === 0 ? { ...d, open: "20:00", close: "08:00", closed: true } : d,
    );
    const res = await postSalon(tenantA.adminToken, {
      name: "Geschlossen Montag",
      openingHours: openGteCloseButClosed,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    const day0 = (body.openingHours as { day: number; closed?: boolean }[]).find(
      (d) => d.day === 0,
    );
    expect(day0?.closed).toBe(true);
  });

  it("POST / and PATCH /:id are ADMIN-only: MANAGER gets 403 on both", async () => {
    const postRes = await postSalon(managerToken, {
      name: "X",
      openingHours: DEFAULT_SALON_OPENING_HOURS,
    });
    expect(postRes.statusCode).toBe(403);

    const patchRes = await patchSalon(managerToken, salonA.id, { name: "X" });
    expect(patchRes.statusCode).toBe(403);
  });

  it("PATCH /:id: changes only the given field and audits UPDATE with oldValue/newValue", async () => {
    const res = await patchSalon(tenantA.adminToken, salonA.id, { city: "Hannover" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.city).toBe("Hannover");
    expect(body.name).toBe("Salon A");

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "UPDATE", entity: "Salon", entityId: salonA.id },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect((audit?.oldValue as { city?: string | null } | null)?.city).toBeNull();
    expect((audit?.newValue as { city?: string | null } | null)?.city).toBe("Hannover");
  });

  it("PATCH /:id: an explicit null clears an address field", async () => {
    const res = await patchSalon(tenantA.adminToken, salonA.id, { city: null });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).city).toBeNull();
  });

  it("PATCH /:id: unknown keys (isActive, tenantId) 400", async () => {
    const res1 = await patchSalon(tenantA.adminToken, salonA.id, { isActive: false });
    expect(res1.statusCode).toBe(400);
    const res2 = await patchSalon(tenantA.adminToken, salonA.id, { tenantId: tenantB.tenant.id });
    expect(res2.statusCode).toBe(400);
  });

  it("PATCH /:id: body {} on a foreign or unknown id is 404, not 400", async () => {
    const foreignRes = await patchSalon(tenantB.adminToken, salonA.id, {});
    expect(foreignRes.statusCode).toBe(404);
    const unknownRes = await patchSalon(tenantA.adminToken, unknownId, {});
    expect(unknownRes.statusCode).toBe(404);
  });

  it("PATCH /:id: body {} on an own salon is 400 'Keine Änderungen angegeben.'", async () => {
    const res = await patchSalon(tenantA.adminToken, salonA.id, {});
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "Keine Änderungen angegeben." });
  });
});

/**
 * Phase 64b Plan 02 (issue #64, D-06/D-07/D-08/AC-4/AC-5) — deactivate/re-activate: never delete,
 * never zero active salons, even under concurrency.
 */
describe("Salon deactivate/activate (Phase 64b Plan 02, issue #64)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  let managerToken: string;
  let salonA1: { id: string };
  let salonA2: { id: string };
  let foreignSalon: { id: string };

  const unknownId = "00000000-0000-4000-8000-000000000199";

  function postAction(token: string, id: string, action: "deactivate" | "activate") {
    return app.inject({
      method: "POST",
      url: `/api/v1/salons/${id}/${action}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "salon-deact-a");
    tenantB = await seedTestData(app, "salon-deact-b");
    managerToken = await createManagerFor(app, tenantA.tenant.id, "mgr-deact-");
    // Phase 67b Plan 03 (D-24): remove both tenants' seeded default salons so this describe's
    // own salonA1/salonA2/foreignSalon are each tenant's ONLY salons — every isMultiSalon and
    // LAST_ACTIVE_SALON assertion below counts exactly these fixtures, not a third seeded one.
    await app.prisma.salon.delete({ where: { id: tenantA.defaultSalon.id } });
    await app.prisma.salon.delete({ where: { id: tenantB.defaultSalon.id } });

    salonA1 = await app.prisma.salon.create({
      data: {
        tenantId: tenantA.tenant.id,
        name: "Salon A1",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
    salonA2 = await app.prisma.salon.create({
      data: {
        tenantId: tenantA.tenant.id,
        name: "Salon A2",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
    foreignSalon = await app.prisma.salon.create({
      data: {
        tenantId: tenantB.tenant.id,
        name: "Fremder Salon",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (tenantA):", err);
    }
    try {
      await cleanupTestData(app, tenantB.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (tenantB):", err);
    }
  });

  it("AC-5: deactivating one of two active salons succeeds and flips isMultiSalon true -> false", async () => {
    const beforeRes = await app.inject({
      method: "GET",
      url: "/api/v1/salons",
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
    expect(JSON.parse(beforeRes.body).isMultiSalon).toBe(true);

    const res = await postAction(tenantA.adminToken, salonA2.id, "deactivate");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.isActive).toBe(false);
    expect(body.deactivatedAt).not.toBeNull();

    const afterRes = await app.inject({
      method: "GET",
      url: "/api/v1/salons",
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
    expect(JSON.parse(afterRes.body).isMultiSalon).toBe(false);

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "DEACTIVATE", entity: "Salon", entityId: salonA2.id },
    });
    expect(audit).not.toBeNull();
    expect((audit?.oldValue as { isActive?: boolean } | null)?.isActive).toBe(true);
    expect((audit?.newValue as { isActive?: boolean } | null)?.isActive).toBe(false);
  });

  it("D-08: deactivating the LAST active salon is rejected with the exact German message, row unchanged, no DEACTIVATE audit row", async () => {
    // salonA2 was deactivated by the previous test — salonA1 is now the tenant's only active salon.
    const res = await postAction(tenantA.adminToken, salonA1.id, "deactivate");
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: "Der letzte aktive Salon eines Mandanten kann nicht deaktiviert werden.",
    });

    const row = await app.prisma.salon.findUnique({ where: { id: salonA1.id } });
    expect(row?.isActive).toBe(true);
    expect(row?.deactivatedAt).toBeNull();

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "DEACTIVATE", entity: "Salon", entityId: salonA1.id },
    });
    expect(audit).toBeNull();
  });

  it("D-08: deactivating an already-inactive salon 409s; activating an already-active salon 409s", async () => {
    const deactRes = await postAction(tenantA.adminToken, salonA2.id, "deactivate");
    expect(deactRes.statusCode).toBe(409);
    expect(JSON.parse(deactRes.body)).toEqual({ error: "Der Salon ist bereits deaktiviert." });

    const actRes = await postAction(tenantA.adminToken, salonA1.id, "activate");
    expect(actRes.statusCode).toBe(409);
    expect(JSON.parse(actRes.body)).toEqual({ error: "Der Salon ist bereits aktiv." });
  });

  it("D-07: activating an inactive salon succeeds, clears deactivatedAt, and audits ACTIVATE with oldValue/newValue", async () => {
    const res = await postAction(tenantA.adminToken, salonA2.id, "activate");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.isActive).toBe(true);
    expect(body.deactivatedAt).toBeNull();

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "ACTIVATE", entity: "Salon", entityId: salonA2.id },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect((audit?.oldValue as { isActive?: boolean } | null)?.isActive).toBe(false);
    expect((audit?.newValue as { isActive?: boolean } | null)?.isActive).toBe(true);
  });

  it("D-07: a salon created inactive can be activated", async () => {
    const created = await app.prisma.salon.create({
      data: {
        tenantId: tenantA.tenant.id,
        name: "Vorbereiteter Salon",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: false,
        deactivatedAt: new Date(),
      },
    });
    const res = await postAction(tenantA.adminToken, created.id, "activate");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).isActive).toBe(true);
  });

  it("D-06/AC-4: DELETE /api/v1/salons/:id does not exist (404, no route)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/salons/${salonA1.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("MANAGER gets 403 on deactivate and activate", async () => {
    const deactRes = await postAction(managerToken, salonA1.id, "deactivate");
    expect(deactRes.statusCode).toBe(403);
    const actRes = await postAction(managerToken, salonA2.id, "activate");
    expect(actRes.statusCode).toBe(403);
  });

  it("D-13: deactivate/activate answer a foreign tenant's real salon and an unknown id byte-identically", async () => {
    const foreignDeact = await postAction(tenantA.adminToken, foreignSalon.id, "deactivate");
    const unknownDeact = await postAction(tenantA.adminToken, unknownId, "deactivate");
    expect(foreignDeact.statusCode).toBe(404);
    expect(unknownDeact.statusCode).toBe(404);
    expect(foreignDeact.body).toBe(unknownDeact.body);

    const foreignAct = await postAction(tenantA.adminToken, foreignSalon.id, "activate");
    const unknownAct = await postAction(tenantA.adminToken, unknownId, "activate");
    expect(foreignAct.statusCode).toBe(404);
    expect(unknownAct.statusCode).toBe(404);
    expect(foreignAct.body).toBe(unknownAct.body);
  });

  it("concurrency: a transaction deactivating A blocks a second transaction deactivating B; after the first commits, the second sees LAST_ACTIVE_SALON and exactly one salon stays active", async () => {
    // Clear every OTHER active salon this describe block's earlier tests left behind — the
    // LAST_ACTIVE_SALON check is tenant-wide (D-08), so this race is only meaningful when X/Y are
    // the tenant's only two active salons.
    await app.prisma.salon.updateMany({
      where: { tenantId: tenantA.tenant.id, isActive: true },
      data: { isActive: false, deactivatedAt: new Date() },
    });

    // Two fresh active salons, the tenant's only active ones for the rest of this test.
    const salonX = await app.prisma.salon.create({
      data: {
        tenantId: tenantA.tenant.id,
        name: "Salon X (Konkurrenz)",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
    const salonY = await app.prisma.salon.create({
      data: {
        tenantId: tenantA.tenant.id,
        name: "Salon Y (Konkurrenz)",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });

    // Phase 64b review (WR-05): synchronised on observed database state, never on a fixed sleep.
    // tx1 deactivates X and then HOLDS its transaction open (and with it the FOR UPDATE lock on
    // the tenant's salon rows) until the test releases it — but only after it has told the test
    // its backend pid and that deactivateSalon has returned, i.e. that the lock is held.
    let releaseTx1: (() => void) | undefined;
    const tx1HoldGate = new Promise<void>((resolve) => {
      releaseTx1 = resolve;
    });
    let signalTx1Locked: ((pid: number) => void) | undefined;
    const tx1Locked = new Promise<number>((resolve) => {
      signalTx1Locked = resolve;
    });
    const tx1Promise = app.prisma.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        const result = await deactivateSalon(tx, tenantA.tenant.id, salonX.id);
        signalTx1Locked?.(pid);
        await tx1HoldGate;
        return result;
      },
      { timeout: 20000 },
    );
    const tx1Pid = await tx1Locked;

    // tx2 reports its own backend pid BEFORE it reaches the lock, so the test can watch it wait.
    let signalTx2Pid: ((pid: number) => void) | undefined;
    const tx2PidKnown = new Promise<number>((resolve) => {
      signalTx2Pid = resolve;
    });
    let tx2Settled = false;
    const tx2Promise = app.prisma
      .$transaction(
        async (tx) => {
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          signalTx2Pid?.(pid);
          return deactivateSalon(tx, tenantA.tenant.id, salonY.id);
        },
        { timeout: 20000 },
      )
      .finally(() => {
        tx2Settled = true;
      });
    const tx2Pid = await tx2PidKnown;

    // Poll until PostgreSQL reports tx2 as blocked by tx1 (bounded). Without the FOR UPDATE lock
    // tx2 is never blocked — it finishes on its own and the poll times out, which fails below.
    const deadline = Date.now() + 10000;
    let tx2BlockedByTx1 = false;
    while (!tx2Settled && Date.now() < deadline) {
      const [{ blockers }] = await app.prisma.$queryRaw<{ blockers: number[] }[]>`
        SELECT pg_blocking_pids(${tx2Pid}::int) AS blockers`;
      if (blockers.includes(tx1Pid)) {
        tx2BlockedByTx1 = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    releaseTx1?.();
    const [result1, result2] = await Promise.all([tx1Promise, tx2Promise]);

    expect(tx2BlockedByTx1, "tx2 was never observed waiting on tx1's row lock").toBe(true);
    expect(result1.status).toBe("OK");
    expect(result2.status).toBe("LAST_ACTIVE_SALON");

    const activeCount = await app.prisma.salon.count({
      where: { tenantId: tenantA.tenant.id, isActive: true },
    });
    expect(activeCount).toBe(1);
  });
});

/**
 * Phase 64b review, WR-01: a `clk_` API-key caller has `req.user.sub = "apikey:<id>"`, which is
 * not a `User.id`. Every salon audit row must therefore leave `userId` unset and record the key id
 * in `newValue.actor` — otherwise the `AuditLog.userId` foreign key fails the insert, every write
 * answers 500, and the T-100-09 path answers 500 for a foreign salon against 404 for an unknown id.
 */
describe("Salon routes with an API-key caller (Phase 64b review, WR-01)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  let adminKey: { id: string; rawKey: string };
  let managerKey: { id: string; rawKey: string };
  let foreignSalon: { id: string };

  const unknownId = "00000000-0000-4000-8000-000000000299";

  async function createApiKey(scopes: string[], name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/api-keys",
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: { name, scopes },
    });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    const body = JSON.parse(res.body) as { id: string; rawKey: string };
    return { id: body.id, rawKey: body.rawKey };
  }

  function send(key: string, method: "GET" | "POST" | "PATCH", url: string, payload?: object) {
    if (payload === undefined) {
      return app.inject({ method, url, headers: { authorization: `Bearer ${key}` } });
    }
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      payload: JSON.stringify(payload),
    });
  }

  async function auditRow(action: string, entityId: string) {
    return app.prisma.auditLog.findFirst({
      where: { action, entity: "Salon", entityId },
      orderBy: { createdAt: "desc" },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "salon-apikey-a");
    tenantB = await seedTestData(app, "salon-apikey-b");
    adminKey = await createApiKey(["admin"], "Salon WR-01 admin key");
    managerKey = await createApiKey(["read:employees"], "Salon WR-01 manager key");

    // Tenant A needs an active salon besides the one the test creates, so deactivate succeeds.
    await app.prisma.salon.create({
      data: {
        tenantId: tenantA.tenant.id,
        name: "Salon Bestand",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
    foreignSalon = await app.prisma.salon.create({
      data: {
        tenantId: tenantB.tenant.id,
        name: "Fremder Salon (API-Key)",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (tenantA):", err);
    }
    try {
      await cleanupTestData(app, tenantB.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (tenantB):", err);
    }
  });

  it("an ADMIN-scope key can create, update, deactivate and activate a salon; every audit row has no userId and names the key in newValue.actor", async () => {
    const created = await send(adminKey.rawKey, "POST", "/api/v1/salons", {
      name: "Salon per API-Key",
      openingHours: DEFAULT_SALON_OPENING_HOURS,
    });
    expect(created.statusCode, created.body.slice(0, 400)).toBe(201);
    const salonId = (JSON.parse(created.body) as { id: string }).id;

    const patched = await send(adminKey.rawKey, "PATCH", `/api/v1/salons/${salonId}`, {
      name: "Salon per API-Key (umbenannt)",
    });
    expect(patched.statusCode, patched.body.slice(0, 400)).toBe(200);

    const deactivated = await send(adminKey.rawKey, "POST", `/api/v1/salons/${salonId}/deactivate`);
    expect(deactivated.statusCode, deactivated.body.slice(0, 400)).toBe(200);

    const activated = await send(adminKey.rawKey, "POST", `/api/v1/salons/${salonId}/activate`);
    expect(activated.statusCode, activated.body.slice(0, 400)).toBe(200);

    for (const action of ["CREATE", "UPDATE", "DEACTIVATE", "ACTIVATE"]) {
      const row = await auditRow(action, salonId);
      expect(row, `${action} audit row`).not.toBeNull();
      expect(row?.userId, `${action} userId`).toBeNull();
      const newValue = row?.newValue as { actor?: unknown; id?: string } | null;
      expect(newValue?.actor, `${action} actor`).toEqual({
        type: "API_KEY",
        apiKeyId: adminKey.id,
      });
      // The row data is still there next to the actor — the actor is added, nothing replaced.
      expect(newValue?.id, `${action} row id`).toBe(salonId);
    }
  });

  it("a MANAGER-scope key gets the byte-identical 404 for a foreign salon and an unknown id; the CROSS_TENANT_ACCESS_DENIED row has no userId and names the key", async () => {
    const foreignRes = await send(managerKey.rawKey, "GET", `/api/v1/salons/${foreignSalon.id}`);
    const unknownRes = await send(managerKey.rawKey, "GET", `/api/v1/salons/${unknownId}`);
    expect(foreignRes.statusCode, foreignRes.body.slice(0, 400)).toBe(404);
    expect(unknownRes.statusCode).toBe(404);
    expect(foreignRes.body).toBe(unknownRes.body);

    const row = await auditRow("CROSS_TENANT_ACCESS_DENIED", foreignSalon.id);
    expect(row).not.toBeNull();
    expect(row?.userId).toBeNull();
    expect(row?.newValue).toEqual({ actor: { type: "API_KEY", apiKeyId: managerKey.id } });
  });
});
