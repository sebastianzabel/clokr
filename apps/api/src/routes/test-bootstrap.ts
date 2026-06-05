/**
 * Test-only bootstrap surface — combined Phase 73-01 (tenant fixture endpoints)
 * and Phase 74-03 (X-Test-Now header for vacation carry-over flows).
 *
 * Two responsibilities:
 *
 * 1. **Tenant bootstrap / teardown** (Phase 73-01 — depended on by the
 *    `apps/e2e/fixtures/tenant.ts` fixture):
 *      - `POST /api/v1/test/bootstrap-tenant` → creates a fresh tenant with a
 *        deterministic `test-{8-hex}` id, seeds ADMIN user + WorkSchedule +
 *        OvertimeAccount + LeaveType + LeaveEntitlement, returns
 *        `{ tenantId, adminToken, baseUrl }` matching the `TestTenant`
 *        interface in `apps/e2e/fixtures/tenant.ts`.
 *      - `DELETE /api/v1/test/tenant/:id` → tears the tenant down in
 *        dependency order. 404 if the tenant doesn't match the
 *        `^test-[a-zA-Z0-9_-]{8}$` allow-list (prevents accidental
 *        production-tenant deletion even when the env flag is on).
 *
 * 2. **Date pinning via `X-Test-Now` HTTP header** (Phase 74-03, D-05):
 *    Time-sensitive flows (vacation year-end rollover, mid-year hire pro-rata,
 *    FIFO carry-over, EuGH untaken-leave edge case) cannot be tested at the
 *    UI layer without overriding what the server believes "now" is. The
 *    `onRequest` hook reads `X-Test-Now`, parses an ISO date, and stores it
 *    on `req.testNow`. Date-sensitive handlers consume `req.testNow ?? new Date()`.
 *
 * **Security gate (T-74-01, T-74-03-01):** the WHOLE plugin returns early when
 * `ALLOW_TEST_BOOTSTRAP=false` — neither the hook nor the routes register, so
 * the header is silently ignored AND the bootstrap endpoints return 404 on
 * int + prod. The flag is read once per app boot from `config.ts`, which fails
 * fast at startup if anything is wrong. No per-request env lookup → no chance
 * of mid-process flag flips.
 *
 * Naming-collision note: the `req.testNow` decoration MUST be added once; the
 * module augmentation lives below so any caller (e.g. `apps/api/src/routes/leave.ts`)
 * can pass `req.testNow` into the entitlement computation without ts-ignore.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { config } from "../config.js";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Test-only "fake now" — populated by the `X-Test-Now` request header
     * when `ALLOW_TEST_BOOTSTRAP=true`. Always `undefined` on int + prod
     * (the onRequest hook is never registered). Handlers MUST default to
     * `new Date()` when this is undefined.
     */
    testNow?: Date;
  }
}

const TENANT_ID_RE = /^test-[a-zA-Z0-9_-]{8,}$/;
const TEST_PASSWORD = "test1234";

function newTenantId(): string {
  // 8-char hex from crypto.randomBytes. Math.random is not cryptographically
  // strong (CodeQL js/insecure-randomness); hex (`[0-9a-f]`) is also a strict
  // subset of DNS label characters so `admin@test-${id}.test` is a syntactically
  // valid email — AJV's `format: "email"` validator rejects `_` and accepts `-`
  // only in non-leading positions, both of which were intermittently produced
  // by the previous base64url slice. (Phase 73-01 fix-up — observed as flaky
  // 500 on bootstrap-tenant when the slice landed on `_`.) The wider regex
  // `^test-[a-zA-Z0-9_-]{8}$` consumed by the e2e fixture still matches.
  return `test-${randomBytes(4).toString("hex")}`;
}

/**
 * Parses an ISO-8601 date string, returns `undefined` on any failure.
 * Used by both the onRequest hook (single-value path) and could be reused
 * by future test endpoints that accept a JSON-body `now` field.
 */
function parseIsoDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d;
}

export async function testBootstrapRoutes(app: FastifyInstance): Promise<void> {
  // GATE: when ALLOW_TEST_BOOTSTRAP=false, nothing here is registered.
  // The header is silently ignored AND the routes 404 because they don't
  // exist on the router. See T-74-01 / T-74-03-01.
  if (!config.ALLOW_TEST_BOOTSTRAP) {
    return;
  }

  // ── X-Test-Now hook ──────────────────────────────────────────────
  // Reads the header (Fastify normalises header keys to lowercase) and
  // pins `req.testNow`. Per-request scope — no shared state across workers.
  app.addHook("onRequest", async (req: FastifyRequest) => {
    const headerValue = req.headers["x-test-now"];
    const parsed = parseIsoDate(headerValue);
    if (parsed) {
      req.testNow = parsed;
    }
  });

  // ── POST /test/bootstrap-tenant ──────────────────────────────────
  app.post("/bootstrap-tenant", {
    config: { rateLimit: false },
    schema: { tags: ["TestBootstrap"], hide: true },
    handler: async (_req, reply) => {
      const tenantId = newTenantId();
      const prisma = app.prisma;

      const tenant = await prisma.tenant.create({
        data: {
          id: tenantId,
          name: `Test ${tenantId}`,
          slug: tenantId,
          federalState: "NIEDERSACHSEN",
        },
      });

      await prisma.tenantConfig.create({
        data: {
          tenantId: tenant.id,
          defaultVacationDays: 30,
          timezone: "Europe/Berlin",
        },
      });

      const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
      const adminUser = await prisma.user.create({
        data: {
          email: `admin@${tenantId}.test`,
          passwordHash,
          role: "ADMIN",
          isActive: true,
        },
      });

      const adminEmployee = await prisma.employee.create({
        data: {
          tenantId: tenant.id,
          userId: adminUser.id,
          employeeNumber: `A-${tenantId.slice(-4)}`,
          firstName: "Admin",
          lastName: "Test",
          hireDate: new Date("2024-01-01"),
        },
      });

      // Phase 73-01 must_haves: bootstrap a usable admin — not just the
      // identity row. WorkSchedule + OvertimeAccount unlock /overtime,
      // /reports and Saldo-derived endpoints from the very first request.
      // Without these, Plan 73-02's fixture lights up the calendar page
      // but every Soll-/+- cell renders empty and downstream specs that
      // assert on saldo numbers go red on the FIRST navigation. Default
      // hours mirror `seedTestData()` in __tests__/setup.ts so behaviour
      // matches the Vitest integration suites and the Playwright E2E
      // suites byte-for-byte.
      await prisma.workSchedule.create({
        data: {
          employeeId: adminEmployee.id,
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

      await prisma.overtimeAccount.create({
        data: { employeeId: adminEmployee.id, balanceHours: 0 },
      });

      // Standard vacation type — every Plan 74-03 test reads carry-over
      // off this exact `LeaveType` row.
      const vacationType = await prisma.leaveType.create({
        data: {
          tenantId: tenant.id,
          name: "Urlaub",
          isPaid: true,
          requiresApproval: true,
          color: "#3B82F6",
        },
      });

      // LeaveEntitlement for the current year — without it, /leave routes
      // 404 on "no entitlement found". 30 days @ Mo–Fr aligns with the
      // tenant-config default and BUrlG-pro-rata baseline.
      const currentYear = new Date().getFullYear();
      await prisma.leaveEntitlement.create({
        data: {
          employeeId: adminEmployee.id,
          leaveTypeId: vacationType.id,
          year: currentYear,
          totalDays: 30,
          usedDays: 0,
        },
      });

      // Login → bearer token
      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: `admin@${tenantId}.test`, password: TEST_PASSWORD },
      });
      if (loginRes.statusCode !== 200) {
        reply.code(500);
        return { error: "BootstrapLoginFailed", status: loginRes.statusCode };
      }
      const { accessToken } = JSON.parse(loginRes.body) as { accessToken: string };

      return {
        tenantId: tenant.id,
        adminToken: accessToken,
        baseUrl: config.CORS_ORIGIN,
      };
    },
  });

  // ── DELETE /test/tenant/:id ──────────────────────────────────────
  app.delete("/tenant/:id", {
    config: { rateLimit: false },
    schema: { tags: ["TestBootstrap"], hide: true },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      // Belt-and-braces: even with the env flag on, only `test-…` ids may
      // be deleted via this surface. Prevents an attacker who somehow gets
      // the flag flipped from wiping a real tenant.
      if (!TENANT_ID_RE.test(id)) {
        reply.code(404);
        return { error: "NotATestTenant" };
      }

      const prisma = app.prisma;
      const employees = await prisma.employee.findMany({
        where: { tenantId: id },
        select: { id: true, userId: true },
      });
      const employeeIds = employees.map((e) => e.id);
      const userIds = employees.map((e) => e.userId);

      // Delete in dependency order — mirrors apps/api/src/__tests__/setup.ts.
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.employeeAvailability.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await prisma.employeeShiftPattern.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await prisma.employeeVocationalSchoolPattern.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await prisma.shift.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.absence.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.leaveEntitlement.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await prisma.saldoSnapshot.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.timeEntry.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.overtimeTransaction.deleteMany({
        where: { overtimeAccount: { employeeId: { in: employeeIds } } },
      });
      await prisma.overtimeAccount.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await prisma.overtimePlan.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.invitation.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.workSchedule.deleteMany({ where: { employeeId: { in: employeeIds } } });
      await prisma.employee.deleteMany({ where: { tenantId: id } });
      await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.otpToken.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.leaveType.deleteMany({ where: { tenantId: id } });
      await prisma.publicHoliday.deleteMany({ where: { tenantId: id } });
      await prisma.coverageRule.deleteMany({ where: { tenantId: id } });
      await prisma.shiftTemplate.deleteMany({ where: { tenantId: id } });
      await prisma.companyShutdown.deleteMany({ where: { tenantId: id } });
      await prisma.terminalApiKey.deleteMany({ where: { tenantId: id } });
      await prisma.tenantConfig.deleteMany({ where: { tenantId: id } });

      const deleted = await prisma.tenant.deleteMany({ where: { id } });
      if (deleted.count === 0) {
        reply.code(404);
        return { error: "TenantNotFound" };
      }
      return { tenantId: id, deleted: true };
    },
  });

  // ── POST /test/bootstrap-terminal (Phase 74-05) ──────────────────
  // Provisions a TerminalApiKey + an Employee with `nfcCardId` for E2E
  // NFC-punch tests. Mirrors Phase 73-01's bootstrap-tenant contract:
  //   * gated by ALLOW_TEST_BOOTSTRAP (plugin-level early return above);
  //   * only operates against test tenants (`TENANT_ID_RE` allow-list);
  //   * returns the raw API key EXACTLY ONCE in the response — never
  //     logged (T-74-05-01). Server logs only capture `apiKey.id`.
  //
  // The endpoint is idempotent in spirit but not in practice: each call
  // creates a fresh TerminalApiKey and a fresh Employee. Teardown via
  // `DELETE /api/v1/test/tenant/:id` already cascades both rows.
  const bootstrapTerminalSchema = z.object({
    tenantId: z.string(),
    nfcCardId: z.string().optional(),
  });
  app.post("/bootstrap-terminal", {
    config: { rateLimit: false },
    schema: { tags: ["TestBootstrap"], hide: true },
    handler: async (req, reply) => {
      const body = bootstrapTerminalSchema.parse(req.body ?? {});

      // Belt-and-braces: even with the env flag on, only `test-…` tenants
      // may be provisioned via this surface. Prevents test tooling from
      // accidentally minting a Terminal key against a real tenant.
      if (!TENANT_ID_RE.test(body.tenantId)) {
        reply.code(404);
        return { error: "NotATestTenant" };
      }

      const tenant = await app.prisma.tenant.findUnique({
        where: { id: body.tenantId },
      });
      if (!tenant) {
        reply.code(404);
        return { error: "TenantNotFound" };
      }

      // 1. TerminalApiKey — same generation contract as
      //    `apps/api/src/routes/terminals.ts` (clk_ prefix, 32-byte hex,
      //    SHA-256 hash). Raw key returned to the caller, NEVER persisted.
      const rawKey = `clk_${randomBytes(32).toString("hex")}`;
      const keyHash = createHash("sha256").update(rawKey).digest("hex");
      const keyPrefix = rawKey.substring(0, 12) + "...";
      const apiKey = await app.prisma.terminalApiKey.create({
        data: {
          tenantId: body.tenantId,
          name: "test-terminal",
          keyHash,
          keyPrefix,
        },
      });

      // 2. Test employee + backing User. nfcCardId defaults to a
      //    collision-resistant random value so parallel tests on the
      //    same tenant don't clash on the `nfcCardId @unique` index.
      const nfcCardId = body.nfcCardId ?? `test-nfc-${randomBytes(6).toString("hex")}`;
      const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
      const empSuffix = randomBytes(3).toString("hex");
      const employeeUser = await app.prisma.user.create({
        data: {
          email: `terminal-${empSuffix}@${body.tenantId}.test`,
          passwordHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const employee = await app.prisma.employee.create({
        data: {
          tenantId: body.tenantId,
          userId: employeeUser.id,
          employeeNumber: `T-${empSuffix}`,
          firstName: "Test",
          lastName: "Terminal",
          nfcCardId,
          hireDate: new Date("2024-01-01"),
        },
      });

      // Log only the non-secret id — the raw key MUST stay out of logs
      // per T-74-05-01 (audit-proof for terminal credentials).
      req.log.info(
        { apiKeyId: apiKey.id, employeeId: employee.id, tenantId: body.tenantId },
        "test-bootstrap: terminal provisioned",
      );

      return reply.code(201).send({
        apiKey: rawKey,
        apiKeyId: apiKey.id,
        employeeId: employee.id,
        userId: employeeUser.id,
        nfcCardId,
      });
    },
  });
}
