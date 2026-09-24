/**
 * Issue #330 — the global error handler must never echo internal error text on a 5xx.
 *
 * Before the fix, `app.setErrorHandler` sent `error.message` for every non-Zod error, so an
 * unexpected Prisma error reached the client with model, field and constraint names. The
 * contract now is:
 *   - status >= 500 → body is always `{ "error": "Interner Serverfehler" }`; the original
 *     message goes to the log only, together with route and request id.
 *   - a 4xx thrown deliberately with `statusCode` keeps its (German) message.
 *   - the Zod branch (400 "Validierungsfehler") is unchanged.
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { Prisma } from "@clokr/db";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";

const GENERIC_BODY = { error: "Interner Serverfehler" };

// A message shaped like the real thing: Prisma names the client call, the model and the
// constraint fields. None of it may reach the client.
const PRISMA_MESSAGE =
  "\nInvalid `prisma.employee.findMany()` invocation:\n\n\nUnique constraint failed on the fields: (`tenantId`,`employeeNumber`)";

describe("global error handler — 5xx bodies carry no internal text (Issue #330)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "err5xx");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  function listEmployees() {
    return app.inject({
      method: "GET",
      url: "/api/v1/employees",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
  }

  it("a Prisma error thrown from a route → 500 with the fixed body, original text only in the log", async () => {
    const prismaError = new Prisma.PrismaClientKnownRequestError(PRISMA_MESSAGE, {
      code: "P2002",
      clientVersion: Prisma.prismaVersion.client,
      meta: { modelName: "Employee", target: ["tenantId", "employeeNumber"] },
    });
    vi.spyOn(app.prisma.employee, "findMany").mockRejectedValueOnce(prismaError as never);
    const logSpy = vi.spyOn(app.log, "error");

    const res = await listEmployees();

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual(GENERIC_BODY);
    const lower = res.body.toLowerCase();
    for (const leak of ["prisma", "employee", "findmany", "p2002", "tenantid", "constraint"]) {
      expect(lower, `response body leaks "${leak}"`).not.toContain(leak);
    }

    // The original error is not lost: it is logged with route and request id.
    const logged = logSpy.mock.calls.find(
      ([obj]) =>
        typeof obj === "object" && obj !== null && (obj as { err?: unknown }).err === prismaError,
    );
    expect(logged, "original error must be logged").toBeDefined();
    const ctx = logged![0] as { route?: string; reqId?: string; method?: string };
    expect(ctx.route).toBe("/api/v1/employees");
    expect(ctx.method).toBe("GET");
    expect(typeof ctx.reqId).toBe("string");
    expect(ctx.reqId!.length).toBeGreaterThan(0);
  });

  it("an error carrying statusCode 503 and an internal message → fixed body as well", async () => {
    vi.spyOn(app.prisma.employee, "findMany").mockRejectedValueOnce(
      Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432 (pool exhausted)"), {
        statusCode: 503,
      }) as never,
    );

    const res = await listEmployees();

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual(GENERIC_BODY);
  });

  it("a 4xx thrown deliberately with statusCode keeps its German message", async () => {
    vi.spyOn(app.prisma.employee, "findMany").mockRejectedValueOnce(
      Object.assign(new Error("Mitarbeiterliste ist gerade gesperrt"), {
        statusCode: 409,
      }) as never,
    );

    const res = await listEmployees();

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: "Mitarbeiterliste ist gerade gesperrt" });
  });

  it("the Zod branch is unchanged: 400 Validierungsfehler with message and details", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Validierungsfehler");
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details.length).toBeGreaterThan(0);
  });
});
