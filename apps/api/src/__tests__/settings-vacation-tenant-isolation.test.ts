/**
 * settings-vacation-tenant-isolation.test.ts
 *
 * Phase 104 code review CR-01 — `GET` and `PUT /api/v1/settings/vacation/:employeeId`
 * resolved the employee with `findUnique({ where: { id } })` and then derived
 * `employee.tenantId` from the FETCHED row; they never compared it against
 * `req.user.tenantId`. `requireRole("ADMIN", "MANAGER")` only checks the role, so a
 * MANAGER of tenant A could read AND overwrite `totalDays` / `carriedOverDays` /
 * `carryOverDeadline` of any employee in tenant B by UUID.
 *
 * The impact is Phase-104-specific: 104-04 made this handler the THIRD writer of
 * `carryOverDeadline` and gave it the illness-deadline protection, so the row it guards
 * is the one a § 9 BUrlG credit extends under EuGH KHS C-214/10. A cross-tenant write
 * destroys a legally protected carry-over deadline in a foreign tenant and attributes the
 * audit row to the FOREIGN actor, defeating traceability.
 *
 * Pinned below, mirroring `settings-work-tenant-isolation.test.ts` (Phase 100):
 *   - cross-tenant GET → 404, no entitlement data leaked, CROSS_TENANT_ACCESS_DENIED audit
 *   - cross-tenant PUT → 404, victim row byte-for-byte unchanged, audit row present
 *   - the 404 is identical to a genuine not-found 404 (no tenant-membership oracle)
 *   - the own-tenant paths still work (no regression)
 *
 * Every year/date in this file is computed from `new Date()` — no hardcoded calendar
 * literal (documented time-bomb hazard, see `.planning/STATE.md`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

// A UUID-shaped but genuinely non-existent employeeId, for the "identical 404 shape" probe.
const GENUINELY_MISSING_EMPLOYEE_ID = "00000000-0000-4000-8000-000000000000";

describe("settings /vacation/:employeeId — tenant isolation (Phase 104 CR-01 fix)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  const year = new Date().getFullYear();

  // Arbitrary, non-default values so "unchanged after the attack" is a meaningful
  // assertion rather than an accidental null-equals-null match.
  const VICTIM_TOTAL_DAYS = 27;
  const VICTIM_CARRIED_OVER = 4;
  // The EuGH KHS C-214/10 extended deadline shape a § 9 credit writes: 31 March, year + 2.
  const VICTIM_DEADLINE = new Date(Date.UTC(year + 2, 2, 31, 23, 59, 59));

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "svti-a");
    tenantB = await seedTestData(app, "svti-b");

    await app.prisma.leaveEntitlement.update({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: tenantB.employee.id,
          leaveTypeId: tenantB.vacationType.id,
          year,
        },
      },
      data: {
        totalDays: VICTIM_TOTAL_DAYS,
        carriedOverDays: VICTIM_CARRIED_OVER,
        carryOverDeadline: VICTIM_DEADLINE,
      },
    });
  });

  afterAll(async () => {
    // Sequential cleanup — never Promise.all (setup.ts Pitfall 3)
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

  it("GET: tenantA ADMIN reading tenantB's employee → 404, nothing leaked, CROSS_TENANT_ACCESS_DENIED audit", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/settings/vacation/${tenantB.employee.id}?year=${year}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ error: "Mitarbeiter nicht gefunden" });
    expect(body.totalDays).toBeUndefined();
    expect(body.carryOverDeadline).toBeUndefined();

    const audit = await app.prisma.auditLog.findFirst({
      where: {
        action: "CROSS_TENANT_ACCESS_DENIED",
        entity: "LeaveEntitlement",
        entityId: tenantB.employee.id,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.userId).toBe(tenantA.adminUser.id);
  });

  it("PUT: tenantA ADMIN overwriting tenantB's entitlement → 404, victim row unchanged, audit row present", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/vacation/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: { year, totalDays: 1, carriedOverDays: 0, carryOverDeadline: null },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Mitarbeiter nicht gefunden" });

    // The legally protected row must be byte-for-byte what it was before the attack.
    const victim = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: tenantB.employee.id,
          leaveTypeId: tenantB.vacationType.id,
          year,
        },
      },
    });
    expect(Number(victim.totalDays)).toBe(VICTIM_TOTAL_DAYS);
    expect(Number(victim.carriedOverDays)).toBe(VICTIM_CARRIED_OVER);
    expect(victim.carryOverDeadline?.toISOString()).toBe(VICTIM_DEADLINE.toISOString());

    const audit = await app.prisma.auditLog.findFirst({
      where: {
        action: "CROSS_TENANT_ACCESS_DENIED",
        entity: "LeaveEntitlement",
        entityId: tenantB.employee.id,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.userId).toBe(tenantA.adminUser.id);
  });

  it("the cross-tenant 404 is identical to a genuine not-found 404 (no membership oracle)", async () => {
    const crossGet = await app.inject({
      method: "GET",
      url: `/api/v1/settings/vacation/${tenantB.employee.id}?year=${year}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
    const missingGet = await app.inject({
      method: "GET",
      url: `/api/v1/settings/vacation/${GENUINELY_MISSING_EMPLOYEE_ID}?year=${year}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
    expect(crossGet.statusCode).toBe(missingGet.statusCode);
    expect(JSON.parse(crossGet.body)).toEqual(JSON.parse(missingGet.body));

    const crossPut = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/vacation/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: { year, totalDays: 1 },
    });
    const missingPut = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/vacation/${GENUINELY_MISSING_EMPLOYEE_ID}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: { year, totalDays: 1 },
    });
    expect(crossPut.statusCode).toBe(missingPut.statusCode);
    expect(JSON.parse(crossPut.body)).toEqual(JSON.parse(missingPut.body));
  });

  it("tenantB's OWN ADMIN can still read and write the entitlement (no regression)", async () => {
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/settings/vacation/${tenantB.employee.id}?year=${year}`,
      headers: { authorization: `Bearer ${tenantB.adminToken}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(JSON.parse(getRes.body).totalDays).toBe(VICTIM_TOTAL_DAYS);

    const putRes = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/vacation/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantB.adminToken}` },
      payload: { year, totalDays: 28, carriedOverDays: VICTIM_CARRIED_OVER },
    });
    expect(putRes.statusCode).toBe(200);
    expect(Number(JSON.parse(putRes.body).totalDays)).toBe(28);
  });
});
