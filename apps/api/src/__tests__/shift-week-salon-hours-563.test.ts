/**
 * Issue #563 (Phase 563 Plan 03, D-15, AC-563-2) — `GET /api/v1/shifts/week` carries the opening
 * hours of the tenant's ACTIVE salons inside the caller's `shift:read:ZUGEWIESEN` reach, so the
 * week view can dim closed days per salon without a second endpoint (`GET /salons` is closed to
 * scoped planners).
 *
 * Synthetic names only (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";

const PASSWORD = "test1234";
const WEEK_URL = "/api/v1/shifts/week?date=2026-06-08";

const HOURS_S1 = [
  { day: 0, open: "09:00", close: "18:00" },
  { day: 1, open: "09:00", close: "18:00" },
  { day: 2, open: "09:00", close: "18:00" },
  { day: 3, open: "09:00", close: "18:00" },
  { day: 4, open: "09:00", close: "18:00" },
  { day: 5, open: "09:00", close: "14:00" },
  { day: 6, open: "09:00", close: "14:00", closed: true },
];
const HOURS_S2 = [
  { day: 0, open: "10:00", close: "19:00", closed: true },
  { day: 1, open: "10:00", close: "19:00" },
  { day: 2, open: "10:00", close: "19:00" },
  { day: 3, open: "10:00", close: "19:00" },
  { day: 4, open: "10:00", close: "19:00" },
  { day: 5, open: "10:00", close: "16:00" },
  { day: 6, open: "10:00", close: "16:00", closed: true },
];

type SeedWithoutSalon = Awaited<ReturnType<typeof seedWithoutDefaultSalon>>;

// `withDefaultSalon: false` leaves the tenant with exactly the salons this file creates.
function seedWithoutDefaultSalon(app: FastifyInstance, suffix: string) {
  return seedTestData(app, suffix, { withDefaultSalon: false });
}

type WeekSalon = { salonId: string; name: string; openingHours: unknown };

describe("Issue #563 — GET /shifts/week salonOpeningHours", () => {
  let app: FastifyInstance;
  let data: SeedWithoutSalon;
  let other: Awaited<ReturnType<typeof seedTestData>>;
  let s1: { id: string };
  let s2: { id: string };
  let s3Inactive: { id: string };
  let foreignSalon: { id: string };

  async function createScopedManager(
    label: string,
    scope: { scopeType: "SALONS" | "PERSONS"; salonIds?: string[]; employeeIds?: string[] },
  ) {
    const suffix = `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await app.prisma.user.create({
      data: { email: `${suffix}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: suffix.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "WeekHoursTest",
        hireDate: new Date("2020-01-01"),
      },
    });
    const name = `WeekHours ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(["shift:read:ZUGEWIESEN"]),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        accessRoleId: role.id,
        scopeType: scope.scopeType,
        salonIds: scope.salonIds ?? [],
        employeeIds: scope.employeeIds ?? [],
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: user.email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  async function getWeek(token: string) {
    const res = await app.inject({
      method: "GET",
      url: WEEK_URL,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as Record<string, unknown> & {
      salonOpeningHours: WeekSalon[];
      shifts: Array<{ id: string }>;
      employees: Array<{ id: string }>;
    };
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedWithoutDefaultSalon(app, "shwh");
    other = await seedTestData(app, "shwx");
    s1 = await createTestSalon(app.prisma, data.tenant.id, {
      name: "WeekHours Salon Eins",
      openingHours: HOURS_S1,
    });
    s2 = await createTestSalon(app.prisma, data.tenant.id, {
      name: "WeekHours Salon Zwei",
      openingHours: HOURS_S2,
    });
    s3Inactive = await createTestSalon(app.prisma, data.tenant.id, {
      name: "WeekHours Salon Drei",
      isActive: false,
    });
    foreignSalon = { id: other.salonId };
  });

  afterAll(async () => {
    for (const tenantId of [data?.tenant.id, other?.tenant.id]) {
      if (!tenantId) continue;
      try {
        await cleanupTestData(app, tenantId);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
    await closeTestApp();
  });

  it("the admin sees exactly the active salons, in creation order, with their stored hours", async () => {
    const body = await getWeek(data.adminToken);
    expect(body.salonOpeningHours).toEqual([
      { salonId: s1.id, name: "WeekHours Salon Eins", openingHours: HOURS_S1 },
      { salonId: s2.id, name: "WeekHours Salon Zwei", openingHours: HOURS_S2 },
    ]);
    const ids = body.salonOpeningHours.map((s) => s.salonId);
    expect(ids).not.toContain(s3Inactive.id);
  });

  it("a salon-scoped planner sees only the salons of its reach", async () => {
    const token = await createScopedManager("wh-salons", {
      scopeType: "SALONS",
      salonIds: [s2.id],
    });
    const body = await getWeek(token);
    expect(body.salonOpeningHours.map((s) => s.salonId)).toEqual([s2.id]);
    expect(body.salonOpeningHours[0].openingHours).toEqual(HOURS_S2);
  });

  it("a person-only reach (no salons) gets an empty list", async () => {
    const token = await createScopedManager("wh-persons", {
      scopeType: "PERSONS",
      employeeIds: [data.employee.id],
    });
    const body = await getWeek(token);
    expect(body.salonOpeningHours).toEqual([]);
  });

  it("a scoped reach naming an inactive salon of the tenant does not reveal it", async () => {
    const token = await createScopedManager("wh-inactive", {
      scopeType: "SALONS",
      salonIds: [s3Inactive.id],
    });
    const body = await getWeek(token);
    expect(body.salonOpeningHours).toEqual([]);
  });

  it("a foreign tenant's salon never appears, not even when a reach names its id", async () => {
    const adminBody = await getWeek(data.adminToken);
    expect(adminBody.salonOpeningHours.map((s) => s.salonId)).not.toContain(foreignSalon.id);

    const token = await createScopedManager("wh-foreign", {
      scopeType: "SALONS",
      salonIds: [s1.id, foreignSalon.id],
    });
    const body = await getWeek(token);
    expect(body.salonOpeningHours.map((s) => s.salonId)).not.toContain(foreignSalon.id);
  });

  it("the response key set is the previous one plus salonOpeningHours; shifts and employees are unchanged", async () => {
    const body = await getWeek(data.adminToken);
    expect(Object.keys(body).sort()).toEqual(
      [
        "absenceMinutesByEmp",
        "availability",
        "contractSollMinutesByEmp",
        "coverage",
        "employees",
        "leaveMinutesByEmp",
        "salonOpeningHours",
        "schoolHoliday",
        "shiftBreakMinutesByEmp",
        "shifts",
        "vocationalSchoolMinutesByEmp",
        "weekDays",
      ].sort(),
    );
    // The field is display data only: it adds a key and narrows no list the response already had.
    expect(Array.isArray(body.employees)).toBe(true);
    expect(Array.isArray(body.shifts)).toBe(true);
  });
});
