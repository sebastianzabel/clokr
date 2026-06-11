// Phase 63 Plan 04 — Berufsschule endpoint tests (D-18 + D-23).
//
// Covers:
//   - GET /api/v1/vocational-school/upcoming (D-18) — list scoped BS rows
//   - POST /api/v1/vocational-school/manual-insert (D-23) — manager-side insert
//
// Threat model coverage:
//   T-63-15: Information Disclosure  — response shape contains no birthDate/email/classification
//   T-63-16: Spoofing               — cross-tenant employeeId returns 404
//   T-63-17: Tampering              — duplicate (employeeId, date) returns 409 (Prisma P2002)
//   T-63-19: Elevation              — EMPLOYEE role returns 403 (still enforced on /generate,
//                                    /preview, /manual-insert, DELETE /:absenceId)
//   260611-ly6: GET /upcoming now allows EMPLOYEE with server-enforced self-scope;
//               cross-employee leak guarded by regression tests below.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

// UTC 00:00 of the 1st of `d`'s month — matches SaldoSnapshot.periodStart semantics.
function monthStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

// UTC 00:00 of the last day of `d`'s month.
function monthEndUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

// YYYY-MM-DD of a Date in UTC.
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

describe("Berufsschule endpoints (Phase 63 Plan 04)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let otherTenantData: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "vse");
    otherTenantData = await seedTestData(app, "vse-other");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (data):", err);
    }
    try {
      await cleanupTestData(app, otherTenantData.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (otherTenantData):", err);
    }
    await closeTestApp();
  });

  // Wipe BS-relevant state between tests.
  beforeEach(async () => {
    await app.prisma.absence.deleteMany({
      where: {
        employeeId: { in: [data.employee.id, data.adminEmployee.id, otherTenantData.employee.id] },
      },
    });
    await app.prisma.saldoSnapshot.deleteMany({
      where: {
        employeeId: { in: [data.employee.id, data.adminEmployee.id, otherTenantData.employee.id] },
      },
    });
    // Default employee to AZUBI for manual-insert tests; individual tests override.
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { classification: "AZUBI", birthDate: new Date("2010-06-01") },
    });
  });

  // ── D-18: GET /upcoming ────────────────────────────────────────────────────

  it("GET /upcoming returns BS rows for the window scoped to tenant (ADMIN)", async () => {
    // Seed one BS Absence inside the window, one outside, one in other tenant.
    const inWindow = new Date(Date.UTC(2026, 6, 7)); // 2026-07-07
    const outWindow = new Date(Date.UTC(2030, 0, 1));
    await app.prisma.absence.create({
      data: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: inWindow,
        endDate: inWindow,
        days: 1.0,
        createdBy: "SYSTEM",
      },
    });
    await app.prisma.absence.create({
      data: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: outWindow,
        endDate: outWindow,
        days: 1.0,
        createdBy: "SYSTEM",
      },
    });
    await app.prisma.absence.create({
      data: {
        employeeId: otherTenantData.employee.id,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: inWindow,
        endDate: inWindow,
        days: 1.0,
        createdBy: "SYSTEM",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/vocational-school/upcoming?from=2026-07-01&to=2026-07-31",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].date).toBe("2026-07-07");
    expect(body[0].employeeId).toBe(data.employee.id);
    expect(body[0].source).toBe("PATTERN");
    // T-63-15: NO sensitive fields on the response
    expect(body[0]).not.toHaveProperty("birthDate");
    expect(body[0]).not.toHaveProperty("classification");
    expect(body[0].employee).not.toHaveProperty("birthDate");
    expect(body[0].employee).not.toHaveProperty("email");
    expect(body[0].employee).not.toHaveProperty("classification");
    // Safe fields ARE present
    expect(body[0].employee.firstName).toBe("Max");
    expect(body[0].employee.lastName).toBe("Test");
    expect(body[0].employee.employeeNumber).toBeTruthy();
  });

  it("GET /upcoming cross-tenant: a token from tenant A cannot see tenant B's BS rows", async () => {
    const sharedDate = new Date(Date.UTC(2026, 6, 10));
    await app.prisma.absence.create({
      data: {
        employeeId: otherTenantData.employee.id,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: sharedDate,
        endDate: sharedDate,
        days: 1.0,
        createdBy: "SYSTEM",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/vocational-school/upcoming?from=2026-07-01&to=2026-07-31",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(0);
  });

  it("GET /upcoming returns empty array when no BS in window", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/vocational-school/upcoming?from=2030-01-01&to=2030-01-31",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual([]);
  });

  it("GET /upcoming excludes soft-deleted Absences", async () => {
    const inWindow = new Date(Date.UTC(2026, 6, 14));
    await app.prisma.absence.create({
      data: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: inWindow,
        endDate: inWindow,
        days: 1.0,
        createdBy: "SYSTEM",
        deletedAt: new Date(),
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/vocational-school/upcoming?from=2026-07-01&to=2026-07-31",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it("GET /upcoming as MANAGER returns tenant rows (200, not 403)", async () => {
    // Promote admin user to MANAGER role for the test by minting a token via DB swap.
    // Easier: use the existing admin token but verify the route accepts MANAGER too.
    // We achieve this by setting the adminUser's role to MANAGER and re-logging in.
    await app.prisma.user.update({
      where: { id: data.adminUser.id },
      data: { role: "MANAGER" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: data.adminUser.email, password: "test1234" },
    });
    const { accessToken: managerToken } = JSON.parse(login.body);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/vocational-school/upcoming?from=2026-07-01&to=2026-07-31",
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(res.statusCode).toBe(200);

    // Restore role for following tests.
    await app.prisma.user.update({
      where: { id: data.adminUser.id },
      data: { role: "ADMIN" },
    });
  });

  // 260611-ly6 — GET /upcoming now accepts EMPLOYEE role with server-enforced self-scope.
  // The 403 guard from T-63-19 no longer applies to this endpoint (still enforced on
  // /generate, /preview, /manual-insert, DELETE /:absenceId).

  it("GET /upcoming as EMPLOYEE without BS-Absences returns empty array (260611-ly6)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/vocational-school/upcoming?from=2026-07-01&to=2026-07-31",
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it("GET /upcoming as EMPLOYEE returns OWN BS-Absence, NEVER another employee's row in the same tenant (260611-ly6, cross-employee leak guard)", async () => {
    // Seed two BS-Absences in the SAME tenant for two DIFFERENT employees.
    const selfDate = new Date(Date.UTC(2026, 6, 8)); // 2026-07-08
    const otherDate = new Date(Date.UTC(2026, 6, 9)); // 2026-07-09
    await app.prisma.absence.create({
      data: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: selfDate,
        endDate: selfDate,
        days: 1.0,
        createdBy: "SYSTEM",
      },
    });
    await app.prisma.absence.create({
      data: {
        employeeId: data.adminEmployee.id,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: otherDate,
        endDate: otherDate,
        days: 1.0,
        createdBy: "SYSTEM",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/vocational-school/upcoming?from=2026-07-01&to=2026-07-31",
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].employeeId).toBe(data.employee.id);
    expect(body[0].date).toBe("2026-07-08");
    // Defensive: under no circumstances should the admin's BS-row appear.
    expect(
      body.find((r: { employeeId: string }) => r.employeeId === data.adminEmployee.id),
    ).toBeUndefined();
  });

  it("GET /upcoming as EMPLOYEE passing ?employeeId=<other-uuid> is server-overridden to self (260611-ly6, defense-in-depth)", async () => {
    // Same seed shape as the cross-employee leak guard above.
    const selfDate = new Date(Date.UTC(2026, 6, 8));
    const otherDate = new Date(Date.UTC(2026, 6, 9));
    await app.prisma.absence.create({
      data: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: selfDate,
        endDate: selfDate,
        days: 1.0,
        createdBy: "SYSTEM",
      },
    });
    await app.prisma.absence.create({
      data: {
        employeeId: data.adminEmployee.id,
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        startDate: otherDate,
        endDate: otherDate,
        days: 1.0,
        createdBy: "SYSTEM",
      },
    });

    // Caller is the EMPLOYEE but explicitly asks for the admin's BS-rows.
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/vocational-school/upcoming?from=2026-07-01&to=2026-07-31&employeeId=${data.adminEmployee.id}`,
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Server MUST override the client-supplied employeeId back to req.user.employeeId.
    expect(body).toHaveLength(1);
    expect(body[0].employeeId).toBe(data.employee.id);
    expect(body[0].date).toBe("2026-07-08");
    expect(
      body.find((r: { employeeId: string }) => r.employeeId === data.adminEmployee.id),
    ).toBeUndefined();
  });

  it("GET /upcoming returns 401 unauthenticated", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/vocational-school/upcoming?from=2026-07-01&to=2026-07-31",
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /upcoming returns 400 when from/to malformed", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/vocational-school/upcoming?from=07-2026&to=garbage",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── D-23: POST /manual-insert ──────────────────────────────────────────────

  it("POST /manual-insert creates Absence with source=MANUAL for AZUBI", async () => {
    const date = "2026-08-15";
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: data.employee.id, date },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBeTruthy();
    expect(body.source).toBe("MANUAL");
    expect(body.type).toBe("VOCATIONAL_SCHOOL");

    // Audit log entry was written.
    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "VOCATIONAL_SCHOOL_MANUAL_INSERTED", entityId: body.id },
    });
    expect(audit).toBeTruthy();

    // Cleanup the audit row so subsequent test runs aren't polluted.
    if (audit) await app.prisma.auditLog.delete({ where: { id: audit.id } });
  });

  it("POST /manual-insert returns 400 for non-AZUBI with German message", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { classification: "VOLLZEIT" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: data.employee.id, date: "2026-09-10" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error || body.message).toMatch(/Auszubildende/);
  });

  it("POST /manual-insert returns 404 cross-tenant (T-63-16)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: otherTenantData.employee.id, date: "2026-09-10" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /manual-insert returns 403 when date is in locked month", async () => {
    // Insert SaldoSnapshot on (employeeId, MONTHLY, monthStartUtc(date))
    const targetDate = new Date(Date.UTC(2026, 9, 14)); // 2026-10-14
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: data.employee.id,
        periodType: "MONTHLY",
        periodStart: monthStartUtc(targetDate),
        periodEnd: monthEndUtc(targetDate),
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: data.employee.id, date: toIsoDate(targetDate) },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error || body.message).toMatch(/abgeschlossen/);
  });

  it("POST /manual-insert returns 409 on duplicate date (T-63-17, P2002)", async () => {
    const date = "2026-11-04";
    // First insert
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: data.employee.id, date },
    });
    expect(first.statusCode).toBe(201);

    // Second insert with same (employeeId, date) — DB unique constraint catches it.
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: data.employee.id, date },
    });
    expect(second.statusCode).toBe(409);
    const body = JSON.parse(second.body);
    expect(body.error || body.message).toMatch(/existiert bereits/);
  });

  it("POST /manual-insert returns 403 for EMPLOYEE role (T-63-19)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { employeeId: data.employee.id, date: "2026-12-01" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /manual-insert returns 401 unauthenticated", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      payload: { employeeId: data.employee.id, date: "2026-12-01" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /manual-insert returns 400 on malformed payload", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: "not-a-uuid", date: "2026-12-01" },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── 260601-g8l: DELETE /:absenceId (BS-Tag removal) ──────────────────────
  // Symmetric counterpart to D-23 manual-insert. Gates (in order):
  //   1. AuthN/AuthZ via requireRole ADMIN/MANAGER.
  //   2. Zod path-param parse (UUID) → 400 via global error handler.
  //   3. Cross-tenant Absence lookup → 404 if employee.tenantId !== caller.
  //   4. Type guard: type !== "VOCATIONAL_SCHOOL" → 400.
  //   5. Idempotency: deletedAt !== null → 404 (soft-deleted rows are invisible).
  //   6. Locked-month gate via SaldoSnapshot → 403.
  // On success: soft delete (deletedAt = now) + VOCATIONAL_SCHOOL_MANUAL_DELETED audit
  // row with oldValue snapshot (employeeId, date, source). Returns 204.

  describe("DELETE /:absenceId (BS-Tag removal)", () => {
    it("soft-deletes Absence, returns 204, and writes audit row (happy path)", async () => {
      // Future date OUTSIDE any locked month.
      const date = new Date(Date.UTC(2027, 2, 17)); // 2027-03-17
      const absence = await app.prisma.absence.create({
        data: {
          employeeId: data.employee.id,
          type: "VOCATIONAL_SCHOOL",
          source: "MANUAL",
          startDate: date,
          endDate: date,
          days: 1.0,
          createdBy: data.adminUser.id,
        },
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/vocational-school/${absence.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(204);

      // Soft delete — row still present, deletedAt set.
      const after = await app.prisma.absence.findUnique({ where: { id: absence.id } });
      expect(after).toBeTruthy();
      expect(after?.deletedAt).not.toBeNull();

      // Audit row exists with oldValue snapshot.
      const audit = await app.prisma.auditLog.findFirst({
        where: { action: "VOCATIONAL_SCHOOL_MANUAL_DELETED", entityId: absence.id },
      });
      expect(audit).toBeTruthy();
      expect(audit?.entity).toBe("Absence");
      expect(audit?.userId).toBe(data.adminUser.id);
      const old = audit?.oldValue as { employeeId: string; date: string; source: string };
      expect(old.employeeId).toBe(data.employee.id);
      expect(old.date).toBe("2027-03-17");
      expect(old.source).toBe("MANUAL");

      // Cleanup audit row so subsequent test runs aren't polluted.
      if (audit) await app.prisma.auditLog.delete({ where: { id: audit.id } });
    });

    it("returns 404 cross-tenant (T-g8l-01)", async () => {
      const date = new Date(Date.UTC(2027, 3, 14));
      const absence = await app.prisma.absence.create({
        data: {
          employeeId: otherTenantData.employee.id,
          type: "VOCATIONAL_SCHOOL",
          source: "MANUAL",
          startDate: date,
          endDate: date,
          days: 1.0,
          createdBy: "SYSTEM",
        },
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/vocational-school/${absence.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/nicht gefunden/);
    });

    it("returns 404 when Absence is already soft-deleted (T-g8l-08)", async () => {
      const date = new Date(Date.UTC(2027, 4, 5));
      const absence = await app.prisma.absence.create({
        data: {
          employeeId: data.employee.id,
          type: "VOCATIONAL_SCHOOL",
          source: "MANUAL",
          startDate: date,
          endDate: date,
          days: 1.0,
          createdBy: "SYSTEM",
          deletedAt: new Date(),
        },
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/vocational-school/${absence.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 400 when target Absence is not VOCATIONAL_SCHOOL", async () => {
      const date = new Date(Date.UTC(2027, 5, 9));
      const absence = await app.prisma.absence.create({
        data: {
          employeeId: data.employee.id,
          type: "SICK",
          source: "MANUAL",
          startDate: date,
          endDate: date,
          days: 1.0,
          createdBy: "SYSTEM",
        },
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/vocational-school/${absence.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/kein Berufsschultag/);
    });

    it("returns 403 when target date is in a locked month (T-g8l-07)", async () => {
      const date = new Date(Date.UTC(2027, 6, 21)); // 2027-07-21
      const absence = await app.prisma.absence.create({
        data: {
          employeeId: data.employee.id,
          type: "VOCATIONAL_SCHOOL",
          source: "MANUAL",
          startDate: date,
          endDate: date,
          days: 1.0,
          createdBy: "SYSTEM",
        },
      });
      await app.prisma.saldoSnapshot.create({
        data: {
          employeeId: data.employee.id,
          periodType: "MONTHLY",
          periodStart: monthStartUtc(date),
          periodEnd: monthEndUtc(date),
          workedMinutes: 0,
          expectedMinutes: 0,
          balanceMinutes: 0,
          carryOver: 0,
          closedAt: new Date(),
        },
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/vocational-school/${absence.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/abgeschlossen/);
    });

    it("returns 403 for EMPLOYEE role (T-g8l-06)", async () => {
      const date = new Date(Date.UTC(2027, 7, 11));
      const absence = await app.prisma.absence.create({
        data: {
          employeeId: data.employee.id,
          type: "VOCATIONAL_SCHOOL",
          source: "MANUAL",
          startDate: date,
          endDate: date,
          days: 1.0,
          createdBy: "SYSTEM",
        },
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/vocational-school/${absence.id}`,
        headers: { authorization: `Bearer ${data.empToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns 401 unauthenticated", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/vocational-school/00000000-0000-0000-0000-000000000000",
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 400 on malformed absenceId", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/vocational-school/not-a-uuid",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
