/**
 * Phase 77b (Issue #77, D-10/D-11) — route-level proof that a missing tenant frame fails closed.
 *
 * GET /api/v1/dashboard/ builds its access context with `accessContextFromRequest(req)` before the
 * first query. A token whose tenantId is empty, whitespace-only or absent must get HTTP 500 with
 * the fixed body `{ error: "Interner Serverfehler" }`, one error log entry naming the route, and no
 * Prisma query at all — never a data response and never the internal error message.
 *
 * The control case (a real login token) proves the same spies DO see a query on the happy path, so
 * "not called" below is not vacuous. A token with neither employeeId nor tenant keeps the
 * documented DB-free 200 empty-stats answer (that branch returns before the guard on purpose).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { MockInstance } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { JwtPayload } from "../middleware/auth";

type LogCall = unknown[];

describe("access context missing -> 500 (Phase 77b, Issue #77)", () => {
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
    it(`answers 500 without any query and logs the route (${name})`, async () => {
      const token = signToken({
        sub: data.empUser.id,
        role: data.empUser.role,
        employeeId: data.employee.id,
        ...tenant,
      });
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
          | { route?: unknown; method?: unknown; err?: { name?: unknown } }
          | undefined;
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

  it("keeps the DB-free 200 empty-stats answer for a token without employeeId and tenant", async () => {
    const token = signToken({ sub: data.adminUser.id, role: data.adminUser.role, tenantId: "" });
    const spies = spyOnQueries();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/",
      headers: { authorization: `Bearer ${token}` },
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
