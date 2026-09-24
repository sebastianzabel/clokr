/**
 * Phase 325 Plan 01 (issue #325), D-04/D-05/D-09 — tracer: a new Shift lands on the tenant's
 * default salon, end to end (schema -> migration backfill -> `findDefaultSalon` Unterbau facade
 * -> `POST /api/v1/shifts` route -> test infrastructure). Later plans in this phase extend this
 * file (explicit `salonId` body field, per-salon store-hours check, Phorest sync proofs).
 *
 * "Default salon" (D-04) = the tenant's earliest-created ACTIVE salon (createdAt asc, id asc tie
 * break) — the same fixture shape as `sec-03-shifts-put-tenant.test.ts` (SHIFT_BASED WorkSchedule
 * with a later validFrom; a future weekday date via `./test-dates`, never a hardcoded date).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { futureDateStr, nextWeekdayStr } from "./test-dates";
import type { FastifyInstance } from "fastify";

/** The next date on which a shift may actually be created (#271 — see sec-03's own comment). */
function nextOpenDayIso(): string {
  return nextWeekdayStr(futureDateStr(1));
}

/** Only SHIFT_BASED employees pass the route's eligibility gate (shifts.ts:assertEmployeeShiftEligible). */
async function makeShiftEligible(app: FastifyInstance, employeeId: string): Promise<void> {
  await app.prisma.workSchedule.create({
    data: {
      employeeId,
      type: "SHIFT_BASED",
      weeklyHours: 40,
      // Later than seedTestData's default 2024-01-01 FIXED_SCHEDULE row, so this one wins the
      // `orderBy: { validFrom: "desc" }` tie the eligibility check uses.
      validFrom: new Date("2024-06-01"),
    },
  });
}

describe("POST /api/v1/shifts — default-salon tracer (Phase 325, issue #325)", () => {
  let app: FastifyInstance;
  const cleanupTenantIds: string[] = [];

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    for (const tenantId of cleanupTenantIds) {
      try {
        await cleanupTestData(app, tenantId);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  it("without salonId in the body, the created shift and its CREATE audit both carry the tenant's default salon", async () => {
    const seed = await seedTestData(app, "shift-salon-default");
    cleanupTenantIds.push(seed.tenant.id);
    await makeShiftEligible(app, seed.employee.id);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        employeeId: seed.employee.id,
        date: nextOpenDayIso(),
        startTime: "08:00",
        endTime: "16:00",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.salonId).toBe(seed.salonId);

    const row = await app.prisma.shift.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.salonId).toBe(seed.salonId);

    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "Shift", entityId: body.id, action: "CREATE" },
    });
    expect(audit).not.toBeNull();
    expect((audit?.newValue as { salonId?: string } | null)?.salonId).toBe(seed.salonId);
  });

  it("D-04: a second ACTIVE salon created later does not change the default — earliest wins", async () => {
    const seed = await seedTestData(app, "shift-salon-later");
    cleanupTenantIds.push(seed.tenant.id);
    await makeShiftEligible(app, seed.employee.id);

    await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Later Salon",
      createdAt: new Date(Date.now() + 60_000),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        employeeId: seed.employee.id,
        date: nextOpenDayIso(),
        startTime: "08:00",
        endTime: "16:00",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.salonId).toBe(seed.salonId);
  });

  it("D-04: once the earliest salon is deactivated, the next-earliest ACTIVE salon becomes the default", async () => {
    const seed = await seedTestData(app, "shift-salon-deact");
    cleanupTenantIds.push(seed.tenant.id);
    await makeShiftEligible(app, seed.employee.id);

    const laterSalon = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Later Active Salon",
      createdAt: new Date(Date.now() + 60_000),
    });
    // Direct write (not the API) — deliberately bypasses the "last active salon cannot be
    // deactivated" route-level guard, which is exactly what this fixture needs to construct.
    await app.prisma.salon.update({
      where: { id: seed.salonId },
      data: { isActive: false, deactivatedAt: new Date() },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        employeeId: seed.employee.id,
        date: nextOpenDayIso(),
        startTime: "08:00",
        endTime: "16:00",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.salonId).toBe(laterSalon.id);
  });

  it("D-04/D-05: with every salon of the tenant inactive, POST answers 409 NO_ACTIVE_SALON and writes no row", async () => {
    const seed = await seedTestData(app, "shift-salon-noactive");
    cleanupTenantIds.push(seed.tenant.id);
    await makeShiftEligible(app, seed.employee.id);

    await app.prisma.salon.update({
      where: { id: seed.salonId },
      data: { isActive: false, deactivatedAt: new Date() },
    });

    const date = nextOpenDayIso();
    const before = await app.prisma.shift.count({
      where: { employeeId: seed.employee.id, date: new Date(date) },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        employeeId: seed.employee.id,
        date,
        startTime: "08:00",
        endTime: "16:00",
      },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: "Kein aktiver Salon vorhanden.",
      code: "NO_ACTIVE_SALON",
    });

    const after = await app.prisma.shift.count({
      where: { employeeId: seed.employee.id, date: new Date(date) },
    });
    expect(after).toBe(before);
  });
});
