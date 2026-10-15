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
  cleanupTestData,
  createTestSalon,
  soleAuditRow,
  auditRowsFor,
} from "./setup";
import { DEFAULT_SALON_OPENING_HOURS } from "../contexts/platform/facade/salons";

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
    const mgrEmployee = await app.prisma.employee.create({
      data: {
        tenantId: tenant.tenant.id,
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
    managerToken = JSON.parse(loginRes.body).accessToken;
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
