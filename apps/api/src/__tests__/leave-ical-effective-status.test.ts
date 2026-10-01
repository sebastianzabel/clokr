/**
 * Issue #446 (D-04) — the iCal feeds count a leave under requested cancellation exactly like an
 * approved one. Before this phase `GET /ical/personal` and `GET /ical/team` filtered
 * `status: "APPROVED"` only, so an employee whose cancellation is merely requested — still
 * active per CLAUDE.md § Leave Cancellation Flow — silently disappeared from both calendar
 * feeds.
 *
 * Fixture shape copied from leave.test.ts's `seed()`/`it("GET /ical/...")` pattern: one
 * `seedTestData` tenant per describe block, a direct `leaveRequest.create` for the fixture leave
 * (no review-flow roundtrip needed, since the status itself is the thing under test).
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData, closeTestApp } from "./setup";

describe("Issue #446 (D-04) — iCal feeds include CANCELLATION_REQUESTED leave", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "iceff");
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2026-06-08T00:00:00Z"),
        endDate: new Date("2026-06-12T00:00:00Z"),
        days: 5,
        halfDay: false,
        status: "CANCELLATION_REQUESTED",
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("GET /ical/personal includes a BEGIN:VEVENT with DTSTART;VALUE=DATE:20260608 for the employee's own CANCELLATION_REQUESTED leave", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/leave/ical/personal",
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("BEGIN:VEVENT");
    expect(res.body).toContain("DTSTART;VALUE=DATE:20260608");
  });

  it("GET /ical/team includes a BEGIN:VEVENT with DTSTART;VALUE=DATE:20260608 for a colleague's CANCELLATION_REQUESTED leave", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/leave/ical/team",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("BEGIN:VEVENT");
    expect(res.body).toContain("DTSTART;VALUE=DATE:20260608");
  });
});
