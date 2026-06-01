// Phase 64 Plan 02 — Pausendauer validation + audit integration tests (D-07, D-08, D-11).
//
// Covers:
//   - tenantConfigSchema range validation for defaultBreakOver6h (30..120)
//     and defaultBreakOver9h (45..180) with verbatim German error messages
//     citing ArbZG §4 Pflichtpause.
//   - BREAK_DEFAULT_CHANGED audit row emitted on successful PUT, NOT emitted
//     on no-op PUT.
//   - Employee Zod validation for breakOver{6,9}hOverride on PATCH (and null
//     to clear).
//   - EMPLOYEE_BREAK_OVERRIDE_CHANGED audit row emitted on successful PATCH,
//     NOT emitted on no-op PATCH.
//
// Threat model:
//   T-64-12, T-64-13 (Tampering — Zod min/max gate)
//   T-64-14, T-64-15 (Repudiation — dedicated audit rows)
//   T-64-17 (DoS — optional fields keep old clients working)

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

// ── Tenant defaults: PUT validation + audit ────────────────────────────────────

describe("break-config: tenant defaults", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "bcfg-tenant");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // Reset config to schema defaults between tests so audit-diff tests start from
  // a known baseline (defaults 30/45).
  beforeEach(async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { defaultBreakOver6h: 30, defaultBreakOver9h: 45 },
    });
    // Also wipe break-default audit rows so tests can assert "exactly one new row".
    await app.prisma.auditLog.deleteMany({
      where: {
        action: "BREAK_DEFAULT_CHANGED",
        entity: "TenantConfig",
      },
    });
  });

  // ── Range validation (floor) ─────────────────────────────────────────────────

  it("rejects defaultBreakOver6h below ArbZG-Floor (25) with German message", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { defaultBreakOver6h: 25 },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    const blob = JSON.stringify(body);
    expect(blob).toMatch(/30 Minuten/);
    expect(blob).toMatch(/ArbZG/);
  });

  it("rejects defaultBreakOver9h below ArbZG-Floor (44) with German message", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { defaultBreakOver9h: 44 },
    });
    expect(res.statusCode).toBe(400);
    const blob = JSON.stringify(JSON.parse(res.body));
    expect(blob).toMatch(/45 Minuten/);
    expect(blob).toMatch(/ArbZG/);
  });

  // ── Range validation (cap) ───────────────────────────────────────────────────

  it("rejects defaultBreakOver6h above cap (121) with German cap message", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { defaultBreakOver6h: 121 },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(JSON.parse(res.body))).toMatch(/120 Minuten/);
  });

  it("rejects defaultBreakOver9h above cap (181) with German cap message", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { defaultBreakOver9h: 181 },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(JSON.parse(res.body))).toMatch(/180 Minuten/);
  });

  // ── Boundary acceptance ──────────────────────────────────────────────────────

  it("accepts defaultBreakOver6h at floor (30) and cap (120)", async () => {
    const r1 = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { defaultBreakOver6h: 30 },
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { defaultBreakOver6h: 120 },
    });
    expect(r2.statusCode).toBe(200);
  });

  it("accepts defaultBreakOver9h at floor (45) and cap (180)", async () => {
    const r1 = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { defaultBreakOver9h: 45 },
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { defaultBreakOver9h: 180 },
    });
    expect(r2.statusCode).toBe(200);
  });

  // ── Persistence + GET round-trip ─────────────────────────────────────────────

  it("PUT persists both fields and GET round-trips the values", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { defaultBreakOver6h: 60, defaultBreakOver9h: 90 },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({
      method: "GET",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(get.statusCode).toBe(200);
    const body = JSON.parse(get.body);
    expect(body.defaultBreakOver6h).toBe(60);
    expect(body.defaultBreakOver9h).toBe(90);
  });

  // ── Audit emission on change ─────────────────────────────────────────────────

  it("emits BREAK_DEFAULT_CHANGED audit row when defaults change", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { defaultBreakOver6h: 60, defaultBreakOver9h: 90 },
    });
    expect(put.statusCode).toBe(200);

    const auditRow = await app.prisma.auditLog.findFirst({
      where: {
        action: "BREAK_DEFAULT_CHANGED",
        entity: "TenantConfig",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRow).not.toBeNull();
    const oldVal = auditRow!.oldValue as { defaultBreakOver6h: number; defaultBreakOver9h: number };
    const newVal = auditRow!.newValue as { defaultBreakOver6h: number; defaultBreakOver9h: number };
    expect(oldVal.defaultBreakOver6h).toBe(30);
    expect(oldVal.defaultBreakOver9h).toBe(45);
    expect(newVal.defaultBreakOver6h).toBe(60);
    expect(newVal.defaultBreakOver9h).toBe(90);
  });

  // ── Audit NOT emitted on no-op ───────────────────────────────────────────────

  it("does NOT emit BREAK_DEFAULT_CHANGED when no break field is in the body", async () => {
    // PUT touching only an unrelated field
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { overtimeThreshold: 65 },
    });
    expect(put.statusCode).toBe(200);

    const auditRow = await app.prisma.auditLog.findFirst({
      where: {
        action: "BREAK_DEFAULT_CHANGED",
        entity: "TenantConfig",
      },
    });
    expect(auditRow).toBeNull();
  });

  it("does NOT emit BREAK_DEFAULT_CHANGED when value is identical to current", async () => {
    // Current is 30/45 (reset by beforeEach). Submit identical values.
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { defaultBreakOver6h: 30, defaultBreakOver9h: 45 },
    });
    expect(put.statusCode).toBe(200);

    const auditRow = await app.prisma.auditLog.findFirst({
      where: {
        action: "BREAK_DEFAULT_CHANGED",
        entity: "TenantConfig",
      },
    });
    expect(auditRow).toBeNull();
  });
});

// ── Employee overrides: PATCH validation + audit ──────────────────────────────

describe("break-config: employee overrides", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "bcfg-emp");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // Reset employee overrides to null and wipe override audit rows for clean assertions.
  beforeEach(async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { breakOver6hOverride: null, breakOver9hOverride: null },
    });
    await app.prisma.auditLog.deleteMany({
      where: {
        action: "EMPLOYEE_BREAK_OVERRIDE_CHANGED",
        entity: "Employee",
        entityId: data.employee.id,
      },
    });
  });

  // ── Range validation (floor + cap) ───────────────────────────────────────────

  it("rejects breakOver6hOverride below floor (25) with German message", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { breakOver6hOverride: 25 },
    });
    expect(res.statusCode).toBe(400);
    const blob = JSON.stringify(JSON.parse(res.body));
    expect(blob).toMatch(/30 Minuten/);
    expect(blob).toMatch(/ArbZG/);
  });

  it("rejects breakOver9hOverride above cap (181) with German message", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { breakOver9hOverride: 181 },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(JSON.parse(res.body))).toMatch(/180 Minuten/);
  });

  it("accepts null breakOver6hOverride (clears override)", async () => {
    // First set a value, then clear it.
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { breakOver6hOverride: 60 },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { breakOver6hOverride: null },
    });
    expect(res.statusCode).toBe(200);
    const after = await app.prisma.employee.findUnique({
      where: { id: data.employee.id },
      select: { breakOver6hOverride: true },
    });
    expect(after?.breakOver6hOverride).toBeNull();
  });

  it("accepts valid override value (60 for 6h, 90 for 9h)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { breakOver6hOverride: 60, breakOver9hOverride: 90 },
    });
    expect(res.statusCode).toBe(200);
    const after = await app.prisma.employee.findUnique({
      where: { id: data.employee.id },
      select: { breakOver6hOverride: true, breakOver9hOverride: true },
    });
    expect(after?.breakOver6hOverride).toBe(60);
    expect(after?.breakOver9hOverride).toBe(90);
  });

  // ── Audit emission on change ─────────────────────────────────────────────────

  it("emits EMPLOYEE_BREAK_OVERRIDE_CHANGED audit row when override is set", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { breakOver6hOverride: 60 },
    });
    expect(res.statusCode).toBe(200);

    const auditRow = await app.prisma.auditLog.findFirst({
      where: {
        action: "EMPLOYEE_BREAK_OVERRIDE_CHANGED",
        entity: "Employee",
        entityId: data.employee.id,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRow).not.toBeNull();
    const oldVal = auditRow!.oldValue as {
      breakOver6hOverride: number | null;
      breakOver9hOverride: number | null;
    };
    const newVal = auditRow!.newValue as {
      breakOver6hOverride: number | null;
      breakOver9hOverride: number | null;
    };
    expect(oldVal.breakOver6hOverride).toBeNull();
    expect(newVal.breakOver6hOverride).toBe(60);
  });

  it("emits EMPLOYEE_BREAK_OVERRIDE_CHANGED audit row when override is cleared (null)", async () => {
    // Pre-set a value so the clear is a real change.
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { breakOver6hOverride: 60 },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { breakOver6hOverride: null },
    });
    expect(res.statusCode).toBe(200);

    const auditRow = await app.prisma.auditLog.findFirst({
      where: {
        action: "EMPLOYEE_BREAK_OVERRIDE_CHANGED",
        entity: "Employee",
        entityId: data.employee.id,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRow).not.toBeNull();
    const newVal = auditRow!.newValue as { breakOver6hOverride: number | null };
    expect(newVal.breakOver6hOverride).toBeNull();
  });

  // ── Audit NOT emitted on no-op ───────────────────────────────────────────────

  it("does NOT emit EMPLOYEE_BREAK_OVERRIDE_CHANGED when no break field is in the body", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { firstName: "NewName" },
    });
    expect(res.statusCode).toBe(200);

    const auditRow = await app.prisma.auditLog.findFirst({
      where: {
        action: "EMPLOYEE_BREAK_OVERRIDE_CHANGED",
        entity: "Employee",
        entityId: data.employee.id,
      },
    });
    expect(auditRow).toBeNull();
  });

  it("does NOT emit EMPLOYEE_BREAK_OVERRIDE_CHANGED when value is identical to current", async () => {
    // Pre-set a value so the submitted identical value is a no-op.
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { breakOver6hOverride: 60 },
    });
    // Wipe any audit row produced by the previous test's PATCH.
    await app.prisma.auditLog.deleteMany({
      where: {
        action: "EMPLOYEE_BREAK_OVERRIDE_CHANGED",
        entity: "Employee",
        entityId: data.employee.id,
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { breakOver6hOverride: 60 },
    });
    expect(res.statusCode).toBe(200);

    const auditRow = await app.prisma.auditLog.findFirst({
      where: {
        action: "EMPLOYEE_BREAK_OVERRIDE_CHANGED",
        entity: "Employee",
        entityId: data.employee.id,
      },
    });
    expect(auditRow).toBeNull();
  });
});
