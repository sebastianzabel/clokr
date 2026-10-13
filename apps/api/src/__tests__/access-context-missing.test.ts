/**
 * Phase 77b (Issue #77, D-10/D-11) — route-level proof that a missing tenant frame fails closed,
 * in two layers (Issue #551 added the outer one).
 *
 * Outer layer (#551): `requireAuth` refuses a token whose tenantId is empty, whitespace-only or
 * absent with 403 `TENANT_REQUIRED` before the handler runs — no query, no handler. The earlier
 * refusal is stronger than the 500 it replaces.
 *
 * Inner layer (Phase 77b, unchanged proof): GET /api/v1/dashboard/ builds its access context with
 * `accessContextFromRequest(req)` before the first query. With the outer gate simulated away
 * (`isBlankTenantId` decoration mocked to false), the same three tokens must still get HTTP 500 with
 * the fixed body `{ error: "Interner Serverfehler" }`, one error log entry naming the route, and no
 * Prisma query at all — never a data response and never the internal error message.
 *
 * The control case (a real login token) proves the same spies DO see a query on the happy path, so
 * "not called" below is not vacuous. The DB-free 200 empty-stats branch (a caller with neither
 * employeeId nor a profile) is reachable only for an API-key caller since #551, and is proven with
 * one.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { MockInstance } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { JwtPayload } from "../middleware/auth";
import { TENANT_REQUIRED_ERROR } from "../contexts/platform/tenant-status";

type LogCall = unknown[];

describe("access context missing -> 403 / 500 (Phase 77b, Issue #77; Issue #551)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "acx-missing");
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Spy (call-through) on the three queries the dashboard handler issues first. */
  function spyOnQueries() {
    return {
      tenantConfigFindUnique: vi.spyOn(app.prisma.tenantConfig, "findUnique"),
      timeEntryFindMany: vi.spyOn(app.prisma.timeEntry, "findMany"),
      tenantFindUnique: vi.spyOn(app.prisma.tenant, "findUnique"),
    };
  }

  /**
   * Capture request-logger errors. Every request gets its own child logger whose level methods
   * are own properties, so a spy on `app.log.error` never sees `req.log.error`; wrapping each child
   * returned by `app.log.child` does.
   */
  function captureRequestLogErrors(): LogCall[] {
    const calls: LogCall[] = [];
    const originalChild = app.log.child.bind(app.log);
    vi.spyOn(app.log, "child").mockImplementation(((...args: Parameters<typeof originalChild>) => {
      const child = originalChild(...args);
      const errorSpy: MockInstance = vi.spyOn(child, "error");
      errorSpy.mockImplementation(((...logArgs: unknown[]) => {
        calls.push(logArgs);
      }) as never);
      return child;
    }) as never);
    return calls;
  }

  function signToken(payload: Record<string, unknown>): string {
    return app.jwt.sign(payload as unknown as JwtPayload);
  }

  const missingTenantCases: Array<{ name: string; tenant: { tenantId?: string } }> = [
    { name: "empty tenantId", tenant: { tenantId: "" } },
    { name: "whitespace-only tenantId", tenant: { tenantId: "   " } },
    { name: "tenantId key absent", tenant: {} },
  ];

  for (const { name, tenant } of missingTenantCases) {
    it(`outer gate: answers 403 TENANT_REQUIRED without any query (${name})`, async () => {
      const token = signToken({
        sub: data.empUser.id,
        role: data.empUser.role,
        employeeId: data.employee.id,
        ...tenant,
      });
      const spies = spyOnQueries();

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual(TENANT_REQUIRED_ERROR);
      expect(spies.tenantConfigFindUnique).not.toHaveBeenCalled();
      expect(spies.timeEntryFindMany).not.toHaveBeenCalled();
      expect(spies.tenantFindUnique).not.toHaveBeenCalled();
    });

    it(`inner layer (outer gate simulated off): answers 500 without any query and logs the route (${name})`, async () => {
      const token = signToken({
        sub: data.empUser.id,
        role: data.empUser.role,
        employeeId: data.employee.id,
        ...tenant,
      });
      // Simulate the outer gate being absent: the decoration `requireAuth` reads says "not blank".
      vi.spyOn(app, "isBlankTenantId").mockReturnValue(false);
      const spies = spyOnQueries();
      const logCalls = captureRequestLogErrors();

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: "Interner Serverfehler" });
      expect(spies.tenantConfigFindUnique).not.toHaveBeenCalled();
      expect(spies.timeEntryFindMany).not.toHaveBeenCalled();
      expect(spies.tenantFindUnique).not.toHaveBeenCalled();

      const guardLogs = logCalls.filter((args) => {
        const first = args[0] as
          { route?: unknown; method?: unknown; err?: { name?: unknown } } | undefined;
        return (
          typeof first?.route === "string" &&
          first.route.includes("/api/v1/dashboard") &&
          first.method === "GET" &&
          first.err?.name === "AccessContextError"
        );
      });
      expect(guardLogs.length).toBeGreaterThanOrEqual(1);
    });
  }

  it("a blank-tenant token without employeeId is refused with 403 TENANT_REQUIRED (#551)", async () => {
    const token = signToken({ sub: data.adminUser.id, role: data.adminUser.role, tenantId: "" });
    const spies = spyOnQueries();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual(TENANT_REQUIRED_ERROR);
    expect(spies.timeEntryFindMany).not.toHaveBeenCalled();
  });

  it("keeps the DB-free 200 empty-stats answer for an API-key caller (no employeeId)", async () => {
    const raw = `clk_${randomBytes(24).toString("hex")}`;
    await app.prisma.apiKey.create({
      data: {
        tenantId: data.tenant.id,
        name: `acx-missing-551-${Date.now().toString(36)}`,
        keyHash: createHash("sha256").update(raw).digest("hex"),
        keyPrefix: raw.slice(0, 8),
        scopes: ["admin"],
        createdBy: data.adminUser.id,
      },
    });
    const spies = spyOnQueries();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/",
      headers: { authorization: `Bearer ${raw}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      today: { workedHours: 0, entries: 0 },
      week: { workedHours: 0, targetHours: 0 },
      overtime: { balanceHours: 0 },
      vacation: { remaining: 0, total: 0, used: 0 },
      periodType: "week",
      scheduleType: null,
    });
    expect(spies.timeEntryFindMany).not.toHaveBeenCalled();
  });

  it("control: a valid token still answers 200 with data, and the spies see its queries", async () => {
    const spies = spyOnQueries();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/",
      headers: { authorization: `Bearer ${data.empToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveProperty("today");
    expect(spies.timeEntryFindMany).toHaveBeenCalled();
  });
});
