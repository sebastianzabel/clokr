/**
 * settings-work-tenant-isolation.test.ts
 *
 * Phase 100 (T-100-01 / T-100-02) — pins two write-path guards added once
 * `maxNegativeBalanceMinutes` moved from inert configuration to an input of the
 * OVERTIME_COMP entitlement gate (Plan 01):
 *
 *   - T-100-02: `PUT /api/v1/settings/work/:employeeId` now rejects a cross-tenant
 *     target with a 404 that is byte-identical to the genuine not-found 404 (so the
 *     route cannot be used as a tenant-membership oracle, T-100-09), writes NO
 *     WorkSchedule row, and emits a CROSS_TENANT_ACCESS_DENIED AuditLog entry —
 *     mirroring the pre-existing guard idiom at `overtime.ts:85-97` verbatim.
 *   - T-100-01: `maxNegativeBalanceMinutes` is now bounded at 999h (59_940 minutes)
 *     on BOTH Zod declarations (the per-employee schema consumed by this route, and
 *     the tenant-config schema consumed by `PUT /settings/security`) — matching the
 *     `max="999"` the shipped admin form already advertises
 *     (`apps/web/.../admin/vacation/+page.svelte`), so the OVERTIME_COMP gate can
 *     never be configured into a silent no-op.
 *
 * Code review CR-01 (2026-08-21) added a third guard pinned below:
 *   - CR-01: `GET /api/v1/settings/work/:employeeId` had NO tenant check at all —
 *     any ADMIN/MANAGER of any tenant could read a foreign employee's WorkSchedule,
 *     including the now-live `maxNegativeBalanceMinutes`. Fixed to mirror the PUT
 *     guard exactly (same 404 shape, same audit action, same self-access carve-out).
 *
 * Every date in this file is computed from `new Date()` — no hardcoded calendar
 * literal anywhere — per this plan's own stricter self-check. This repo has a
 * documented hardcoded-date time-bomb hazard (`.planning/STATE.md`), and the
 * sibling suites from Phase 100 Plan 01 Task 2 and Plan 03 Task 2 carry the same
 * no-literal discipline.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

/**
 * First of the month N months from now, UTC, as "YYYY-MM-01". Never a hardcoded
 * calendar literal — `WorkSchedule.validFrom` must be the 1st of a calendar month
 * for every contract CHANGE (CLAUDE.md, "Schedule Types"; enforced server-side via
 * `isMonthFirstDate`, `apps/api/src/utils/month-first-date.ts`), so every
 * `validFrom` this file sends is built from this helper.
 */
function monthFirstUtcIso(monthsFromNow: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsFromNow, 1))
    .toISOString()
    .slice(0, 10);
}

// The bound both Zod declarations now enforce (T-100-01): 999h, matching the shipped
// admin form's max="999" (apps/web/.../admin/vacation/+page.svelte).
const MAX_TOLERANCE_MINUTES = 999 * 60; // 59_940

// A UUID-shaped but genuinely non-existent employeeId, for the "identical 404 shape" probe.
// Employee.id has no @db.Uuid constraint (plain String @id), so any string is a safe query —
// this one just looks realistic.
const GENUINELY_MISSING_EMPLOYEE_ID = "00000000-0000-4000-8000-000000000000";

describe("PUT /api/v1/settings/work/:employeeId — tenant isolation + tolerance bound (Phase 100)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  let victimScheduleId: string;

  // Arbitrary, non-zero, non-boundary value so "unchanged after the attack" is a
  // meaningful assertion rather than an accidental null-equals-null match.
  const KNOWN_VICTIM_TOLERANCE = 120;

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "swti-a");
    tenantB = await seedTestData(app, "swti-b");

    // Give tenantB's employee a KNOWN maxNegativeBalanceMinutes on their existing
    // (seedTestData-created) WorkSchedule row, and remember its id — every assertion
    // below re-reads THIS row by id, never "the first row for this employee", so the
    // test stays correct regardless of how many other rows other tests create later.
    const victimSchedule = await app.prisma.workSchedule.update({
      where: {
        // seedTestData creates exactly one row per employee; findFirst+update by id
        // avoids a second findFirst race — read then write the same row explicitly.
        id: (
          await app.prisma.workSchedule.findFirstOrThrow({
            where: { employeeId: tenantB.employee.id },
          })
        ).id,
      },
      data: { maxNegativeBalanceMinutes: KNOWN_VICTIM_TOLERANCE },
    });
    victimScheduleId = victimSchedule.id;
  });

  afterAll(async () => {
    // Sequential cleanup — never Promise.all (setup.ts Pitfall 3 / tenant-isolation.test.ts precedent)
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

  // ── T-100-02: cross-tenant write guard ──────────────────────────────────────

  it("tenantA ADMIN writing to tenantB's employee → 404, no WorkSchedule write, CROSS_TENANT_ACCESS_DENIED audit", async () => {
    const beforeCount = await app.prisma.workSchedule.count({
      where: { employeeId: tenantB.employee.id },
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: { maxNegativeBalanceMinutes: 300, validFrom: monthFirstUtcIso(6) },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Mitarbeiter nicht gefunden" });

    // No new row created anywhere for this employee...
    const afterCount = await app.prisma.workSchedule.count({
      where: { employeeId: tenantB.employee.id },
    });
    expect(afterCount).toBe(beforeCount);

    // ...and the KNOWN pre-existing row is untouched (the attacker's payload never landed).
    const victimAfter = await app.prisma.workSchedule.findUniqueOrThrow({
      where: { id: victimScheduleId },
    });
    expect(victimAfter.maxNegativeBalanceMinutes).toBe(KNOWN_VICTIM_TOLERANCE);

    const audit = await app.prisma.auditLog.findFirst({
      where: {
        action: "CROSS_TENANT_ACCESS_DENIED",
        entity: "WorkSchedule",
        entityId: tenantB.employee.id,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.userId).toBe(tenantA.adminUser.id);
  });

  it("the cross-tenant 404 is byte-identical to a genuine not-found 404 (no existence oracle, T-100-09)", async () => {
    const crossTenantRes = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: { maxNegativeBalanceMinutes: 300, validFrom: monthFirstUtcIso(7) },
    });

    const notFoundRes = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${GENUINELY_MISSING_EMPLOYEE_ID}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
      payload: { maxNegativeBalanceMinutes: 300, validFrom: monthFirstUtcIso(8) },
    });

    expect(crossTenantRes.statusCode).toBe(notFoundRes.statusCode);
    expect(JSON.parse(crossTenantRes.body)).toEqual(JSON.parse(notFoundRes.body));
  });

  it("the same call by tenantB's OWN ADMIN still succeeds exactly as before (no regression)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantB.adminToken}` },
      payload: { maxNegativeBalanceMinutes: 90, validFrom: monthFirstUtcIso(1) },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.employeeId).toBe(tenantB.employee.id);
    expect(body.maxNegativeBalanceMinutes).toBe(90);

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: { in: ["CREATE", "UPDATE"] }, entity: "WorkSchedule", entityId: body.id },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
  });

  // ── T-100-01: the 999h / 59_940-minute bound ────────────────────────────────

  describe("maxNegativeBalanceMinutes upper bound (999h = 59_940min, matches the shipped admin form)", () => {
    it("PUT /work/:employeeId (per-employee schema) — accepts the bound, rejects one minute beyond it", async () => {
      const okRes = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${tenantB.employee.id}`,
        headers: { authorization: `Bearer ${tenantB.adminToken}` },
        payload: {
          maxNegativeBalanceMinutes: MAX_TOLERANCE_MINUTES,
          validFrom: monthFirstUtcIso(2),
        },
      });
      expect(okRes.statusCode).toBe(200);
      expect(JSON.parse(okRes.body).maxNegativeBalanceMinutes).toBe(MAX_TOLERANCE_MINUTES);

      const rejectRes = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${tenantB.employee.id}`,
        headers: { authorization: `Bearer ${tenantB.adminToken}` },
        payload: {
          maxNegativeBalanceMinutes: MAX_TOLERANCE_MINUTES + 1,
          validFrom: monthFirstUtcIso(2),
        },
      });
      expect(rejectRes.statusCode).toBe(400);
      expect(JSON.parse(rejectRes.body).error).toBe("Validierungsfehler");
    });

    it("PUT /settings/security (tenant-config schema) — accepts the bound, rejects one minute beyond it", async () => {
      const okRes = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/security`,
        headers: { authorization: `Bearer ${tenantB.adminToken}` },
        payload: { maxNegativeBalanceMinutes: MAX_TOLERANCE_MINUTES },
      });
      expect(okRes.statusCode).toBe(200);
      expect(JSON.parse(okRes.body).maxNegativeBalanceMinutes).toBe(MAX_TOLERANCE_MINUTES);

      const rejectRes = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/security`,
        headers: { authorization: `Bearer ${tenantB.adminToken}` },
        payload: { maxNegativeBalanceMinutes: MAX_TOLERANCE_MINUTES + 1 },
      });
      expect(rejectRes.statusCode).toBe(400);
      expect(JSON.parse(rejectRes.body).error).toBe("Validierungsfehler");
    });

    it("null and 0 remain accepted — the two meaningful 'no tolerance' spellings", async () => {
      const nullRes = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${tenantB.employee.id}`,
        headers: { authorization: `Bearer ${tenantB.adminToken}` },
        payload: { maxNegativeBalanceMinutes: null, validFrom: monthFirstUtcIso(2) },
      });
      expect(nullRes.statusCode).toBe(200);
      expect(JSON.parse(nullRes.body).maxNegativeBalanceMinutes).toBeNull();

      const zeroRes = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${tenantB.employee.id}`,
        headers: { authorization: `Bearer ${tenantB.adminToken}` },
        payload: { maxNegativeBalanceMinutes: 0, validFrom: monthFirstUtcIso(2) },
      });
      expect(zeroRes.statusCode).toBe(200);
      expect(JSON.parse(zeroRes.body).maxNegativeBalanceMinutes).toBe(0);
    });
  });
});

// ── CR-01 (code review, 2026-08-21): GET /work/:employeeId had NO tenant check ──
describe("GET /api/v1/settings/work/:employeeId — tenant isolation (Phase 100 CR-01 fix)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  let victimScheduleId: string;

  // Arbitrary, non-zero, non-boundary value so "the response carries the real row"
  // is a meaningful assertion rather than an accidental null-equals-null match.
  const KNOWN_VICTIM_TOLERANCE = 150;

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "swti-get-a");
    tenantB = await seedTestData(app, "swti-get-b");

    const victimSchedule = await app.prisma.workSchedule.update({
      where: {
        id: (
          await app.prisma.workSchedule.findFirstOrThrow({
            where: { employeeId: tenantB.employee.id },
          })
        ).id,
      },
      data: { maxNegativeBalanceMinutes: KNOWN_VICTIM_TOLERANCE },
    });
    victimScheduleId = victimSchedule.id;
  });

  afterAll(async () => {
    // Sequential cleanup — never Promise.all (setup.ts Pitfall 3 / tenant-isolation.test.ts precedent)
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

  it("tenantA ADMIN reading tenantB's employee → 404, no WorkSchedule leaked, CROSS_TENANT_ACCESS_DENIED audit", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/settings/work/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ error: "Kein Arbeitszeitmodell gefunden" });
    // The 404 body must not leak any WorkSchedule field (e.g. maxNegativeBalanceMinutes).
    expect(body.maxNegativeBalanceMinutes).toBeUndefined();

    const audit = await app.prisma.auditLog.findFirst({
      where: {
        action: "CROSS_TENANT_ACCESS_DENIED",
        entity: "WorkSchedule",
        entityId: tenantB.employee.id,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.userId).toBe(tenantA.adminUser.id);
  });

  it("the cross-tenant GET 404 is byte-identical to a genuine not-found 404 (no existence oracle, T-100-09)", async () => {
    const crossTenantRes = await app.inject({
      method: "GET",
      url: `/api/v1/settings/work/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    const notFoundRes = await app.inject({
      method: "GET",
      url: `/api/v1/settings/work/${GENUINELY_MISSING_EMPLOYEE_ID}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    expect(crossTenantRes.statusCode).toBe(notFoundRes.statusCode);
    expect(JSON.parse(crossTenantRes.body)).toEqual(JSON.parse(notFoundRes.body));
  });

  it("the same call by tenantB's OWN ADMIN still succeeds and returns the real schedule (no regression)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/settings/work/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantB.adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(victimScheduleId);
    expect(body.maxNegativeBalanceMinutes).toBe(KNOWN_VICTIM_TOLERANCE);
  });

  it("the employee reading their OWN schedule (self-access, non-manager) still succeeds (no regression)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/settings/work/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantB.empToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(victimScheduleId);
  });

  it("a non-manager employee reading a DIFFERENT employee's schedule still gets 403 (self-access carve-out preserved)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/settings/work/${tenantB.adminEmployee.id}`,
      headers: { authorization: `Bearer ${tenantB.empToken}` },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "Kein Zugriff" });
  });
});
