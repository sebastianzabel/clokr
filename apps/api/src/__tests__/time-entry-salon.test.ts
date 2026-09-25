/**
 * Phase 68b (issue #68), D-06/D-08/D-09/D-13 — end-to-end tracer for `resolveEntrySalon` through
 * the clock resolver's START branch: a MOBILE clock-in on a Thursday lands on the employee's
 * DEPLOYMENT salon for that weekday, on a Monday it lands on the HOME salon, an employee with no
 * assignment row at all falls back to the tenant's default salon, and a tenant with no active
 * salon gets a clean 409 with no row written. Plan 02 extends this file with the explicit
 * `salonId` input paths (POST, CSV, PUT).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { addDaysStr, mondayOfWeekStr, TEST_TZ } from "./test-dates";

describe("time-entry-salon tracer (Phase 68b, issue #68)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let noSalonTenant: Awaited<ReturnType<typeof seedTestData>>;

  // Last week's Monday/Thursday — always in the past, regardless of when the suite runs.
  const monday = addDaysStr(mondayOfWeekStr(), -7);
  const thursday = addDaysStr(monday, 3);

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "tes"); // seed.salonId = the tenant's default salon (D)

    // A and B are created AFTER the default salon D (seedTestData already ran), so D stays the
    // earliest-created ACTIVE salon — the fallback `findDefaultSalon` answer.
    salonA = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon A",
      createdAt: new Date(),
    });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon B",
      createdAt: new Date(),
    });

    // HOME -> A, open-ended from 2024-01-01.
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
    // DEPLOYMENT -> B on Thursdays only (weekdays: 0=Monday..6=Sunday, so Thursday = 3).
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        employeeId: seed.employee.id,
        salonId: salonB.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2024-01-01"),
        validUntil: null,
        weekdays: [3],
      },
    });

    // A second tenant whose only salon is deactivated directly — NO_ACTIVE_SALON fixture.
    noSalonTenant = await seedTestData(app, "tes-none");
    await app.prisma.salon.updateMany({
      where: { tenantId: noSalonTenant.tenant.id },
      data: { isActive: false, deactivatedAt: new Date() },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    try {
      await cleanupTestData(app, noSalonTenant.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("D-08/D-09: Thursday MOBILE clock-in lands on the DEPLOYMENT salon (B)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fromZonedTime(`${thursday}T09:00:00`, TEST_TZ));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: { source: "MOBILE" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        resolution: { kind: string; entry: { id: string; salonId: string } };
      };
      expect(body.resolution.kind).toBe("CLOCKED_IN");
      expect(body.resolution.entry.salonId).toBe(salonB.id);

      const row = await app.prisma.timeEntry.findUniqueOrThrow({
        where: { id: body.resolution.entry.id },
      });
      expect(row.salonId).toBe(salonB.id);

      // D-13: the CLOCK_IN audit's newValue is the full row, so it carries salonId too.
      const audit = await app.prisma.auditLog.findFirst({
        where: { entity: "TimeEntry", entityId: row.id, action: "CLOCK_IN" },
        orderBy: { createdAt: "desc" },
      });
      expect((audit?.newValue as { salonId?: string } | null)?.salonId).toBe(salonB.id);
    } finally {
      vi.useRealTimers();
      await app.prisma.timeEntry.deleteMany({ where: { employeeId: seed.employee.id } });
    }
  });

  it("D-08/D-09: Monday MOBILE clock-in lands on the HOME salon (A)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fromZonedTime(`${monday}T09:00:00`, TEST_TZ));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: { source: "MOBILE" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        resolution: { kind: string; entry: { id: string; salonId: string } };
      };
      expect(body.resolution.kind).toBe("CLOCKED_IN");
      expect(body.resolution.entry.salonId).toBe(salonA.id);

      const row = await app.prisma.timeEntry.findUniqueOrThrow({
        where: { id: body.resolution.entry.id },
      });
      expect(row.salonId).toBe(salonA.id);
    } finally {
      vi.useRealTimers();
      await app.prisma.timeEntry.deleteMany({ where: { employeeId: seed.employee.id } });
    }
  });

  it("D-08: an employee with no assignment row at all falls back to the tenant default salon (D)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fromZonedTime(`${monday}T09:00:00`, TEST_TZ));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: { authorization: `Bearer ${seed.adminToken}` },
        payload: { employeeId: seed.adminEmployee.id, source: "MOBILE" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        resolution: { kind: string; entry: { id: string; salonId: string } };
      };
      expect(body.resolution.kind).toBe("CLOCKED_IN");
      expect(body.resolution.entry.salonId).toBe(seed.salonId);
    } finally {
      vi.useRealTimers();
      await app.prisma.timeEntry.deleteMany({ where: { employeeId: seed.adminEmployee.id } });
    }
  });

  it("D-08: a tenant with no active salon answers 409 NO_ACTIVE_SALON and writes no row", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fromZonedTime(`${monday}T09:00:00`, TEST_TZ));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: { authorization: `Bearer ${noSalonTenant.empToken}` },
        payload: { source: "MOBILE" },
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({
        error: "Kein aktiver Salon vorhanden.",
        code: "NO_ACTIVE_SALON",
        resolution: { kind: "CONFLICT", reason: "NO_ACTIVE_SALON" },
      });

      const rows = await app.prisma.timeEntry.findMany({
        where: { employeeId: noSalonTenant.employee.id },
      });
      expect(rows).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
