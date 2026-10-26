/**
 * Issue #409 — `GET /api/v1/leave/requests?employeeId=<foreign>` for a caller holding only
 * `leave-request:read:EIGENE` answers 403 `{ error: "Forbidden" }` (same form as #368 finding 4 for
 * `GET /time-entries`) instead of silently substituting the caller's own list. Own id and no id
 * stay unchanged; a ZUGEWIESEN caller may still name any employee in reach.
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";

describe("Issue #409 — EIGENE-only caller and a foreign employeeId on GET /leave/requests", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let ownRequestId: string;

  async function list(token: string, query: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/leave/requests${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "lr409");
    const own = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2031-03-03"),
        endDate: new Date("2031-03-03"),
        days: 1,
        status: "PENDING",
      },
    });
    ownRequestId = own.id;
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  it("EIGENE-only caller with a foreign employeeId gets 403 Forbidden", async () => {
    const res = await list(data.empToken, `?employeeId=${data.adminEmployee.id}`);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
  });

  it("EIGENE-only caller with an unknown employeeId gets the same 403", async () => {
    const res = await list(data.empToken, "?employeeId=00000000-0000-4000-8000-000000000000");
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
  });

  it("EIGENE-only caller with the own employeeId gets 200 and the own requests", async () => {
    const res = await list(data.empToken, `?employeeId=${data.employee.id}`);
    expect(res.statusCode).toBe(200);
    const ids = (JSON.parse(res.body) as { id: string }[]).map((r) => r.id);
    expect(ids).toContain(ownRequestId);
  });

  it("EIGENE-only caller without employeeId gets 200 and the own requests", async () => {
    const res = await list(data.empToken, "");
    expect(res.statusCode).toBe(200);
    const ids = (JSON.parse(res.body) as { id: string }[]).map((r) => r.id);
    expect(ids).toContain(ownRequestId);
  });

  it("ZUGEWIESEN caller may still name another employee", async () => {
    const res = await list(data.adminToken, `?employeeId=${data.employee.id}`);
    expect(res.statusCode).toBe(200);
    const ids = (JSON.parse(res.body) as { id: string }[]).map((r) => r.id);
    expect(ids).toContain(ownRequestId);
  });
});
