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
});

// ── Phase 76.31 (D-06) — bsSlot* 4-layer override hierarchy wire-format ─────────
//
// Covers the 3 route layers that persist the bsSlot* Int? override columns:
//   1. TenantConfig  → PUT /settings/work
//   2. Employee      → PATCH /employees/:id
//   3. Pattern       → PUT /employees/:id/vocational-school-pattern
//
// Bounds: daily 240..600 (bsSlotFirst/Second/ShortDay), block-week 1200..3000
// (bsSlotBlockWeek). NULL clears an override (delegate down a layer — D-06).
//
// Threat model: T-76.31-03 (Tampering) — Zod int bounds reject out-of-range input.
describe("Berufsschule bsSlot* override hierarchy (Phase 76.31 Plan 06)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "bsslot");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // Reset all 4 tenant bsSlot* to null between tests so range/null tests are isolated.
  beforeEach(async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: {
        bsSlotFirstLongDayMinutes: null,
        bsSlotSecondLongDayMinutes: null,
        bsSlotShortDayMinutes: null,
        bsSlotBlockWeekMinutes: null,
      },
    });
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: {
        bsSlotFirstLongDayMinutes: null,
        bsSlotSecondLongDayMinutes: null,
        bsSlotShortDayMinutes: null,
        bsSlotBlockWeekMinutes: null,
      },
    });
  });

  // ── Layer 3: TenantConfig ──────────────────────────────────────────────────

  it("PUT /settings/work persists bsSlotFirstLongDayMinutes=570 (round-trips)", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { bsSlotFirstLongDayMinutes: 570 },
    });
    expect(put.statusCode).toBe(200);

    const cfg = await app.prisma.tenantConfig.findUnique({
      where: { tenantId: data.tenant.id },
    });
    expect(cfg?.bsSlotFirstLongDayMinutes).toBe(570);
  });

  it("PUT /settings/work rejects bsSlotFirstLongDayMinutes=100 (below 240) with 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { bsSlotFirstLongDayMinutes: 100 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT /settings/work rejects bsSlotBlockWeekMinutes=5000 (above 3000) with 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { bsSlotBlockWeekMinutes: 5000 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT /settings/work with explicit null clears a tenant bsSlot* override", async () => {
    // Set a value first.
    await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { bsSlotFirstLongDayMinutes: 480 },
    });
    // Explicit null clears it (delegate down the hierarchy).
    const clear = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { bsSlotFirstLongDayMinutes: null },
    });
    expect(clear.statusCode).toBe(200);

    const cfg = await app.prisma.tenantConfig.findUnique({
      where: { tenantId: data.tenant.id },
    });
    expect(cfg?.bsSlotFirstLongDayMinutes).toBeNull();
  });

  // ── Layer 1: Employee (highest priority) ───────────────────────────────────

  it("PATCH /employees/:id persists bsSlotFirstLongDayMinutes=600 on the Employee", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { bsSlotFirstLongDayMinutes: 600 },
    });
    expect(res.statusCode).toBe(200);

    const emp = await app.prisma.employee.findUnique({
      where: { id: data.employee.id },
      select: { bsSlotFirstLongDayMinutes: true },
    });
    expect(emp?.bsSlotFirstLongDayMinutes).toBe(600);
  });

  it("PATCH /employees/:id rejects out-of-bounds bsSlotFirstLongDayMinutes=999 with 400", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { bsSlotFirstLongDayMinutes: 999 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH /employees/:id with explicit null clears the employee bsSlot* override", async () => {
    // Set first.
    await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { bsSlotFirstLongDayMinutes: 540 },
    });
    // Clear.
    const clear = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { bsSlotFirstLongDayMinutes: null },
    });
    expect(clear.statusCode).toBe(200);

    const emp = await app.prisma.employee.findUnique({
      where: { id: data.employee.id },
      select: { bsSlotFirstLongDayMinutes: true },
    });
    expect(emp?.bsSlotFirstLongDayMinutes).toBeNull();
  });

  // ── Layer 2: Pattern ───────────────────────────────────────────────────────

  it("PUT /employees/:id/vocational-school-pattern persists a bsSlot* value on the pattern", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/employees/${data.employee.id}/vocational-school-pattern`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        patterns: [
          {
            daysOfWeek: [1],
            validFrom: "2026-01-01",
            bsSlotFirstLongDayMinutes: 555,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    const pattern = await app.prisma.employeeVocationalSchoolPattern.findFirst({
      where: { employeeId: data.employee.id, isActive: true },
      orderBy: { validFrom: "desc" },
      select: { bsSlotFirstLongDayMinutes: true },
    });
    expect(pattern?.bsSlotFirstLongDayMinutes).toBe(555);
  });

  it("PUT pattern rejects out-of-bounds bsSlotBlockWeekMinutes=999 with 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/employees/${data.employee.id}/vocational-school-pattern`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        patterns: [
          {
            daysOfWeek: [1],
            validFrom: "2026-01-01",
            bsSlotBlockWeekMinutes: 999,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
