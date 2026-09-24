/**
 * fix(sec-02): DELETE /api/v1/shifts/:id loaded the target row via an unfiltered
 * `shift.findUnique({ where: { id } })` and never compared the owning employee's
 * tenantId against the caller's — any ADMIN/MANAGER could delete a foreign tenant's
 * Shift. Fixed to check the loaded row's real owner before any further step,
 * mirroring overtime.ts (Shift itself has no tenantId column — go via employee).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { dowOf, futureDateStr, nextWeekdayStr } from "./test-dates";
import type { FastifyInstance } from "fastify";

/** Tomorrow, "YYYY-MM-DD" — Shift.date must not be in the past (SHIFT_PAST_IMMUTABLE). */
/**
 * The next date on which a shift may actually be created (#271).
 *
 * This used to be a plain "tomorrow", which is a date bomb: since Phase 325 (issue #325) the
 * store-hours check reads the SHIFT'S OWN salon's opening hours, and `seedTestData()`'s default
 * salon uses `DEFAULT_SALON_OPENING_HOURS` (`apps/api/src/contexts/platform/facade/salons.ts`),
 * which has Sunday CLOSED (day 6 of the 0=Mo..6=So array) — the same rule the deprecated
 * `TenantConfig.storeHours` default used to carry. `POST`/`PUT /api/v1/shifts` answers 409
 * "Schicht ... ausserhalb der Oeffnungszeiten - Geschaeft geschlossen" for a closed day. So these
 * tests failed every Saturday and passed on the other six days, which is why CI went red while
 * every local re-run looked fine.
 *
 * `nextWeekdayStr` skips Saturday as well. That is deliberate: the store default has Saturday open,
 * but a tenant config in a future fixture may not, and none of these tests is about opening hours.
 */
function nextOpenDayIso(): string {
  return nextWeekdayStr(futureDateStr(1));
}

const GENUINELY_MISSING_SHIFT_ID = "00000000-0000-4000-8000-000000000002";

describe("DELETE /api/v1/shifts/:id — tenant isolation (sec-02)", () => {
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
    tenantA = await seedTestData(app, "sec02-a");
    tenantB = await seedTestData(app, "sec02-b");

    const victimShift = await app.prisma.shift.create({
      data: {
        employeeId: tenantB.employee.id,
        salonId: tenantB.salonId, // Phase 325 (issue #325)
        date: new Date(nextOpenDayIso()),
        startTime: "08:00",
        endTime: "16:00",
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

  it("tenantA ADMIN deleting tenantB's shift → 404, row untouched, CROSS_TENANT_ACCESS_DENIED audit", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/shifts/${victimShiftId}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Schicht nicht gefunden" });

    // The victim row survived, unchanged.
    const victimAfter = await app.prisma.shift.findUnique({ where: { id: victimShiftId } });
    expect(victimAfter).not.toBeNull();
    expect(victimAfter?.deletedAt).toBeNull();

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "CROSS_TENANT_ACCESS_DENIED", entity: "Shift", entityId: victimShiftId },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.userId).toBe(tenantA.adminUser.id);
  });

  it("the cross-tenant 404 is byte-identical to a genuine not-found 404 (no existence oracle)", async () => {
    const crossTenantRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/shifts/${victimShiftId}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    const notFoundRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/shifts/${GENUINELY_MISSING_SHIFT_ID}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    expect(crossTenantRes.statusCode).toBe(notFoundRes.statusCode);
    expect(JSON.parse(crossTenantRes.body)).toEqual(JSON.parse(notFoundRes.body));
  });

  it("the same call by tenantB's OWN ADMIN still succeeds exactly as before (no regression)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/shifts/${victimShiftId}`,
      headers: { authorization: `Bearer ${tenantB.adminToken}` },
    });

    expect(res.statusCode).toBe(204);

    const victimAfter = await app.prisma.shift.findUnique({ where: { id: victimShiftId } });
    expect(victimAfter).toBeNull();
  });
});
