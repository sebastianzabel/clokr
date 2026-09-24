/**
 * Phase 325 Plan 01 (issue #325), D-04/D-05/D-09 — tracer: a new Shift lands on the tenant's
 * default salon, end to end (schema -> migration backfill -> `findDefaultSalon` Unterbau facade
 * -> `POST /api/v1/shifts` route -> test infrastructure). Later plans in this phase extend this
 * file (explicit `salonId` body field, per-salon store-hours check, Phorest sync proofs).
 *
 * "Default salon" (D-04) = the tenant's earliest-created ACTIVE salon (createdAt asc, id asc tie
 * break) — the same fixture shape as `sec-03-shifts-put-tenant.test.ts` (SHIFT_BASED WorkSchedule
 * with a later validFrom; a future weekday date via `./test-dates`, never a hardcoded date).
 *
 * Phase 325 Plan 02 (issue #325), D-05/D-06/D-07/D-08/D-09 — extends the tracer above with the
 * explicit, body-supplied `salonId` on POST/PUT/bulk: tenant-scoped resolution (foreign vs
 * nonexistent byte-identical, T-100-09), the inactive-salon rule (D-07), and the bulk
 * employee-tenant guard the salon invariant needs (AC-1/AC-3).
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { futureDateStr, nextWeekdayStr, addDaysStr } from "./test-dates";
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

describe("POST/PUT/bulk /api/v1/shifts — explicit salonId (Phase 325 Plan 02, issue #325)", () => {
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

  it("D-06: POST with a foreign tenant's real salon vs a random UUID — byte-identical 404 (same as GET /salons/:id), no row, no audit", async () => {
    const seedA = await seedTestData(app, "shift-salon-post-foreign-a");
    cleanupTenantIds.push(seedA.tenant.id);
    const seedB = await seedTestData(app, "shift-salon-post-foreign-b");
    cleanupTenantIds.push(seedB.tenant.id);
    await makeShiftEligible(app, seedA.employee.id);

    const date = nextOpenDayIso();
    const before = await app.prisma.shift.count({ where: { employeeId: seedA.employee.id } });
    const auditBefore = await app.prisma.auditLog.count({ where: { entity: "Shift" } });

    const foreignRes = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${seedA.adminToken}` },
      payload: {
        employeeId: seedA.employee.id,
        date,
        startTime: "08:00",
        endTime: "16:00",
        salonId: seedB.salonId,
      },
    });
    const randomId = randomUUID();
    const randomRes = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${seedA.adminToken}` },
      payload: {
        employeeId: seedA.employee.id,
        date,
        startTime: "08:00",
        endTime: "16:00",
        salonId: randomId,
      },
    });

    expect(foreignRes.statusCode).toBe(404);
    expect(randomRes.statusCode).toBe(404);
    expect(foreignRes.body).toBe(randomRes.body);

    const salonGetRes = await app.inject({
      method: "GET",
      url: `/api/v1/salons/${randomId}`,
      headers: { authorization: `Bearer ${seedA.adminToken}` },
    });
    expect(salonGetRes.statusCode).toBe(404);
    expect(JSON.parse(foreignRes.body)).toEqual(JSON.parse(salonGetRes.body));

    const after = await app.prisma.shift.count({ where: { employeeId: seedA.employee.id } });
    expect(after).toBe(before);
    const auditAfter = await app.prisma.auditLog.count({ where: { entity: "Shift" } });
    expect(auditAfter).toBe(auditBefore);
  });

  it("D-06: PUT with a foreign salon vs a random UUID — byte-identical 404, row untouched", async () => {
    const seedA = await seedTestData(app, "shift-salon-put-foreign-a");
    cleanupTenantIds.push(seedA.tenant.id);
    const seedB = await seedTestData(app, "shift-salon-put-foreign-b");
    cleanupTenantIds.push(seedB.tenant.id);
    await makeShiftEligible(app, seedA.employee.id);

    const date = nextOpenDayIso();
    const shift = await app.prisma.shift.create({
      data: {
        employeeId: seedA.employee.id,
        salonId: seedA.salonId,
        date: new Date(date),
        startTime: "08:00",
        endTime: "16:00",
      },
    });

    const foreignRes = await app.inject({
      method: "PUT",
      url: `/api/v1/shifts/${shift.id}`,
      headers: { authorization: `Bearer ${seedA.adminToken}` },
      payload: { salonId: seedB.salonId },
    });
    const randomRes = await app.inject({
      method: "PUT",
      url: `/api/v1/shifts/${shift.id}`,
      headers: { authorization: `Bearer ${seedA.adminToken}` },
      payload: { salonId: randomUUID() },
    });

    expect(foreignRes.statusCode).toBe(404);
    expect(randomRes.statusCode).toBe(404);
    expect(foreignRes.body).toBe(randomRes.body);

    const row = await app.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(row.salonId).toBe(seedA.salonId);
  });

  it("D-06/D-08: POST /bulk with a foreign salonId vs a random UUID — byte-identical 404, zero rows created", async () => {
    const seedA = await seedTestData(app, "shift-salon-bulk-foreign-a");
    cleanupTenantIds.push(seedA.tenant.id);
    const seedB = await seedTestData(app, "shift-salon-bulk-foreign-b");
    cleanupTenantIds.push(seedB.tenant.id);
    await makeShiftEligible(app, seedA.employee.id);

    const date = nextOpenDayIso();
    const before = await app.prisma.shift.count({ where: { employeeId: seedA.employee.id } });

    const payloadWith = (salonId: string) => ({
      shifts: [
        { employeeId: seedA.employee.id, date, startTime: "08:00", endTime: "16:00" },
        {
          employeeId: seedA.employee.id,
          date: addDaysStr(date, 1),
          startTime: "08:00",
          endTime: "16:00",
          salonId,
        },
      ],
    });

    const foreignRes = await app.inject({
      method: "POST",
      url: "/api/v1/shifts/bulk",
      headers: { authorization: `Bearer ${seedA.adminToken}` },
      payload: payloadWith(seedB.salonId),
    });
    const randomRes = await app.inject({
      method: "POST",
      url: "/api/v1/shifts/bulk",
      headers: { authorization: `Bearer ${seedA.adminToken}` },
      payload: payloadWith(randomUUID()),
    });

    expect(foreignRes.statusCode).toBe(404);
    expect(randomRes.statusCode).toBe(404);
    expect(foreignRes.body).toBe(randomRes.body);

    const after = await app.prisma.shift.count({ where: { employeeId: seedA.employee.id } });
    expect(after).toBe(before);
  });

  it("D-08/AC-1/AC-3: POST /bulk with an employeeId from another tenant — 404 Mitarbeiter nicht gefunden, zero rows", async () => {
    const seedA = await seedTestData(app, "shift-salon-bulk-emp-a");
    cleanupTenantIds.push(seedA.tenant.id);
    const seedB = await seedTestData(app, "shift-salon-bulk-emp-b");
    cleanupTenantIds.push(seedB.tenant.id);
    await makeShiftEligible(app, seedA.employee.id);
    await makeShiftEligible(app, seedB.employee.id);

    const date = nextOpenDayIso();
    const before = await app.prisma.shift.count({
      where: { employeeId: { in: [seedA.employee.id, seedB.employee.id] } },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts/bulk",
      headers: { authorization: `Bearer ${seedA.adminToken}` },
      payload: {
        shifts: [
          { employeeId: seedA.employee.id, date, startTime: "08:00", endTime: "16:00" },
          { employeeId: seedB.employee.id, date, startTime: "08:00", endTime: "16:00" },
        ],
      },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Mitarbeiter nicht gefunden" });

    const after = await app.prisma.shift.count({
      where: { employeeId: { in: [seedA.employee.id, seedB.employee.id] } },
    });
    expect(after).toBe(before);
  });

  it("D-07: POST with an own DEACTIVATED salon → 422 SALON_INACTIVE, no row", async () => {
    const seed = await seedTestData(app, "shift-salon-post-inactive");
    cleanupTenantIds.push(seed.tenant.id);
    await makeShiftEligible(app, seed.employee.id);

    const inactiveSalon = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Inaktiver Salon",
      isActive: false,
    });

    const date = nextOpenDayIso();
    const before = await app.prisma.shift.count({ where: { employeeId: seed.employee.id } });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        employeeId: seed.employee.id,
        date,
        startTime: "08:00",
        endTime: "16:00",
        salonId: inactiveSalon.id,
      },
    });

    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body)).toEqual({
      error: "Salon ist deaktiviert",
      code: "SALON_INACTIVE",
    });

    const after = await app.prisma.shift.count({ where: { employeeId: seed.employee.id } });
    expect(after).toBe(before);
  });

  it("D-07/D-08: POST /bulk with an own DEACTIVATED salon item → 422 SALON_INACTIVE, zero rows", async () => {
    const seed = await seedTestData(app, "shift-salon-bulk-inactive");
    cleanupTenantIds.push(seed.tenant.id);
    await makeShiftEligible(app, seed.employee.id);
    const inactiveSalon = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Inaktiver Salon Bulk",
      isActive: false,
    });

    const date = nextOpenDayIso();
    const before = await app.prisma.shift.count({ where: { employeeId: seed.employee.id } });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts/bulk",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        shifts: [
          { employeeId: seed.employee.id, date, startTime: "08:00", endTime: "16:00" },
          {
            employeeId: seed.employee.id,
            date: addDaysStr(date, 1),
            startTime: "08:00",
            endTime: "16:00",
            salonId: inactiveSalon.id,
          },
        ],
      },
    });

    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body)).toEqual({
      error: "Salon ist deaktiviert",
      code: "SALON_INACTIVE",
    });

    const after = await app.prisma.shift.count({ where: { employeeId: seed.employee.id } });
    expect(after).toBe(before);
  });

  it("D-07: PUT changing to an own DEACTIVATED salon → 422 SALON_INACTIVE, salon unchanged", async () => {
    const seed = await seedTestData(app, "shift-salon-put-inactive");
    cleanupTenantIds.push(seed.tenant.id);
    await makeShiftEligible(app, seed.employee.id);
    const inactiveSalon = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Inaktiver Salon PUT",
      isActive: false,
    });

    const date = nextOpenDayIso();
    const shift = await app.prisma.shift.create({
      data: {
        employeeId: seed.employee.id,
        salonId: seed.salonId,
        date: new Date(date),
        startTime: "08:00",
        endTime: "16:00",
      },
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/shifts/${shift.id}`,
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: { salonId: inactiveSalon.id },
    });

    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body)).toEqual({
      error: "Salon ist deaktiviert",
      code: "SALON_INACTIVE",
    });

    const row = await app.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(row.salonId).toBe(seed.salonId);
  });

  it("POST with an own active NON-DEFAULT salon → 201 on that salon; CREATE audit carries it", async () => {
    const seed = await seedTestData(app, "shift-salon-post-nondefault");
    cleanupTenantIds.push(seed.tenant.id);
    await makeShiftEligible(app, seed.employee.id);
    const secondSalon = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Zweitsalon",
      createdAt: new Date(Date.now() + 60_000),
    });

    const date = nextOpenDayIso();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        employeeId: seed.employee.id,
        date,
        startTime: "08:00",
        endTime: "16:00",
        salonId: secondSalon.id,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.salonId).toBe(secondSalon.id);

    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "Shift", entityId: body.id, action: "CREATE" },
    });
    expect((audit?.newValue as { salonId?: string } | null)?.salonId).toBe(secondSalon.id);
  });

  it("PUT with a new own ACTIVE salonId → 200, audit records old and new salonId", async () => {
    const seed = await seedTestData(app, "shift-salon-put-change");
    cleanupTenantIds.push(seed.tenant.id);
    await makeShiftEligible(app, seed.employee.id);
    const secondSalon = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Zweitsalon PUT",
      createdAt: new Date(Date.now() + 60_000),
    });

    const date = nextOpenDayIso();
    const shift = await app.prisma.shift.create({
      data: {
        employeeId: seed.employee.id,
        salonId: seed.salonId,
        date: new Date(date),
        startTime: "08:00",
        endTime: "16:00",
      },
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/shifts/${shift.id}`,
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: { salonId: secondSalon.id },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.salonId).toBe(secondSalon.id);

    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "Shift", entityId: shift.id, action: "UPDATE" },
      orderBy: { createdAt: "desc" },
    });
    expect((audit?.oldValue as { salonId?: string } | null)?.salonId).toBe(seed.salonId);
    expect((audit?.newValue as { salonId?: string } | null)?.salonId).toBe(secondSalon.id);
  });

  it("D-05/D-07: PUT {note} without salonId leaves salonId unchanged, even after that salon is deactivated", async () => {
    const seed = await seedTestData(app, "shift-salon-put-note-only");
    cleanupTenantIds.push(seed.tenant.id);
    await makeShiftEligible(app, seed.employee.id);

    const date = nextOpenDayIso();
    const shift = await app.prisma.shift.create({
      data: {
        employeeId: seed.employee.id,
        salonId: seed.salonId,
        date: new Date(date),
        startTime: "08:00",
        endTime: "16:00",
      },
    });

    // Deactivate AFTER the shift was created on it — direct write, deliberately bypassing the
    // route-level "last active salon cannot be deactivated" guard (same fixture idiom as the
    // D-04 tracer test above).
    await app.prisma.salon.update({
      where: { id: seed.salonId },
      data: { isActive: false, deactivatedAt: new Date() },
    });

    const res1 = await app.inject({
      method: "PUT",
      url: `/api/v1/shifts/${shift.id}`,
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: { note: "nur eine Notiz" },
    });
    expect(res1.statusCode).toBe(200);
    expect(JSON.parse(res1.body).salonId).toBe(seed.salonId);

    // PUT with the SAME (now-inactive) salonId explicitly — also allowed (D-07: an unchanged
    // salonId is never rejected).
    const res2 = await app.inject({
      method: "PUT",
      url: `/api/v1/shifts/${shift.id}`,
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: { salonId: seed.salonId },
    });
    expect(res2.statusCode).toBe(200);
    expect(JSON.parse(res2.body).salonId).toBe(seed.salonId);
  });

  it("POST with salonId 'not-a-uuid' → 400 (Zod), never 404", async () => {
    const seed = await seedTestData(app, "shift-salon-post-badformat");
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
        salonId: "not-a-uuid",
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
