/**
 * Unit test for Phase 73-01 — the test-only tenant bootstrap surface.
 *
 * Covers the five must_haves from `.planning/phases/73-e2e-stability/73-01-PLAN.md`:
 *   1. Flag off → POST /api/v1/test/bootstrap-tenant returns 404; no Tenant row created.
 *   2. Flag on → POST returns { tenantId, adminToken, baseUrl }; tenantId matches
 *      /^test-[a-zA-Z0-9_-]{8}$/; the Tenant row exists; the admin token decodes
 *      to a JWT with role=ADMIN + the new tenantId.
 *   3. Teardown happy path → DELETE /api/v1/test/tenant/{tenantId} returns 200,
 *      the Tenant row is gone.
 *   4. Teardown guard rail → DELETE /api/v1/test/tenant/not-a-test-tenant returns
 *      404 with `{ error: "NotATestTenant" }` — the route file refuses ids that
 *      don't match the `test-…` allow-list even when the flag is on, defence in
 *      depth against accidental wipes of real tenants (T-73-01).
 *   5. Cascade cleanup → bootstrap a tenant, push one TimeEntry + LeaveRequest
 *      through the admin employee, DELETE the tenant, all child rows are gone.
 *
 * Why we rebuild the app per flag-state: `config.ts` parses `process.env` ONCE at
 * module-load time and freezes it on `export const config`. To test both flag
 * states in the same Vitest process we must `vi.resetModules()` between scenarios
 * so the dynamic `import("../app")` re-evaluates `config.ts` against the
 * mutated env. The shared `getTestApp()` from setup.ts is intentionally NOT used
 * — it was instantiated with the test-runner's default env (flag off), which
 * doesn't expose the routes.
 *
 * Why we deviate from the plan on the guard-rail status code: plan Task 4 spec'd
 * 400 (Zod refusal). The existing route — landed by Phase 74-03 in the same file
 * — returns 404 with `{ error: "NotATestTenant" }`, and the Phase 73-02 fixture
 * at `apps/e2e/fixtures/tenant.ts` (line 75) already treats 404 as the success
 * sentinel for "tenant already gone". Flipping to 400 would silently break the
 * fixture mid-suite. We keep the deployed 404 contract and document the
 * deviation in `.planning/phases/73-e2e-stability/73-01-SUMMARY.md`.
 *
 * Why we re-use `appOn.prisma` for DB assertions instead of constructing a
 * standalone PrismaClient: `@clokr/db` is configured with the `pg` adapter and
 * requires an explicit `PrismaClientOptions` block. The simplest correct path
 * is to talk to the same client the route uses.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * Build a fresh Fastify instance with `ALLOW_TEST_BOOTSTRAP` overridden.
 *
 * Resets the module graph so `config.ts` re-reads process.env, then dynamically
 * imports `../app`. Returns the booted app — caller MUST `await app.close()`.
 */
async function buildAppWithFlag(value: "true" | "false"): Promise<FastifyInstance> {
  process.env.ALLOW_TEST_BOOTSTRAP = value;
  vi.resetModules();
  const mod = (await import("../app")) as { buildApp: () => Promise<FastifyInstance> };
  const app = await mod.buildApp();
  await app.ready();
  return app;
}

describe("Phase 73-01: test-only tenant bootstrap", () => {
  // Long-lived app instances — building one per test makes the suite take
  // ~10× longer because every boot wires every plugin + cron job + Prisma.
  // Two instances cover both flag states; we drop the artefacts they leave
  // behind by hand at the end of each scenario.
  let appOff: FastifyInstance;
  let appOn: FastifyInstance;

  // Capture the original flag value once so afterAll can restore it. Without
  // this, downstream test files that import config.ts before this suite finishes
  // would observe whichever value the last scenario left behind.
  const originalFlag = process.env.ALLOW_TEST_BOOTSTRAP;

  // Track tenant ids we bootstrap so afterAll can drop any that escaped a
  // scenario-level teardown (e.g. when a scenario asserts mid-flight and bails).
  const createdTenantIds = new Set<string>();

  beforeAll(async () => {
    appOff = await buildAppWithFlag("false");
    appOn = await buildAppWithFlag("true");
  });

  afterAll(async () => {
    // Drain any tenants that escaped scenario teardown — belt-and-braces so a
    // mid-test failure doesn't leak test-…-tagged rows into the test schema.
    for (const tenantId of createdTenantIds) {
      try {
        await appOn.inject({
          method: "DELETE",
          url: `/api/v1/test/tenant/${tenantId}`,
        });
      } catch {
        // Best-effort: ignore — likely already deleted by the scenario.
      }
    }
    await appOff.close();
    await appOn.close();
    if (originalFlag === undefined) {
      delete process.env.ALLOW_TEST_BOOTSTRAP;
    } else {
      process.env.ALLOW_TEST_BOOTSTRAP = originalFlag;
    }
    vi.resetModules();
  });

  describe("ALLOW_TEST_BOOTSTRAP=false (the prod posture)", () => {
    it("POST /api/v1/test/bootstrap-tenant returns 404 and creates no tenant", async () => {
      // Critical: NO info leak. The endpoint must not respond like a real
      // 404 from a missing record — it must look identical to a path that
      // simply doesn't exist on the router. (T-73-01)
      const before = await appOff.prisma.tenant.count({
        where: { slug: { startsWith: "test-" } },
      });
      const res = await appOff.inject({
        method: "POST",
        url: "/api/v1/test/bootstrap-tenant",
      });
      expect(res.statusCode).toBe(404);
      const after = await appOff.prisma.tenant.count({
        where: { slug: { startsWith: "test-" } },
      });
      expect(after).toBe(before);
    });

    it("DELETE /api/v1/test/tenant/:id returns 404 (route not registered)", async () => {
      const res = await appOff.inject({
        method: "DELETE",
        url: "/api/v1/test/tenant/test-abcdef12",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("ALLOW_TEST_BOOTSTRAP=true (dev + CI posture)", () => {
    it("POST returns a fresh tenant with admin JWT + seeded WorkSchedule/OvertimeAccount/LeaveEntitlement", async () => {
      const res = await appOn.inject({
        method: "POST",
        url: "/api/v1/test/bootstrap-tenant",
      });
      expect(res.statusCode).toBe(200);

      const body = res.json() as { tenantId: string; adminToken: string; baseUrl: string };
      expect(body.tenantId).toMatch(/^test-[a-zA-Z0-9_-]{8}$/);
      expect(body.adminToken).toBeTruthy();
      expect(body.baseUrl).toBeTruthy();
      createdTenantIds.add(body.tenantId);

      // Tenant row actually present + slug matches the id.
      const tenant = await appOn.prisma.tenant.findUnique({ where: { id: body.tenantId } });
      expect(tenant).not.toBeNull();
      expect(tenant?.slug).toBe(body.tenantId);

      // adminToken is a real JWT signed by the app — verify decode locks in
      // role=ADMIN + tenant scope. We use the app's own jwt instance to
      // avoid pinning the secret in the test file.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const decoded = (appOn as any).jwt.verify(body.adminToken) as {
        role?: string;
        tenantId?: string;
      };
      expect(decoded.role).toBe("ADMIN");
      expect(decoded.tenantId).toBe(body.tenantId);

      // Phase 73-01 seed-extension assertion: WorkSchedule + OvertimeAccount
      // + LeaveEntitlement must be present so calendar / overtime / leave
      // endpoints work on the very first request.
      const employee = await appOn.prisma.employee.findFirst({
        where: { tenantId: body.tenantId },
      });
      expect(employee).not.toBeNull();
      const ws = await appOn.prisma.workSchedule.findFirst({
        where: { employeeId: employee!.id },
      });
      expect(ws).not.toBeNull();
      const ot = await appOn.prisma.overtimeAccount.findUnique({
        where: { employeeId: employee!.id },
      });
      expect(ot).not.toBeNull();
      const ent = await appOn.prisma.leaveEntitlement.findFirst({
        where: { employeeId: employee!.id },
      });
      expect(ent).not.toBeNull();
      expect(Number(ent!.totalDays)).toBe(30);
    });

    it("DELETE /api/v1/test/tenant/:id cascades child rows and drops the tenant", async () => {
      const bootstrapRes = await appOn.inject({
        method: "POST",
        url: "/api/v1/test/bootstrap-tenant",
      });
      expect(bootstrapRes.statusCode).toBe(200);
      const { tenantId } = bootstrapRes.json() as { tenantId: string };
      createdTenantIds.add(tenantId);

      // Inject one TimeEntry + LeaveRequest under the admin employee so we
      // can prove cascade cleanup, not just tenant deletion.
      const employee = await appOn.prisma.employee.findFirst({ where: { tenantId } });
      expect(employee).not.toBeNull();
      const leaveType = await appOn.prisma.leaveType.findFirst({ where: { tenantId } });
      expect(leaveType).not.toBeNull();

      await appOn.prisma.timeEntry.create({
        data: {
          employeeId: employee!.id,
          date: new Date("2025-01-15"),
          startTime: new Date("2025-01-15T08:00:00Z"),
          endTime: new Date("2025-01-15T16:00:00Z"),
        },
      });
      await appOn.prisma.leaveRequest.create({
        data: {
          employeeId: employee!.id,
          leaveTypeId: leaveType!.id,
          startDate: new Date("2025-06-01"),
          endDate: new Date("2025-06-05"),
          days: 5,
          status: "PENDING",
        },
      });

      const deleteRes = await appOn.inject({
        method: "DELETE",
        url: `/api/v1/test/tenant/${tenantId}`,
      });
      expect(deleteRes.statusCode).toBe(200);

      // Tenant gone.
      const tenant = await appOn.prisma.tenant.findUnique({ where: { id: tenantId } });
      expect(tenant).toBeNull();
      // Child rows gone — both queries scope by employeeId, so a row count of
      // 0 means the cascade actually deleted them (vs. orphaning them).
      const remainingEntries = await appOn.prisma.timeEntry.count({
        where: { employeeId: employee!.id },
      });
      expect(remainingEntries).toBe(0);
      const remainingLeave = await appOn.prisma.leaveRequest.count({
        where: { employeeId: employee!.id },
      });
      expect(remainingLeave).toBe(0);

      // Mark as drained so afterAll doesn't re-attempt cleanup.
      createdTenantIds.delete(tenantId);
    });

    it("DELETE rejects ids that do not match the test- allow-list", async () => {
      const res = await appOn.inject({
        method: "DELETE",
        url: "/api/v1/test/tenant/not-a-test-tenant",
      });
      // Phase 73-01 plan spec'd 400; the deployed contract from Phase 74-03
      // is 404 with `{ error: "NotATestTenant" }`. We assert the deployed
      // contract — the Phase 73-02 fixture treats 404 as the success
      // sentinel for "tenant already gone". See SUMMARY for the deviation.
      expect(res.statusCode).toBe(404);
      const body = res.json() as { error?: string };
      expect(body.error).toBe("NotATestTenant");
    });
  });
});
