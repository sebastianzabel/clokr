// Phase 79 Plan 04 — BC proxy tests for /api/v1/vocational-school/*.
//
// Asserts:
//   - Every response from the route surface carries the RFC 8594 deprecation
//     headers `Deprecation: true` + `Sunset: Wed, 31 Dec 2026 23:59:59 GMT` —
//     INCLUDING the global Zod-error handler path (REVISION B4 / Test H9). The
//     headers are set via `onRequest` so they reach the reply object BEFORE the
//     global setErrorHandler can short-circuit the lifecycle.
//   - Conditional routing on `tenantConfig.workEventModelLive`:
//     - false → legacy Absence path preserved (no regression)
//     - true  → new path writes/reads WorkEvent rows
//   - Live-branch POST writes a COMPUTED workedMinutes from the employee's
//     effective WorkSchedule (REVISION B3 / Test R10) — Phase 78 D-08 adapter
//     parity invariant.
//   - Live-branch POST writes TWO AuditLog rows in the same transaction:
//     `WORK_EVENT_CREATED` (primary, matches Plan 79-03's canonical action) plus
//     `VOCATIONAL_SCHOOL_MANUAL_INSERTED_VIA_BC_PROXY` (breadcrumb so reviewers
//     can trace mutations back to the legacy surface) — REVISION B6 / Test R11.
//   - DELETE falls through from WorkEvent → Absence on id-miss to support stale
//     client ids in the post-migration grace window. Edge cases DR7 (soft-
//     deleted WorkEvent id → 404) and DR8 (SICK Absence id → 400) preserved.
//
// Test slugs (`vs-bc-*`) keep per-tenant config isolated across describe blocks.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { AbsenceType, WorkEventType, EmployeeClassification, ScheduleType } from "@clokr/db";
import { monthRangeUtc } from "../utils/timezone";
// WR-02 (Phase 79 review): tenant-flag cache invalidation hook. Tests flip
// `tenantConfig.workEventModelLive` mid-test and expect the next request to
// observe the new value — the cache (5-min TTL) would otherwise hide the flip.
import { invalidateTenantWorkEventModelLiveCache } from "../utils/work-event";

const DEPRECATION = "true";
const SUNSET = "Wed, 31 Dec 2026 23:59:59 GMT";

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utcMidnightToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function offsetDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

// Find the next occurrence of a UTC weekday (0=Sun..6=Sat) starting at `base`.
function nextWeekday(base: Date, weekday: number): Date {
  const d = new Date(base.getTime());
  while (d.getUTCDay() !== weekday) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// H1-H9 — Deprecation + Sunset headers on every response
// ─────────────────────────────────────────────────────────────────────────────
describe("BC proxy headers (Plan 79-04 Task 1 — H1-H9)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "vs-bc-headers");
    // Default employee → AZUBI so manual-insert legacy path can succeed (H5).
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { classification: EmployeeClassification.AZUBI, birthDate: new Date("2010-06-01") },
    });
  });

  afterAll(async () => {
    try {
      await app.prisma.absence.deleteMany({ where: { employeeId: data.employee.id } });
      await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: data.employee.id } });
      await app.prisma.auditLog.deleteMany({
        where: { OR: [{ entity: "Absence" }, { entity: "WorkEvent" }] },
      });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("vs-bc headers cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    await app.prisma.absence.deleteMany({ where: { employeeId: data.employee.id } });
    await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: data.employee.id } });
  });

  it("H1: GET /upcoming → 200 includes deprecation: true header", async () => {
    const today = utcMidnightToday();
    const from = fmtDate(today);
    const to = fmtDate(offsetDays(today, 30));
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/vocational-school/upcoming?from=${from}&to=${to}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["deprecation"]).toBe(DEPRECATION);
  });

  it("H2: GET /upcoming → 200 includes sunset header (RFC 8594 HTTP-date)", async () => {
    const today = utcMidnightToday();
    const from = fmtDate(today);
    const to = fmtDate(offsetDays(today, 30));
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/vocational-school/upcoming?from=${from}&to=${to}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["sunset"]).toBe(SUNSET);
  });

  it("H3: GET /preview → 200 carries both headers", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/vocational-school/preview?weeks=4",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["deprecation"]).toBe(DEPRECATION);
    expect(res.headers["sunset"]).toBe(SUNSET);
  });

  it("H4: POST /generate → 200 carries both headers", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/generate",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["deprecation"]).toBe(DEPRECATION);
    expect(res.headers["sunset"]).toBe(SUNSET);
  });

  it("H5: POST /manual-insert with VALID body → 201 carries both headers", async () => {
    const today = utcMidnightToday();
    const date = fmtDate(offsetDays(today, 14));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: data.employee.id, date },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers["deprecation"]).toBe(DEPRECATION);
    expect(res.headers["sunset"]).toBe(SUNSET);
  });

  it("H6: POST /manual-insert with non-AZUBI employee → 400 carries both headers", async () => {
    // Flip to non-AZUBI so the AZUBI gate rejects the request.
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { classification: EmployeeClassification.VOLLZEIT },
    });
    const today = utcMidnightToday();
    const date = fmtDate(offsetDays(today, 14));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: data.employee.id, date },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers["deprecation"]).toBe(DEPRECATION);
    expect(res.headers["sunset"]).toBe(SUNSET);
    // Restore AZUBI for subsequent tests.
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { classification: EmployeeClassification.AZUBI },
    });
  });

  it("H7: DELETE /:absenceId for nonexistent uuid → 404 carries both headers", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/vocational-school/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["deprecation"]).toBe(DEPRECATION);
    expect(res.headers["sunset"]).toBe(SUNSET);
  });

  it("H8: GET /upcoming with EMPLOYEE role token → 200 carries both headers (EMPLOYEE-self-scope branch)", async () => {
    const today = utcMidnightToday();
    const from = fmtDate(today);
    const to = fmtDate(offsetDays(today, 30));
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/vocational-school/upcoming?from=${from}&to=${to}`,
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["deprecation"]).toBe(DEPRECATION);
    expect(res.headers["sunset"]).toBe(SUNSET);
  });

  it("H9 (REVISION B4 — Zod-error path): malformed body (employeeId: 123) → 400 STILL carries both headers", async () => {
    // Send `employeeId: 123` (number, not UUID string) so the manualInsertSchema
    // rejects via the GLOBAL Zod error handler (apps/api/src/app.ts:setErrorHandler).
    // The onRequest hook MUST have set the headers BEFORE the error handler fires.
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: 123, date: "2026-06-15" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers["deprecation"]).toBe(DEPRECATION);
    expect(res.headers["sunset"]).toBe(SUNSET);
    // Sanity: this is the Zod-error path (global handler emits "Validierungsfehler").
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Validierungsfehler");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R1-R8, R10, R11 — Conditional routing on workEventModelLive
//
// WR-04 (Phase 79 review) — per-tenant-config serialization assumption:
// Every test in this describe block mutates the SAME tenantConfig row
// (slug `vs-bc-routing`). Vitest runs tests inside a single file serially by
// default, so the ordering is well-defined: `beforeEach` resets the flag to
// `false`, and tests opt in by flipping it to `true`. The cache is
// invalidated after each flip via `invalidateTenantWorkEventModelLiveCache`.
//
// If we ever enable per-file parallel runs across BC-proxy specs
// (e.g. `pnpm test --shard` interleaves), the `vs-bc-routing` slug isolates
// us from the other describe blocks (`vs-bc-headers`, `vs-bc-del`) because
// those use distinct slugs and therefore distinct tenant rows. The serial-
// within-file assumption is the only invariant we rely on here.
// ─────────────────────────────────────────────────────────────────────────────
describe("BC proxy routing (Plan 79-04 Task 2 — R1-R11)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let azubiEmpId: string;
  let azubiUserId: string;
  let vollzeitEmpId: string;
  let vollzeitUserId: string;
  // Used by R10 — exercises computeBsWorkedMinutes() over part-time + MONTHLY_HOURS schedules.
  let partTimeEmpId: string;
  let partTimeUserId: string;
  let monthlyEmpId: string;
  let monthlyUserId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "vs-bc-routing");
    // Default flag is `false` (Prisma schema default + seedTestData doesn't set it).
    // Individual tests flip it.

    // AZUBI with FIXED_SCHEDULE 8h/day Mo-Fr (matches the default seedTestData WorkSchedule).
    const u1 = await app.prisma.user.create({
      data: {
        email: `vs-bc-az-${Date.now()}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    azubiUserId = u1.id;
    const e1 = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: u1.id,
        employeeNumber: `VS-AZ-${Date.now()}`,
        firstName: "Azubi",
        lastName: "VS",
        hireDate: new Date("2024-01-01"),
        classification: EmployeeClassification.AZUBI,
      },
    });
    azubiEmpId = e1.id;
    await app.prisma.workSchedule.create({
      data: {
        employeeId: e1.id,
        type: ScheduleType.FIXED_SCHEDULE,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });

    // VOLLZEIT (used for R4 negative gate).
    const u2 = await app.prisma.user.create({
      data: {
        email: `vs-bc-vz-${Date.now()}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    vollzeitUserId = u2.id;
    const e2 = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: u2.id,
        employeeNumber: `VS-VZ-${Date.now()}`,
        firstName: "Vollzeit",
        lastName: "VS",
        hireDate: new Date("2024-01-01"),
        classification: EmployeeClassification.VOLLZEIT,
      },
    });
    vollzeitEmpId = e2.id;

    // Part-time AZUBI (R10 — 4h Mondays).
    const u3 = await app.prisma.user.create({
      data: {
        email: `vs-bc-pt-${Date.now()}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    partTimeUserId = u3.id;
    const e3 = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: u3.id,
        employeeNumber: `VS-PT-${Date.now()}`,
        firstName: "PartTime",
        lastName: "VS",
        hireDate: new Date("2024-01-01"),
        classification: EmployeeClassification.AZUBI,
      },
    });
    partTimeEmpId = e3.id;
    await app.prisma.workSchedule.create({
      data: {
        employeeId: e3.id,
        type: ScheduleType.FIXED_SCHEDULE,
        weeklyHours: 20,
        mondayHours: 4,
        tuesdayHours: 4,
        wednesdayHours: 4,
        thursdayHours: 4,
        fridayHours: 4,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });

    // MONTHLY_HOURS AZUBI (R10 — pauschal 8h per Phase 78 D-08 adapter parity invariant).
    const u4 = await app.prisma.user.create({
      data: {
        email: `vs-bc-mh-${Date.now()}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    monthlyUserId = u4.id;
    const e4 = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: u4.id,
        employeeNumber: `VS-MH-${Date.now()}`,
        firstName: "MonthlyHours",
        lastName: "VS",
        hireDate: new Date("2024-01-01"),
        classification: EmployeeClassification.AZUBI,
      },
    });
    monthlyEmpId = e4.id;
    await app.prisma.workSchedule.create({
      data: {
        employeeId: e4.id,
        type: ScheduleType.MONTHLY_HOURS,
        monthlyHours: 60,
        // Per-day fields default but are not consulted for MONTHLY_HOURS.
        validFrom: new Date("2024-01-01"),
      },
    });
  });

  afterAll(async () => {
    try {
      const ids = [azubiEmpId, vollzeitEmpId, partTimeEmpId, monthlyEmpId];
      await app.prisma.workEvent.deleteMany({ where: { employeeId: { in: ids } } });
      await app.prisma.absence.deleteMany({ where: { employeeId: { in: ids } } });
      await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: { in: ids } } });
      await app.prisma.auditLog.deleteMany({
        where: { OR: [{ entity: "WorkEvent" }, { entity: "Absence" }] },
      });
      await app.prisma.workSchedule.deleteMany({ where: { employeeId: { in: ids } } });
      await app.prisma.employee.deleteMany({ where: { id: { in: ids } } });
      await app.prisma.refreshToken.deleteMany({
        where: { userId: { in: [azubiUserId, vollzeitUserId, partTimeUserId, monthlyUserId] } },
      });
      await app.prisma.user.deleteMany({
        where: { id: { in: [azubiUserId, vollzeitUserId, partTimeUserId, monthlyUserId] } },
      });
      // Reset flag for next runs.
      await app.prisma.tenantConfig.update({
        where: { tenantId: data.tenant.id },
        data: { workEventModelLive: false },
      });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("vs-bc routing cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    const ids = [azubiEmpId, vollzeitEmpId, partTimeEmpId, monthlyEmpId];
    await app.prisma.workEvent.deleteMany({ where: { employeeId: { in: ids } } });
    await app.prisma.absence.deleteMany({ where: { employeeId: { in: ids } } });
    await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: { in: ids } } });
    await app.prisma.auditLog.deleteMany({
      where: { OR: [{ entity: "WorkEvent" }, { entity: "Absence" }] },
    });
    // Default flag back to false; tests opt in by flipping it.
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { workEventModelLive: false },
    });
    // WR-02: invalidate the tenant-flag cache so the next request observes the
    // reset (or any per-test flip below).
    invalidateTenantWorkEventModelLiveCache(data.tenant.id);
  });

  // ── Default-flag-off (legacy path preserved) ──────────────────────────────

  it("R1: workEventModelLive=false → POST /manual-insert writes to Absence (NOT WorkEvent)", async () => {
    const today = utcMidnightToday();
    const date = fmtDate(offsetDays(today, 14));
    const dateUtc = new Date(date + "T00:00:00.000Z");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: azubiEmpId, date },
    });
    expect(res.statusCode).toBe(201);

    const abs = await app.prisma.absence.findFirst({
      where: { employeeId: azubiEmpId, type: AbsenceType.VOCATIONAL_SCHOOL, startDate: dateUtc },
    });
    expect(abs).not.toBeNull();
    const we = await app.prisma.workEvent.findFirst({
      where: { employeeId: azubiEmpId, type: WorkEventType.VOCATIONAL_SCHOOL, date: dateUtc },
    });
    expect(we).toBeNull();
  });

  it("R2: workEventModelLive=false → GET /upcoming returns Absence rows", async () => {
    const today = utcMidnightToday();
    const inWindow = offsetDays(today, 7);
    await app.prisma.absence.create({
      data: {
        employeeId: azubiEmpId,
        type: AbsenceType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        startDate: inWindow,
        endDate: inWindow,
        days: 1.0,
        createdBy: data.adminUser.id,
      },
    });

    const from = fmtDate(today);
    const to = fmtDate(offsetDays(today, 30));
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/vocational-school/upcoming?from=${from}&to=${to}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].employeeId).toBe(azubiEmpId);
    expect(body[0].date).toBe(fmtDate(inWindow));
  });

  // ── Flag-on (new path) ────────────────────────────────────────────────────

  it("R3: workEventModelLive=true → POST /manual-insert writes to WorkEvent (NOT Absence)", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { workEventModelLive: true },
    });
    // WR-02: invalidate the cached tenant flag so the next request observes the flip.
    invalidateTenantWorkEventModelLiveCache(data.tenant.id);
    const today = utcMidnightToday();
    const date = fmtDate(offsetDays(today, 14));
    const dateUtc = new Date(date + "T00:00:00.000Z");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: azubiEmpId, date },
    });
    expect(res.statusCode).toBe(201);

    const we = await app.prisma.workEvent.findFirst({
      where: { employeeId: azubiEmpId, type: WorkEventType.VOCATIONAL_SCHOOL, date: dateUtc },
    });
    expect(we).not.toBeNull();
    const abs = await app.prisma.absence.findFirst({
      where: { employeeId: azubiEmpId, type: AbsenceType.VOCATIONAL_SCHOOL, startDate: dateUtc },
    });
    expect(abs).toBeNull();
  });

  it("R4: workEventModelLive=true + VOLLZEIT → 400 with German message", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { workEventModelLive: true },
    });
    // WR-02: invalidate the cached tenant flag so the next request observes the flip.
    invalidateTenantWorkEventModelLiveCache(data.tenant.id);
    const today = utcMidnightToday();
    const date = fmtDate(offsetDays(today, 14));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: vollzeitEmpId, date },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("Berufsschule ist nur für Azubis zulässig");
  });

  it("R5: workEventModelLive=true + locked month → 403 (B2 — body.date string passed to assertMonthNotLocked)", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { workEventModelLive: true },
    });
    // WR-02: invalidate the cached tenant flag so the next request observes the flip.
    invalidateTenantWorkEventModelLiveCache(data.tenant.id);
    const today = utcMidnightToday();
    const date = fmtDate(offsetDays(today, 14));
    const dateUtc = new Date(date + "T00:00:00.000Z");
    // Use monthRangeUtc to compute Europe/Berlin month boundaries — assertMonthNotLocked
    // (Plan 79-01) does the same lookup. UTC midnight would NOT match because Berlin's
    // CEST = UTC+2 shifts the snapshot's periodStart by 2 hours.
    const { start: monthStart, end: monthEnd } = monthRangeUtc(
      dateUtc.getUTCFullYear(),
      dateUtc.getUTCMonth() + 1,
      "Europe/Berlin",
    );
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: azubiEmpId,
        periodType: "MONTHLY",
        periodStart: monthStart,
        periodEnd: monthEnd,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
        closedBy: data.adminUser.id,
        superseded: false,
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: azubiEmpId, date },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe(
      "Monat ist abgeschlossen und kann nicht bearbeitet werden",
    );
  });

  it("R6: workEventModelLive=true + duplicate (employeeId, date, VOCATIONAL_SCHOOL) → 409", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { workEventModelLive: true },
    });
    // WR-02: invalidate the cached tenant flag so the next request observes the flip.
    invalidateTenantWorkEventModelLiveCache(data.tenant.id);
    const today = utcMidnightToday();
    const date = fmtDate(offsetDays(today, 14));
    // First insert wins.
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: azubiEmpId, date },
    });
    expect(first.statusCode).toBe(201);
    // Second collides on @@unique([employeeId, date, type]).
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: azubiEmpId, date },
    });
    expect(second.statusCode).toBe(409);
  });

  it("R7: workEventModelLive=true → GET /upcoming returns WorkEvent rows in legacy response shape", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { workEventModelLive: true },
    });
    // WR-02: invalidate the cached tenant flag so the next request observes the flip.
    invalidateTenantWorkEventModelLiveCache(data.tenant.id);
    const today = utcMidnightToday();
    const inWindow = offsetDays(today, 7);
    await app.prisma.workEvent.create({
      data: {
        employeeId: azubiEmpId,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        date: inWindow,
        workedMinutes: 480,
        expectedMinutes: 480,
        createdBy: data.adminUser.id,
      },
    });
    const from = fmtDate(today);
    const to = fmtDate(offsetDays(today, 30));
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/vocational-school/upcoming?from=${from}&to=${to}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0]).toHaveProperty("id");
    expect(body[0].employeeId).toBe(azubiEmpId);
    expect(body[0].date).toBe(fmtDate(inWindow));
    expect(body[0]).toHaveProperty("source");
    expect(body[0]).toHaveProperty("employee");
    expect(body[0].employee).toHaveProperty("firstName");
    expect(body[0].employee).toHaveProperty("lastName");
    expect(body[0].employee).toHaveProperty("employeeNumber");
  });

  it("R8: workEventModelLive=true → POST writes WORK_EVENT_CREATED AuditLog", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { workEventModelLive: true },
    });
    // WR-02: invalidate the cached tenant flag so the next request observes the flip.
    invalidateTenantWorkEventModelLiveCache(data.tenant.id);
    const today = utcMidnightToday();
    const date = fmtDate(offsetDays(today, 14));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: azubiEmpId, date },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);

    const audit = await app.prisma.auditLog.findFirst({
      where: { entityId: body.id, action: "WORK_EVENT_CREATED" },
    });
    expect(audit).not.toBeNull();
  });

  // Phase 78 D-08 adapter parity invariant — workedMinutes MUST come from WorkSchedule.
  // CR-01 (Phase 79 review): expectedMinutes MUST be NULL for MONTHLY_HOURS and
  // equal workedMinutes for non-MONTHLY schedules. Matches aggregateLegacyAbsences
  // semantics (utils/work-event.ts:375 — only ADDs expected-side when scheduleType
  // !== MONTHLY_HOURS) so the saldo adapter sees identical totals across flag flip.
  it("R10 (REVISION B3 + CR-01 — Phase 78 D-08): live-branch workedMinutes = scheduleHoursForWeekday × 60; expectedMinutes honors schedule type", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { workEventModelLive: true },
    });
    // WR-02: invalidate the cached tenant flag so the next request observes the flip.
    invalidateTenantWorkEventModelLiveCache(data.tenant.id);

    // Anchor on a Monday so the FIXED_SCHEDULE mondayHours field is the source. We pick the
    // next Monday in the future so the locked-month gate cannot interfere.
    const today = utcMidnightToday();
    const monday = nextWeekday(offsetDays(today, 7), 1); // 1 = Monday

    // (a) FIXED_SCHEDULE 8h Monday → workedMinutes=480, expectedMinutes=480 (non-MONTHLY).
    const r1 = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: azubiEmpId, date: fmtDate(monday) },
    });
    expect(r1.statusCode).toBe(201);
    const we1 = await app.prisma.workEvent.findFirst({
      where: { employeeId: azubiEmpId, type: WorkEventType.VOCATIONAL_SCHOOL, date: monday },
    });
    expect(we1?.workedMinutes).toBe(480);
    // CR-01: expectedMinutes equals workedMinutes for FIXED_SCHEDULE.
    expect(we1?.expectedMinutes).toBe(480);

    // (b) Part-time 4h Monday → workedMinutes=240, expectedMinutes=240 (non-MONTHLY).
    const r2 = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: partTimeEmpId, date: fmtDate(monday) },
    });
    expect(r2.statusCode).toBe(201);
    const we2 = await app.prisma.workEvent.findFirst({
      where: { employeeId: partTimeEmpId, type: WorkEventType.VOCATIONAL_SCHOOL, date: monday },
    });
    expect(we2?.workedMinutes).toBe(240);
    // CR-01: expectedMinutes equals workedMinutes for FIXED_SCHEDULE part-time.
    expect(we2?.expectedMinutes).toBe(240);

    // (c) MONTHLY_HOURS → pauschal workedMinutes=480; expectedMinutes=NULL (Phase 63 D-04).
    const r3 = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: monthlyEmpId, date: fmtDate(monday) },
    });
    expect(r3.statusCode).toBe(201);
    const we3 = await app.prisma.workEvent.findFirst({
      where: { employeeId: monthlyEmpId, type: WorkEventType.VOCATIONAL_SCHOOL, date: monday },
    });
    expect(we3?.workedMinutes).toBe(480);
    // CR-01: expectedMinutes MUST be NULL for MONTHLY_HOURS — matches Phase 63 D-04
    // and aggregateLegacyAbsences (which skips expected-side add for MONTHLY_HOURS).
    // Without this, BC-proxy live branch would contribute 480 to Soll while the
    // legacy Absence branch contributes 0 for the same scenario.
    expect(we3?.expectedMinutes).toBeNull();
  });

  // REVISION B6 — dual AuditLog: WORK_EVENT_CREATED primary + VIA_BC_PROXY breadcrumb.
  it("R11 (REVISION B6 — dual / breadcrumb AuditLog): live POST writes BOTH WORK_EVENT_CREATED and VOCATIONAL_SCHOOL_MANUAL_INSERTED_VIA_BC_PROXY rows", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { workEventModelLive: true },
    });
    // WR-02: invalidate the cached tenant flag so the next request observes the flip.
    invalidateTenantWorkEventModelLiveCache(data.tenant.id);
    const today = utcMidnightToday();
    const date = fmtDate(offsetDays(today, 14));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: azubiEmpId, date },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);

    const rows = await app.prisma.auditLog.findMany({
      where: { entityId: body.id },
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    const actions = rows.map((r) => r.action).sort();
    expect(actions).toEqual(
      ["VOCATIONAL_SCHOOL_MANUAL_INSERTED_VIA_BC_PROXY", "WORK_EVENT_CREATED"].sort(),
    );
    // Both rows MUST reference the same entityId (the new WorkEvent.id).
    expect(rows.every((r) => r.entityId === body.id)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DR1-DR8 — DELETE routing (flag-aware + fall-through + edge cases)
// ─────────────────────────────────────────────────────────────────────────────
describe("BC proxy DELETE routing (Plan 79-04 Task 3 — DR1-DR8)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let otherData: Awaited<ReturnType<typeof seedTestData>>;
  let azubiEmpId: string;
  let azubiUserId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "vs-bc-del");
    otherData = await seedTestData(app, "vs-bc-del-other");

    const u = await app.prisma.user.create({
      data: {
        email: `vs-bc-del-az-${Date.now()}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    azubiUserId = u.id;
    const e = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: u.id,
        employeeNumber: `VS-DEL-AZ-${Date.now()}`,
        firstName: "Azubi",
        lastName: "VSDel",
        hireDate: new Date("2024-01-01"),
        classification: EmployeeClassification.AZUBI,
      },
    });
    azubiEmpId = e.id;
    await app.prisma.workSchedule.create({
      data: {
        employeeId: e.id,
        type: ScheduleType.FIXED_SCHEDULE,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });
  });

  afterAll(async () => {
    try {
      await app.prisma.workEvent.deleteMany({ where: { employeeId: azubiEmpId } });
      await app.prisma.absence.deleteMany({ where: { employeeId: azubiEmpId } });
      await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: azubiEmpId } });
      await app.prisma.auditLog.deleteMany({
        where: { OR: [{ entity: "WorkEvent" }, { entity: "Absence" }] },
      });
      await app.prisma.workSchedule.deleteMany({ where: { employeeId: azubiEmpId } });
      await app.prisma.employee.deleteMany({ where: { id: azubiEmpId } });
      await app.prisma.refreshToken.deleteMany({ where: { userId: azubiUserId } });
      await app.prisma.user.deleteMany({ where: { id: azubiUserId } });
      await app.prisma.tenantConfig.update({
        where: { tenantId: data.tenant.id },
        data: { workEventModelLive: false },
      });
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, otherData.tenant.id);
    } catch (err) {
      console.error("vs-bc DELETE cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    await app.prisma.workEvent.deleteMany({ where: { employeeId: azubiEmpId } });
    await app.prisma.absence.deleteMany({ where: { employeeId: azubiEmpId } });
    await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: azubiEmpId } });
    await app.prisma.auditLog.deleteMany({
      where: { OR: [{ entity: "WorkEvent" }, { entity: "Absence" }] },
    });
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { workEventModelLive: false },
    });
    // WR-02: invalidate the cached tenant flag so the next request observes the
    // reset (or any per-test flip below).
    invalidateTenantWorkEventModelLiveCache(data.tenant.id);
  });

  it("DR1: flag=false → DELETE soft-deletes Absence (legacy)", async () => {
    const today = utcMidnightToday();
    const d = offsetDays(today, 14);
    const ab = await app.prisma.absence.create({
      data: {
        employeeId: azubiEmpId,
        type: AbsenceType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        startDate: d,
        endDate: d,
        days: 1.0,
        createdBy: data.adminUser.id,
      },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/vocational-school/${ab.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(204);
    const row = await app.prisma.absence.findUnique({ where: { id: ab.id } });
    expect(row?.deletedAt).not.toBeNull();
  });

  it("DR2: flag=true → DELETE soft-deletes WorkEvent + writes WORK_EVENT_DELETED audit", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { workEventModelLive: true },
    });
    // WR-02: invalidate the cached tenant flag so the next request observes the flip.
    invalidateTenantWorkEventModelLiveCache(data.tenant.id);
    const today = utcMidnightToday();
    const d = offsetDays(today, 14);
    const we = await app.prisma.workEvent.create({
      data: {
        employeeId: azubiEmpId,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        date: d,
        workedMinutes: 480,
        expectedMinutes: 480,
        createdBy: data.adminUser.id,
      },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/vocational-school/${we.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(204);
    const row = await app.prisma.workEvent.findUnique({ where: { id: we.id } });
    expect(row?.deletedAt).not.toBeNull();
    const audit = await app.prisma.auditLog.findFirst({
      where: { entityId: we.id, action: "WORK_EVENT_DELETED" },
    });
    expect(audit).not.toBeNull();
  });

  it("DR3: flag=true + id BELONGS to Absence row → falls through to Absence, 204 + soft delete (grace window)", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { workEventModelLive: true },
    });
    // WR-02: invalidate the cached tenant flag so the next request observes the flip.
    invalidateTenantWorkEventModelLiveCache(data.tenant.id);
    const today = utcMidnightToday();
    const d = offsetDays(today, 14);
    const ab = await app.prisma.absence.create({
      data: {
        employeeId: azubiEmpId,
        type: AbsenceType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        startDate: d,
        endDate: d,
        days: 1.0,
        createdBy: data.adminUser.id,
      },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/vocational-school/${ab.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(204);
    const row = await app.prisma.absence.findUnique({ where: { id: ab.id } });
    expect(row?.deletedAt).not.toBeNull();
  });

  it("DR4: flag=true + nonexistent id → 404", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { workEventModelLive: true },
    });
    // WR-02: invalidate the cached tenant flag so the next request observes the flip.
    invalidateTenantWorkEventModelLiveCache(data.tenant.id);
    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/vocational-school/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("DR5: flag=true + tenant isolation (id from other tenant) → 404", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { workEventModelLive: true },
    });
    // WR-02: invalidate the cached tenant flag so the next request observes the flip.
    invalidateTenantWorkEventModelLiveCache(data.tenant.id);
    const today = utcMidnightToday();
    const d = offsetDays(today, 14);
    const otherEmp = otherData.employee;
    const ab = await app.prisma.absence.create({
      data: {
        employeeId: otherEmp.id,
        type: AbsenceType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        startDate: d,
        endDate: d,
        days: 1.0,
        createdBy: otherData.adminUser.id,
      },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/vocational-school/${ab.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(404);
    // Cleanup the cross-tenant Absence we just created.
    await app.prisma.absence.delete({ where: { id: ab.id } });
  });

  it("DR6 (REVISION B2): flag=true + locked month → 403 (existing WE date passed as YYYY-MM-DD string)", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { workEventModelLive: true },
    });
    // WR-02: invalidate the cached tenant flag so the next request observes the flip.
    invalidateTenantWorkEventModelLiveCache(data.tenant.id);
    const today = utcMidnightToday();
    const d = offsetDays(today, 14);
    const we = await app.prisma.workEvent.create({
      data: {
        employeeId: azubiEmpId,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        date: d,
        workedMinutes: 480,
        expectedMinutes: 480,
        createdBy: data.adminUser.id,
      },
    });
    // Seed locked-month snapshot. Use monthRangeUtc so the periodStart matches what
    // assertMonthNotLocked computes via Europe/Berlin (Plan 79-01 helper signature).
    const { start: monthStart, end: monthEnd } = monthRangeUtc(
      d.getUTCFullYear(),
      d.getUTCMonth() + 1,
      "Europe/Berlin",
    );
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: azubiEmpId,
        periodType: "MONTHLY",
        periodStart: monthStart,
        periodEnd: monthEnd,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
        closedBy: data.adminUser.id,
        superseded: false,
      },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/vocational-school/${we.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // REVISION W3 — soft-deleted WorkEvent id MUST fall through to Absence (which also won't find it) → 404.
  it("DR7 (REVISION W3 — soft-deleted WorkEvent id): flag=true + WorkEvent.deletedAt!=null → 404 (fall-through doesn't resurrect deleted rows)", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { workEventModelLive: true },
    });
    // WR-02: invalidate the cached tenant flag so the next request observes the flip.
    invalidateTenantWorkEventModelLiveCache(data.tenant.id);
    const today = utcMidnightToday();
    const d = offsetDays(today, 14);
    const we = await app.prisma.workEvent.create({
      data: {
        employeeId: azubiEmpId,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        date: d,
        workedMinutes: 480,
        expectedMinutes: 480,
        createdBy: data.adminUser.id,
        deletedAt: new Date(),
      },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/vocational-school/${we.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // REVISION W3 — Absence id of type SICK MUST be rejected by the legacy type guard during fall-through.
  it("DR8 (REVISION W3 — SICK absence id): flag=true + Absence of type SICK → 400 'Eintrag ist kein Berufsschultag'", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { workEventModelLive: true },
    });
    // WR-02: invalidate the cached tenant flag so the next request observes the flip.
    invalidateTenantWorkEventModelLiveCache(data.tenant.id);
    const today = utcMidnightToday();
    const d = offsetDays(today, 14);
    const ab = await app.prisma.absence.create({
      data: {
        employeeId: azubiEmpId,
        type: AbsenceType.SICK,
        source: "MANUAL",
        startDate: d,
        endDate: d,
        days: 1.0,
        createdBy: data.adminUser.id,
      },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/vocational-school/${ab.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("Eintrag ist kein Berufsschultag.");
  });
});
