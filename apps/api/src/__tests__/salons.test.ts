/**
 * Phase 64b Plan 01 (issue #64) — GET /api/v1/salons role gate, includeInactive, isMultiSalon.
 *
 * `seedTestData()` does NOT create a Salon for its tenant (D-18 exemption) — every fixture salon
 * this file needs is created directly via `app.prisma.salon.create(...)`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { DEFAULT_SALON_OPENING_HOURS, findSalon } from "../contexts/platform/facade/salons";

describe("GET /api/v1/salons", () => {
  let app: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof seedTestData>>;
  let managerToken: string;
  let activeSalonId: string;
  let inactiveSalonId: string;

  beforeAll(async () => {
    app = await getTestApp();
    tenant = await seedTestData(app, "salons-route");

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
