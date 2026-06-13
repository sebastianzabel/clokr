// Phase 63 Plan 04 — Berufsschule TenantConfig wire-format tests (D-02 + D-24).
//
// Covers the additive tenantConfigSchema fields:
//   - vocationalSchoolMinutesPerDay      (Int, 240..600)
//   - vocationalSchoolBlockMinutesPerWeek (Int, 1200..3000)
//
// Threat model:
//   T-63-18: Tampering — Zod min/max prevents persisting out-of-range values
//
// END-TO-END saldo verification (BS-day picks up the new minutes-per-day) is OUT OF
// SCOPE for Plan 04 — the saldo path (overtime.ts) is owned by Plan 63-02 (Wave 2
// parallel). When Plan 02 lands, that test slots in here. This file therefore only
// verifies the wire-format contract: GET returns defaults, PUT validates range, PUT
// persists, GET reads back.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("Berufsschule TenantConfig (Phase 63 Plan 04 Task 2)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "vscfg");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // Reset config to schema defaults between tests so range tests don't pollute each other.
  beforeEach(async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: {
        vocationalSchoolMinutesPerDay: 480,
        vocationalSchoolBlockMinutesPerWeek: 2400,
      },
    });
  });

  // ── D-02 + D-24: GET returns defaults ──────────────────────────────────────

  it("GET /settings/work surfaces vocationalSchoolMinutesPerDay default", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.vocationalSchoolMinutesPerDay).toBe(480);
    expect(body.vocationalSchoolBlockMinutesPerWeek).toBe(2400);
  });

  // ── D-02 valid PUT ────────────────────────────────────────────────────────

  it("PUT /settings/work with valid in-range values persists and round-trips", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        vocationalSchoolMinutesPerDay: 360,
        vocationalSchoolBlockMinutesPerWeek: 1800,
      },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({
      method: "GET",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(get.statusCode).toBe(200);
    const body = JSON.parse(get.body);
    expect(body.vocationalSchoolMinutesPerDay).toBe(360);
    expect(body.vocationalSchoolBlockMinutesPerWeek).toBe(1800);
  });

  // ── D-02 range validation: vocationalSchoolMinutesPerDay ─────────────────

  it("PUT rejects vocationalSchoolMinutesPerDay below 240", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { vocationalSchoolMinutesPerDay: 120 },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    // German message mentions the lower bound.
    expect(JSON.stringify(body)).toMatch(/240/);
  });

  it("PUT rejects vocationalSchoolMinutesPerDay above 600", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { vocationalSchoolMinutesPerDay: 700 },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(JSON.stringify(body)).toMatch(/600/);
  });

  // ── D-02 range validation: vocationalSchoolBlockMinutesPerWeek ────────────

  it("PUT rejects vocationalSchoolBlockMinutesPerWeek below 1200", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { vocationalSchoolBlockMinutesPerWeek: 1000 },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(JSON.stringify(body)).toMatch(/1200/);
  });

  it("PUT rejects vocationalSchoolBlockMinutesPerWeek above 3000", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { vocationalSchoolBlockMinutesPerWeek: 3500 },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(JSON.stringify(body)).toMatch(/3000/);
  });

  // ── Optional-field semantics: empty patch leaves prior values intact ──────

  it("PUT with empty patch leaves prior BS values untouched", async () => {
    // Set custom value first.
    await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { vocationalSchoolMinutesPerDay: 300 },
    });

    // Empty PUT (only unrelated field).
    await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { overtimeThreshold: 65 },
    });

    const get = await app.inject({
      method: "GET",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    const body = JSON.parse(get.body);
    expect(body.vocationalSchoolMinutesPerDay).toBe(300);
    // overtimeThreshold also persisted (sanity check the test mechanic itself works).
    // Decimal field serialises as string in this codebase, so coerce both sides.
    expect(Number(body.overtimeThreshold)).toBe(65);
  });

  // ── Integer-only validation ────────────────────────────────────────────────

  it("PUT rejects vocationalSchoolMinutesPerDay as float", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { vocationalSchoolMinutesPerDay: 480.5 },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Phase 83 — bsSlot* bounds + AuditLog diff (T-83-02 mitigation) ──────────

  it("Phase 83: PUT rejects bsSlotFirstLongDayMinutes above 600 (out-of-bound)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { bsSlotFirstLongDayMinutes: 1440 },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    // German error message must mention the 600-min upper bound
    expect(JSON.stringify(body)).toMatch(/600/);
  });

  it("Phase 83: PUT with valid bsSlotFirstLongDayMinutes=540 persists + AuditLog newValue captures field", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { bsSlotFirstLongDayMinutes: 540 },
    });
    expect(res.statusCode).toBe(200);

    // Confirm DB persisted the value
    const cfg = await app.prisma.tenantConfig.findUnique({
      where: { tenantId: data.tenant.id },
      select: { bsSlotFirstLongDayMinutes: true },
    });
    expect(cfg?.bsSlotFirstLongDayMinutes).toBe(540);

    // AuditLog assertion: latest AuditLog row for TenantConfig entity must have
    // newValue.bsSlotFirstLongDayMinutes === 540 — proves the new field flows
    // through the audit pipeline (checker dimension-9 evidence).
    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "TenantConfig" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    const newValue = audit!.newValue as Record<string, unknown>;
    expect(newValue.bsSlotFirstLongDayMinutes).toBe(540);
  });

  it("Phase 83: PUT with bsSlotFirstLongDayMinutes=null persists as NULL (delegates to lower layer)", async () => {
    // First set a value, then clear it
    await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { bsSlotFirstLongDayMinutes: 480 },
    });
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { bsSlotFirstLongDayMinutes: null },
    });
    expect(res.statusCode).toBe(200);
    const cfg = await app.prisma.tenantConfig.findUnique({
      where: { tenantId: data.tenant.id },
      select: { bsSlotFirstLongDayMinutes: true },
    });
    expect(cfg?.bsSlotFirstLongDayMinutes).toBeNull();
  });

  it("Phase 83: PUT rejects bsSlotBlockWeekMinutes below 1200", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { bsSlotBlockWeekMinutes: 600 },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(JSON.stringify(body)).toMatch(/1200/);
  });
});
