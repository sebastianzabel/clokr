/**
 * Issue #563 — the tenant salon admin page's write path, proven at the HTTP layer.
 *
 * `/admin/salons` calls the EXISTING tenant routes `GET /api/v1/salons?includeInactive=true` and
 * `PATCH /api/v1/salons/:id` with exactly `{ openingHours }` (D-01, D-11: no server change for salon
 * CRUD). This file characterises that unchanged contract from the page's point of view: the hours
 * land on the chosen salon only, `TenantConfig` stays untouched, one audit row records the change
 * with before/after values and the tenant user as actor, a salon:read holder cannot write, and a
 * foreign salon id is indistinguishable from an unknown one.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  seedTestData,
  seedGrundversionTenant,
  cleanupTestData,
  createTestSalon,
  grantSystemRole,
  soleAuditRow,
  auditRowsFor,
} from "./setup";
import { DEFAULT_SALON_OPENING_HOURS } from "../contexts/platform/facade/salons";
import { SALON_QUOTA_REACHED_MESSAGE } from "../contexts/platform/tenant-packages";

/** A week that differs from the default: Wednesday closed, Sunday open 10:00-14:00. */
const WEEK = [
  { day: 0, open: "08:00", close: "20:00" },
  { day: 1, open: "08:00", close: "20:00" },
  { day: 2, open: "08:00", close: "20:00", closed: true },
  { day: 3, open: "08:00", close: "20:00" },
  { day: 4, open: "08:00", close: "20:00" },
  { day: 5, open: "08:00", close: "20:00" },
  { day: 6, open: "10:00", close: "14:00" },
];

/** A MANAGER of the tenant: holds salon:read but not salon:manage (system-role fixture). */
async function createManagerToken(app: FastifyInstance, tenantId: string): Promise<string> {
  const s = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const passwordHash = await bcrypt.hash("test1234", 10);
  const mgrUser = await app.prisma.user.create({
    data: {
      email: `mgr-salon-admin-${s}@example.invalid`,
      passwordHash,
      role: "MANAGER",
      isActive: true,
    },
  });
  // Issue #539 (D-09): the system role is a stored assignment, never the column.
  await grantSystemRole(app.prisma, { tenantId, userId: mgrUser.id, role: "MANAGER" });
  const mgrEmployee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: mgrUser.id,
      employeeNumber: `MG-${s}`,
      firstName: "Manager",
      lastName: "Salonadmin",
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

describe("salon admin page write path (#563)", () => {
  let app: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof seedTestData>>;
  let otherTenant: Awaited<ReturnType<typeof seedTestData>>;
  let managerToken: string;
  let firstSalonId: string;
  let secondSalonId: string;
  let inactiveSalonId: string;
  let foreignSalonId: string;

  beforeAll(async () => {
    app = await getTestApp();
    tenant = await seedTestData(app, "salon-admin-563");
    otherTenant = await seedTestData(app, "salon-admin-563-other");
    firstSalonId = tenant.salonId;

    const second = await createTestSalon(app.prisma, tenant.tenant.id, { name: "Zweiter Salon" });
    secondSalonId = second.id;
    const inactive = await createTestSalon(app.prisma, tenant.tenant.id, {
      name: "Inaktiver Salon",
      isActive: false,
    });
    inactiveSalonId = inactive.id;
    foreignSalonId = otherTenant.salonId;

    // A MANAGER holds salon:read but not salon:manage (system-role fixture).
    managerToken = await createManagerToken(app, tenant.tenant.id);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenant.tenant.id);
      await cleanupTestData(app, otherTenant.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  const adminAuth = () => ({ authorization: `Bearer ${tenant.adminToken}` });

  async function salonHours(salonId: string) {
    const row = await app.prisma.salon.findUniqueOrThrow({
      where: { id: salonId },
      select: { openingHours: true },
    });
    return row.openingHours;
  }

  it("lists every salon of the tenant, active and inactive, for the admin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/salons?includeInactive=true",
      headers: adminAuth(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { salons: { id: string }[]; isMultiSalon: boolean };
    const ids = body.salons.map((salon) => salon.id);
    expect(ids).toEqual(expect.arrayContaining([firstSalonId, secondSalonId, inactiveSalonId]));
    expect(ids).toHaveLength(3);
    expect(ids).not.toContain(foreignSalonId);
    expect(body.isMultiSalon).toBe(true);
  });

  it("PATCH { openingHours } changes the chosen salon only, leaves TenantConfig untouched and writes one UPDATE audit row", async () => {
    const configBefore = await app.prisma.tenantConfig.findUniqueOrThrow({
      where: { tenantId: tenant.tenant.id },
      select: { shiftStoreHoursMode: true, storeHours: true },
    });
    const firstBefore = await salonHours(firstSalonId);
    const secondBefore = await salonHours(secondSalonId);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/salons/${secondSalonId}`,
      headers: adminAuth(),
      payload: { openingHours: WEEK },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).openingHours).toEqual(WEEK);

    expect(await salonHours(secondSalonId)).toEqual(WEEK);
    expect(await salonHours(firstSalonId)).toEqual(firstBefore);

    const configAfter = await app.prisma.tenantConfig.findUniqueOrThrow({
      where: { tenantId: tenant.tenant.id },
      select: { shiftStoreHoursMode: true, storeHours: true },
    });
    expect(configAfter).toEqual(configBefore);

    const row = await soleAuditRow(app.prisma, {
      where: { entity: "Salon", entityId: secondSalonId, action: "UPDATE" },
    });
    expect(row.userId).toBe(tenant.adminUser.id);
    expect((row.oldValue as { openingHours: unknown }).openingHours).toEqual(secondBefore);
    expect((row.newValue as { openingHours: unknown }).openingHours).toEqual(WEEK);
    expect(await auditRowsFor(app, "Salon", firstSalonId)).toHaveLength(0);
  });

  it("lets the MANAGER read the list but refuses its write with 403, no change and no audit row", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/salons?includeInactive=true",
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(list.statusCode).toBe(200);

    const before = await salonHours(firstSalonId);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/salons/${firstSalonId}`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { openingHours: WEEK },
    });
    expect(res.statusCode).toBe(403);
    expect(await salonHours(firstSalonId)).toEqual(before);
    expect(await auditRowsFor(app, "Salon", firstSalonId)).toHaveLength(0);
  });

  it("refuses the list to an EMPLOYEE with 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/salons?includeInactive=true",
      headers: { authorization: `Bearer ${tenant.empToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("answers a foreign salon id and an unknown id with the identical 404", async () => {
    const foreign = await app.inject({
      method: "PATCH",
      url: `/api/v1/salons/${foreignSalonId}`,
      headers: adminAuth(),
      payload: { openingHours: WEEK },
    });
    const unknown = await app.inject({
      method: "PATCH",
      url: `/api/v1/salons/${randomUUID()}`,
      headers: adminAuth(),
      payload: { openingHours: WEEK },
    });
    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(foreign.body).toBe(unknown.body);
    // the foreign salon is untouched
    expect(await salonHours(foreignSalonId)).toEqual(DEFAULT_SALON_OPENING_HOURS);
  });

  it("rejects a week whose open time is not before its close time with 400 and changes nothing", async () => {
    const before = await salonHours(firstSalonId);
    const invalidWeek = WEEK.map((entry) =>
      entry.day === 0 ? { day: 0, open: "18:00", close: "09:00" } : entry,
    );
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/salons/${firstSalonId}`,
      headers: adminAuth(),
      payload: { openingHours: invalidWeek },
    });
    expect(res.statusCode).toBe(400);
    expect(await salonHours(firstSalonId)).toEqual(before);
    expect(await auditRowsFor(app, "Salon", firstSalonId, "UPDATE")).toHaveLength(0);
  });
});

/**
 * Issue #563, plan 04 - create and master-data edits with the EXACT bodies `/admin/salons` sends:
 * `createSalonBody()` (name, street, postalCode, city, an explicit federalState, openingHours; never
 * isActive) and `salonPatch()` (changed keys only, never `{}`). The routes are unchanged (D-01); this
 * proves quota, Bundesland lock, audit and the identical 404 from the page's point of view.
 */
describe("salon admin page create and master data (#563-04)", () => {
  let app: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof seedTestData>>;
  let grundversion: Awaited<ReturnType<typeof seedGrundversionTenant>>;
  let otherTenant: Awaited<ReturnType<typeof seedTestData>>;
  let managerToken: string;

  beforeAll(async () => {
    app = await getTestApp();
    tenant = await seedTestData(app, "salon-admin-563-create");
    grundversion = await seedGrundversionTenant(app, "salon-admin-563-grund");
    otherTenant = await seedTestData(app, "salon-admin-563-create-other");
    managerToken = await createManagerToken(app, tenant.tenant.id);
  });

  afterAll(async () => {
    for (const id of [tenant?.tenant.id, grundversion?.tenant.id, otherTenant?.tenant.id]) {
      if (!id) continue;
      try {
        await cleanupTestData(app, id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  const adminAuth = () => ({ authorization: `Bearer ${tenant.adminToken}` });

  /** The body `createSalonBody()` builds for a filled-in form: empty address parts are null. */
  const createBody = (name: string) => ({
    name,
    street: "Hauptstraße 1",
    postalCode: "30159",
    city: null,
    federalState: "BAYERN",
    openingHours: WEEK,
  });

  async function salonCount(tenantId: string) {
    return app.prisma.salon.count({ where: { tenantId } });
  }

  it("POST with the page's body creates the salon, audits CREATE with the admin as actor and lists it in the admin's salon context", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/salons",
      headers: adminAuth(),
      payload: createBody("Neuer Salon 563"),
    });
    expect(res.statusCode, res.body).toBe(201);
    const created = JSON.parse(res.body) as {
      id: string;
      name: string;
      federalState: string;
      isActive: boolean;
      openingHours: unknown;
      street: string | null;
      city: string | null;
    };
    expect(created).toMatchObject({
      name: "Neuer Salon 563",
      federalState: "BAYERN",
      isActive: true,
      street: "Hauptstraße 1",
      city: null,
    });
    expect(created.openingHours).toEqual(WEEK);

    const row = await soleAuditRow(app.prisma, {
      where: { entity: "Salon", entityId: created.id, action: "CREATE" },
    });
    expect(row.userId).toBe(tenant.adminUser.id);
    expect(row.newValue).toMatchObject({ name: "Neuer Salon 563", federalState: "BAYERN" });

    // The page reloads the salon context after the POST; this is the endpoint it reads.
    const context = await app.inject({
      method: "GET",
      url: "/api/v1/me/context",
      headers: adminAuth(),
    });
    expect(context.statusCode).toBe(200);
    const ids = (JSON.parse(context.body) as { salons: { id: string }[] }).salons.map((s) => s.id);
    expect(ids).toContain(created.id);
  });

  it("POST in a Grundversion tenant that already has its one active salon answers 409 SALON_QUOTA_REACHED with the server text and writes no row", async () => {
    const before = await salonCount(grundversion.tenant.id);
    expect(before).toBe(1);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/salons",
      headers: { authorization: `Bearer ${grundversion.adminToken}` },
      payload: createBody("Zweiter Salon ohne Kette"),
    });
    expect(res.statusCode, res.body).toBe(409);
    const body = JSON.parse(res.body) as { code: string; error: string };
    expect(body.code).toBe("SALON_QUOTA_REACHED");
    expect(body.error).toBe(SALON_QUOTA_REACHED_MESSAGE);
    expect(await salonCount(grundversion.tenant.id)).toBe(before);
  });

  it("refuses the MANAGER's POST with 403 and writes no row", async () => {
    const before = await salonCount(tenant.tenant.id);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/salons",
      headers: { authorization: `Bearer ${managerToken}` },
      payload: createBody("Vom Manager"),
    });
    expect(res.statusCode).toBe(403);
    expect(await salonCount(tenant.tenant.id)).toBe(before);
  });

  it("PATCH { name, city } changes those fields only and writes one UPDATE audit row with old and new values", async () => {
    const salon = await createTestSalon(app.prisma, tenant.tenant.id, {
      name: "Vor der Änderung",
      federalState: "NIEDERSACHSEN",
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/salons/${salon.id}`,
      headers: adminAuth(),
      payload: { name: "Nach der Änderung", city: "Celle" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      name: "Nach der Änderung",
      city: "Celle",
      federalState: "NIEDERSACHSEN",
    });

    const row = await soleAuditRow(app.prisma, {
      where: { entity: "Salon", entityId: salon.id, action: "UPDATE" },
    });
    expect(row.userId).toBe(tenant.adminUser.id);
    expect(row.oldValue).toMatchObject({ name: "Vor der Änderung", city: null });
    expect(row.newValue).toMatchObject({ name: "Nach der Änderung", city: "Celle" });
  });

  it("PATCH { federalState } on a salon referenced by a time entry answers 409 FEDERAL_STATE_IN_USE and keeps the Bundesland", async () => {
    const salon = await createTestSalon(app.prisma, tenant.tenant.id, {
      name: "Mit Zeiteintrag 563",
      federalState: "NIEDERSACHSEN",
    });
    await app.prisma.timeEntry.create({
      data: {
        employeeId: tenant.employee.id,
        salonId: salon.id,
        date: new Date("2026-01-05T00:00:00Z"),
        startTime: new Date("2026-01-05T08:00:00Z"),
        endTime: new Date("2026-01-05T16:00:00Z"),
        breakMinutes: 30,
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/salons/${salon.id}`,
      headers: adminAuth(),
      payload: { federalState: "BAYERN" },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ code: "FEDERAL_STATE_IN_USE" });
    const fresh = await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } });
    expect(fresh.federalState).toBe("NIEDERSACHSEN");
    expect(await auditRowsFor(app, "Salon", salon.id, "UPDATE")).toHaveLength(0);
  });

  it("rejects an empty patch with 400 (the page never sends one) and writes no audit row", async () => {
    const salon = await createTestSalon(app.prisma, tenant.tenant.id, { name: "Leerer Patch" });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/salons/${salon.id}`,
      headers: adminAuth(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(await auditRowsFor(app, "Salon", salon.id, "UPDATE")).toHaveLength(0);
  });

  it("answers GET /:id for a foreign tenant's salon and for an unknown id with the identical 404", async () => {
    const foreign = await app.inject({
      method: "GET",
      url: `/api/v1/salons/${otherTenant.salonId}`,
      headers: adminAuth(),
    });
    const unknown = await app.inject({
      method: "GET",
      url: `/api/v1/salons/${randomUUID()}`,
      headers: adminAuth(),
    });
    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(foreign.body).toBe(unknown.body);
  });
});

/**
 * Issue #563, plan 05 - deactivate and activate with the calls `/admin/salons/[id]` makes
 * (`POST /salons/:id/deactivate`, `POST /salons/:id/activate`, then `GET /me/context`). The routes
 * are unchanged (D-01); this proves status, audit actor, the context following the change, the
 * quota refusal and the 403/404 contract from the page's point of view. Refusal bodies of the
 * lifecycle routes carry `{ error }` only (research A7) - the page shows them and never branches.
 */
describe("salon admin page lifecycle (#563-05)", () => {
  let app: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof seedTestData>>;
  let grundversion: Awaited<ReturnType<typeof seedGrundversionTenant>>;
  let otherTenant: Awaited<ReturnType<typeof seedTestData>>;
  let managerToken: string;

  beforeAll(async () => {
    app = await getTestApp();
    tenant = await seedTestData(app, "salon-admin-563-life");
    grundversion = await seedGrundversionTenant(app, "salon-admin-563-life-grund");
    otherTenant = await seedTestData(app, "salon-admin-563-life-other");
    managerToken = await createManagerToken(app, tenant.tenant.id);
  });

  afterAll(async () => {
    for (const id of [tenant?.tenant.id, grundversion?.tenant.id, otherTenant?.tenant.id]) {
      if (!id) continue;
      try {
        await cleanupTestData(app, id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  const adminAuth = () => ({ authorization: `Bearer ${tenant.adminToken}` });

  async function contextSalonIds(headers: Record<string, string>): Promise<string[]> {
    const res = await app.inject({ method: "GET", url: "/api/v1/me/context", headers });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { salons: { id: string }[] }).salons.map((s) => s.id);
  }

  async function post(path: string, headers: Record<string, string>) {
    return app.inject({ method: "POST", url: `/api/v1/salons/${path}`, headers });
  }

  it("deactivate marks the salon inactive with deactivatedAt, audits DEACTIVATE with the admin as actor and drops it from the admin's salon context", async () => {
    const salon = await createTestSalon(app.prisma, tenant.tenant.id, { name: "Zu deaktivieren" });
    expect(await contextSalonIds(adminAuth())).toContain(salon.id);

    const res = await post(`${salon.id}/deactivate`, adminAuth());
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id: salon.id, isActive: false });

    const fresh = await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } });
    expect(fresh.isActive).toBe(false);
    expect(fresh.deactivatedAt).not.toBeNull();

    const row = await soleAuditRow(app.prisma, {
      where: { entity: "Salon", entityId: salon.id, action: "DEACTIVATE" },
    });
    expect(row.userId).toBe(tenant.adminUser.id);
    expect(row.oldValue).toMatchObject({ isActive: true });
    expect(row.newValue).toMatchObject({ isActive: false });

    expect(await contextSalonIds(adminAuth())).not.toContain(salon.id);
  });

  it("activate reverses it: active again, one ACTIVATE audit row with the admin as actor, listed in the context again", async () => {
    const salon = await createTestSalon(app.prisma, tenant.tenant.id, { name: "Wieder aktiv" });
    expect((await post(`${salon.id}/deactivate`, adminAuth())).statusCode).toBe(200);
    expect(await contextSalonIds(adminAuth())).not.toContain(salon.id);

    const res = await post(`${salon.id}/activate`, adminAuth());
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id: salon.id, isActive: true });

    const fresh = await app.prisma.salon.findUniqueOrThrow({ where: { id: salon.id } });
    expect(fresh.isActive).toBe(true);

    const row = await soleAuditRow(app.prisma, {
      where: { entity: "Salon", entityId: salon.id, action: "ACTIVATE" },
    });
    expect(row.userId).toBe(tenant.adminUser.id);
    expect(row.newValue).toMatchObject({ isActive: true });

    expect(await contextSalonIds(adminAuth())).toContain(salon.id);
  });

  it("deactivating the tenant's last active salon answers 409 with the server's text and changes nothing", async () => {
    // A tenant with exactly one active salon: the fixture's own salon.
    const solo = await seedTestData(app, "salon-admin-563-life-solo");
    try {
      const res = await post(`${solo.salonId}/deactivate`, {
        authorization: `Bearer ${solo.adminToken}`,
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body)).toEqual({
        error: "Der letzte aktive Salon eines Mandanten kann nicht deaktiviert werden.",
      });
      const fresh = await app.prisma.salon.findUniqueOrThrow({ where: { id: solo.salonId } });
      expect(fresh.isActive).toBe(true);
      expect(await auditRowsFor(app, "Salon", solo.salonId, "DEACTIVATE")).toHaveLength(0);
    } finally {
      try {
        await cleanupTestData(app, solo.tenant.id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  it("activating a second salon in a Grundversion tenant (quota 1, one active salon) answers 409 SALON_QUOTA_REACHED and the salon stays inactive", async () => {
    // The only way to hold a second, inactive salon in a one-salon tenant is a direct fixture row:
    // neither route can produce it (deactivating the last active salon is refused).
    const inactive = await createTestSalon(app.prisma, grundversion.tenant.id, {
      name: "Inaktiv ohne Kette",
      isActive: false,
    });
    const res = await post(`${inactive.id}/activate`, {
      authorization: `Bearer ${grundversion.adminToken}`,
    });
    expect(res.statusCode, res.body).toBe(409);
    const body = JSON.parse(res.body) as { code: string; error: string };
    expect(body.code).toBe("SALON_QUOTA_REACHED");
    expect(body.error).toBe(SALON_QUOTA_REACHED_MESSAGE);
    const fresh = await app.prisma.salon.findUniqueOrThrow({ where: { id: inactive.id } });
    expect(fresh.isActive).toBe(false);
    expect(await auditRowsFor(app, "Salon", inactive.id, "ACTIVATE")).toHaveLength(0);
  });

  it("refuses the MANAGER on both actions with 403 and changes nothing", async () => {
    const active = await createTestSalon(app.prisma, tenant.tenant.id, { name: "Manager aktiv" });
    const inactive = await createTestSalon(app.prisma, tenant.tenant.id, {
      name: "Manager inaktiv",
      isActive: false,
    });
    const managerAuth = { authorization: `Bearer ${managerToken}` };

    expect((await post(`${active.id}/deactivate`, managerAuth)).statusCode).toBe(403);
    expect((await post(`${inactive.id}/activate`, managerAuth)).statusCode).toBe(403);

    expect((await app.prisma.salon.findUniqueOrThrow({ where: { id: active.id } })).isActive).toBe(
      true,
    );
    expect(
      (await app.prisma.salon.findUniqueOrThrow({ where: { id: inactive.id } })).isActive,
    ).toBe(false);
    expect(await auditRowsFor(app, "Salon", active.id, "DEACTIVATE")).toHaveLength(0);
    expect(await auditRowsFor(app, "Salon", inactive.id, "ACTIVATE")).toHaveLength(0);
  });

  it("answers a foreign tenant's salon id and an unknown id with the identical 404 on both actions", async () => {
    for (const action of ["deactivate", "activate"]) {
      const foreign = await post(`${otherTenant.salonId}/${action}`, adminAuth());
      const unknown = await post(`${randomUUID()}/${action}`, adminAuth());
      expect(foreign.statusCode, action).toBe(404);
      expect(unknown.statusCode, action).toBe(404);
      expect(foreign.body, action).toBe(unknown.body);
    }
    // The foreign salon was not touched.
    const fresh = await app.prisma.salon.findUniqueOrThrow({ where: { id: otherTenant.salonId } });
    expect(fresh.isActive).toBe(true);
  });
});
