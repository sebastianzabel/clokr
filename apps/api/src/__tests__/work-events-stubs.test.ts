// Phase 77 Plan 04 — /api/v1/work-events stub registration tests (WORKEVENT-V19-01 + WORKEVENT-V19-03).
// Verifies structural separation of /mine vs management surface (PITFALLS.md E-1/E-2/E-3).
//
// The split between GET /work-events/mine (self-view, role-independent) and the
// management surface (GET /, POST /, PATCH /:id, DELETE /:id; ADMIN/MANAGER only)
// is the structural mitigation for the v1.8.12 cross-employee leak class. ADMIN
// users with their own Employee row MUST call /mine for self-view and get
// self-scoped responses — never the management endpoint.
//
// In this phase the bodies return 501 Not Implemented. Phase 79 fills them with
// locked-month gate + Zod payload parse + Prisma create/update/delete + AuditLog.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

describe("WorkEvent endpoint stubs (Phase 77 Plan 04)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let managerToken: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "we-stubs");

    // Seed a MANAGER user/employee in the same tenant — seedTestData only seeds
    // ADMIN + EMPLOYEE. Pattern mirrored from leave.test.ts:670+.
    const passwordHash = await bcrypt.hash("test1234", 10);
    const email = `mgr-we-stubs-${Date.now()}@test.de`;
    const mgrUser = await app.prisma.user.create({
      data: { email, passwordHash, role: "MANAGER", isActive: true },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: mgrUser.id,
        employeeNumber: `M-WE-${Date.now()}`,
        firstName: "Manager",
        lastName: "WeStubs",
        hireDate: new Date("2024-01-01"),
      },
    });
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: "test1234" },
    });
    managerToken = JSON.parse(loginRes.body).accessToken;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  const SAMPLE_ID = "00000000-0000-0000-0000-000000000000";

  // ── Auth gate (tests 1-5) — every endpoint returns 401 without JWT ───────────

  it("GET /work-events without auth returns 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/work-events" });
    expect(res.statusCode).toBe(401);
  });

  it("GET /work-events/mine without auth returns 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/work-events/mine" });
    expect(res.statusCode).toBe(401);
  });

  it("POST /work-events without auth returns 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/work-events",
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("PATCH /work-events/:id without auth returns 401", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/work-events/${SAMPLE_ID}`,
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("DELETE /work-events/:id without auth returns 401", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/work-events/${SAMPLE_ID}`,
    });
    expect(res.statusCode).toBe(401);
  });

  // ── 501 stubs (tests 6, 12, 13, 14) — ADMIN/MANAGER get Not Implemented ──────

  it("GET /work-events as ADMIN returns 200 (wired in Phase 79 Plan 02)", async () => {
    // Phase 79 Plan 02 wired the GET / handler. Stays in this file as a
    // belt-and-suspenders ADMIN-reachability smoke test — the comprehensive
    // contract suite lives in work-events-get.test.ts (T1-T10).
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
  });

  it("POST /work-events as ADMIN with empty body returns 400 (Zod validation; wired in Phase 79 Plan 03)", async () => {
    // Phase 79 Plan 03 wired the POST handler. Empty body fails the Zod parse
    // (missing employeeId/date/type/workedMinutes) → 400. Belt-and-suspenders
    // smoke test that the endpoint is reachable with ADMIN auth; comprehensive
    // contract in work-events-mutations.test.ts (P1-P13).
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/[a-zA-ZäöüÄÖÜß]/);
  });

  it("PATCH /work-events/:id as MANAGER returns 404 for nonexistent id (wired in Phase 79 Plan 03)", async () => {
    // Phase 79 Plan 03 wired the PATCH handler. SAMPLE_ID is the zero UUID — no
    // matching row exists → 404. Comprehensive contract in
    // work-events-mutations.test.ts (U1-U10).
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/work-events/${SAMPLE_ID}`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { note: "stub-smoke" },
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/[a-zA-ZäöüÄÖÜß]/);
  });

  it("DELETE /work-events/:id as MANAGER returns 404 for nonexistent id (wired in Phase 79 Plan 03)", async () => {
    // Phase 79 Plan 03 wired the DELETE handler. SAMPLE_ID is the zero UUID —
    // no matching row exists → 404. Comprehensive contract in
    // work-events-mutations.test.ts (D1-D8).
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/work-events/${SAMPLE_ID}`,
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // ── Structural separation (tests 7, 8, 15) — /mine vs management ────────────

  it("GET /work-events/mine as EMPLOYEE returns 200 (any authenticated user can call /mine)", async () => {
    // E-1/E-2 mitigation: /mine is structurally separate from the management
    // surface and is NOT role-gated. Any authenticated user gets self-scoped
    // behavior. Returning 403 here would be a false positive against this design.
    // Wired in Phase 79 Plan 02 — comprehensive contract in work-events-get.test.ts (M1-M10).
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events/mine",
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /work-events as EMPLOYEE returns 403 Forbidden (management endpoint is role-gated)", async () => {
    // E-1 mitigation: management endpoint is a separate URL path with its own
    // requireRole guard. EMPLOYEE without manager role must be rejected here even
    // though the same user can hit /mine successfully.
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET /work-events/mine as ADMIN returns 200 (ADMIN gets self-scoped /mine — no role-branched leak)", async () => {
    // T-77-16 mitigation: ADMIN-with-Employee-row hitting /mine MUST land in the
    // self-scoped handler — NOT a tenant-wide branch. The split makes the
    // v1.8.12 leak class structurally impossible: there is no role check on
    // /mine because /mine is always self-scoped by design.
    // Wired in Phase 79 Plan 02. The headline leak-class REGRESSION assertion
    // (admin self-view never returns other employees' rows) lives in
    // work-events-get.test.ts → Test M2.
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/work-events/mine",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  // ── Role gating (tests 9, 10, 11) — management endpoints reject EMPLOYEE ────

  it("POST /work-events as EMPLOYEE returns 403", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it("PATCH /work-events/:id as EMPLOYEE returns 403", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/work-events/${SAMPLE_ID}`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it("DELETE /work-events/:id as EMPLOYEE returns 403", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/work-events/${SAMPLE_ID}`,
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
