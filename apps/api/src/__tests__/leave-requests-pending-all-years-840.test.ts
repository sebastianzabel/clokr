/**
 * Issue #840 (E-02) — the inbox is the only approval place and lists its open requests with
 * `GET /api/v1/leave/requests?status=PENDING` WITHOUT `year`. That read must therefore return a
 * PENDING request of any year (next January included), and for an approver it also carries the
 * CANCELLATION_REQUESTED rows. A `year` filter still narrows by start date.
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";

describe("Issue #840 — GET /leave/requests?status=PENDING without year", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const ids: Record<string, string> = {};

  async function list(query: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/requests${query}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { id: string }[]).map((r) => r.id);
  }

  async function createRequest(
    key: string,
    start: string,
    status: "PENDING" | "CANCELLATION_REQUESTED" | "APPROVED",
  ) {
    const row = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: new Date(`${start}T00:00:00Z`),
        endDate: new Date(`${start}T00:00:00Z`),
        days: 1,
        status,
      },
    });
    ids[key] = row.id;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "lr840");
    await createRequest("pendingThisYear", "2031-03-03", "PENDING");
    await createRequest("pendingNextJanuary", "2032-01-05", "PENDING");
    await createRequest("cancelNextYear", "2032-02-02", "CANCELLATION_REQUESTED");
    await createRequest("approvedNextYear", "2032-02-03", "APPROVED");
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  it("returns the open requests of every year, cancellation requests included", async () => {
    const got = await list("?status=PENDING");
    expect(got).toContain(ids.pendingThisYear);
    expect(got).toContain(ids.pendingNextJanuary);
    expect(got).toContain(ids.cancelNextYear);
    expect(got).not.toContain(ids.approvedNextYear);
  });

  it("a year filter still narrows by the start date", async () => {
    const got = await list("?status=PENDING&year=2031");
    expect(got).toContain(ids.pendingThisYear);
    expect(got).not.toContain(ids.pendingNextJanuary);
  });
});
