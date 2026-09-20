/**
 * fix(sec-03): PUT /api/v1/shifts/:id loaded the target row via an unfiltered
 * `shift.findUnique({ where: { id } })`. The only downstream tenant check
 * (`arbzgEmp = findFirst({ id: effEmployeeId, tenantId })`) validates the NEW
 * (possibly attacker-supplied) employeeId, not the loaded row's real owner — so a
 * caller who additionally set `employeeId` to one of their OWN employees could
 * reassign a foreign tenant's shift onto their own tenant. Fixed to check the
 * loaded row's real owner before any further step, mirroring overtime.ts (Shift
 * itself has no tenantId column — go via employee).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { dowOf, futureDateStr, nextWeekdayStr } from "./test-dates";
import type { FastifyInstance } from "fastify";

/**
 * The next date on which a shift may actually be created (#271).
 *
 * This used to be a plain "tomorrow", which is a date bomb: `TenantConfig.storeHours` defaults to
 * Sunday CLOSED (`packages/db/prisma/schema.prisma`, day 6 of the 0=Mo..6=So array), `seedTestData()`
 * does not override it, and `POST`/`PUT /api/v1/shifts` answers 409 "Schicht ... ausserhalb der
 * Oeffnungszeiten - Geschaeft geschlossen" for a closed day. So these tests failed every Saturday
 * and passed on the other six days, which is why CI went red while every local re-run looked fine.
 *
 * `nextWeekdayStr` skips Saturday as well. That is deliberate: the store default has Saturday open,
 * but a tenant config in a future fixture may not, and none of these tests is about opening hours.
 */
function nextOpenDayIso(): string {
  return nextWeekdayStr(futureDateStr(1));
}

const GENUINELY_MISSING_SHIFT_ID = "00000000-0000-4000-8000-000000000003";

describe("PUT /api/v1/shifts/:id — tenant isolation (sec-03)", () => {
  // #271: the property this file silently depended on for years, now re-proved on every run.
  // A shift may not be created on a store-closed day, and the store default closes Sunday — so a
  // date that drifts onto one turns every assertion below into a 409 that says nothing about
  // tenant isolation. Same guard idiom as shift-arbzg.test.ts (GH #136/#167).
  it("the shift date lands on a day the store is open (guards against the Sunday date bomb)", () => {
    expect(nextOpenDayIso() > new Date().toISOString().slice(0, 10)).toBe(true);
    expect([1, 2, 3, 4, 5]).toContain(dowOf(nextOpenDayIso()));
  });
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  let victimShiftId: string;

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "sec03-a");
    tenantB = await seedTestData(app, "sec03-b");

    // Both employees need to be SHIFT_BASED for the eligibility gate the route
    // still runs downstream of the tenant guard.
    for (const t of [tenantA, tenantB]) {
      await app.prisma.workSchedule.create({
        data: {
          employeeId: t.employee.id,
          type: "SHIFT_BASED",
          weeklyHours: 40,
          // Later than seedTestData's default 2024-01-01 FIXED_SCHEDULE row, so this
          // one wins the `orderBy: { validFrom: "desc" }` tie the eligibility check uses.
          validFrom: new Date("2024-06-01"),
        },
      });
    }

    const victimShift = await app.prisma.shift.create({
      data: {
        employeeId: tenantB.employee.id,
        date: new Date(nextOpenDayIso()),
        startTime: "08:00",
        endTime: "16:00",
        note: "victim-original",
      },
    });
    victimShiftId = victimShift.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantA failed:", err);
    }
    try {
      await cleanupTestData(app, tenantB.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantB failed:", err);
    }
  });

  it("tenantA ADMIN updating tenantB's shift (no employeeId in body) → 404, row untouched, audit", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/shifts/${victimShiftId}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: { note: "attacker-edit" },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Schicht nicht gefunden" });

    const victimAfter = await app.prisma.shift.findUnique({ where: { id: victimShiftId } });
    expect(victimAfter?.note).toBe("victim-original");

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "CROSS_TENANT_ACCESS_DENIED", entity: "Shift", entityId: victimShiftId },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.userId).toBe(tenantA.adminUser.id);
  });

  it("tenantA ADMIN cannot hijack tenantB's shift by also setting employeeId to their OWN employee → 404, row untouched", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/shifts/${victimShiftId}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: { employeeId: tenantA.employee.id, note: "hijack-attempt" },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Schicht nicht gefunden" });

    const victimAfter = await app.prisma.shift.findUnique({ where: { id: victimShiftId } });
    expect(victimAfter?.employeeId).toBe(tenantB.employee.id);
    expect(victimAfter?.note).toBe("victim-original");
  });

  it("the cross-tenant 404 is byte-identical to a genuine not-found 404 (no existence oracle)", async () => {
    const crossTenantRes = await app.inject({
      method: "PUT",
      url: `/api/v1/shifts/${victimShiftId}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: { note: "probe" },
    });

    const notFoundRes = await app.inject({
      method: "PUT",
      url: `/api/v1/shifts/${GENUINELY_MISSING_SHIFT_ID}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: { note: "probe" },
    });

    expect(crossTenantRes.statusCode).toBe(notFoundRes.statusCode);
    expect(JSON.parse(crossTenantRes.body)).toEqual(JSON.parse(notFoundRes.body));
  });

  it("the same call by tenantB's OWN ADMIN still succeeds exactly as before (no regression)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/shifts/${victimShiftId}`,
      headers: { authorization: `Bearer ${tenantB.adminToken}` },
      payload: { note: "legit-edit" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.note).toBe("legit-edit");

    const victimAfter = await app.prisma.shift.findUnique({ where: { id: victimShiftId } });
    expect(victimAfter?.note).toBe("legit-edit");
  });
});
