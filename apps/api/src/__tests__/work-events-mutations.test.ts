// Phase 79 Plan 03 — POST / PATCH / DELETE /api/v1/work-events integration tests.
//
// Plan reference: .planning/phases/79-workevent-api-endpoints-split-mine-vs-management/79-03-PLAN.md
//
// Covers every gate the mutation handlers enforce (CONTEXT D):
//   1. Zod parse + discriminated-union payload validation
//   2. Cross-tenant employee lookup → 404 (not 403; avoids existence leak)
//   3. AZUBI / classification gate (data-driven via workEventTypeRules) — the
//      headline data-driven proof is Test P5: flip employee.classification from
//      VOLLZEIT → AZUBI and the same POST starts succeeding without code change.
//   4. Locked-month gate via assertMonthNotLocked
//   5. P2002 → HTTP 409 on @@unique([employeeId, date, type])
//   6. AuditLog WORK_EVENT_CREATED / UPDATED / DELETED rows
//
// REVISION (B1): Test P13 + U10 explicitly POST/PATCH a PATTERN-source row to
// prove the Zod schema accepts the full {PATTERN, MANUAL, AUTO} domain.
//
// REVISION (B2): the locked-month gate receives YYYY-MM-DD strings — proven
// indirectly via Test P7 / U4 / D3 (a snapshot for the row's month → 403).
//
// REVISION (B5): zero `code(501)` literals must remain in work-events.ts after
// this plan; the structural acceptance check is in the plan, not the test.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import {
  WorkEventType,
  WorkEventSource,
  EmployeeClassification,
  type SaldoSnapshot,
} from "@clokr/db";
import { monthRangeUtc } from "../utils/timezone";

// Format a Date as YYYY-MM-DD using UTC components (matches the @db.Date column).
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

const LOCKED_MONTH_ERROR_DE = "Monat ist abgeschlossen und kann nicht bearbeitet werden";
const CLASSIFICATION_NOT_ALLOWED_DE = "Berufsschule ist nur für Azubis zulässig";
const DUPLICATE_WORK_EVENT_DE = "Eintrag existiert bereits für diesen Tag und Typ.";
const EMPLOYEE_NOT_FOUND_DE = "Mitarbeiter nicht gefunden";
const TYPE_IMMUTABLE_DE =
  "Typ kann nicht geändert werden. Bitte alten Eintrag löschen und neuen anlegen.";
const WORK_EVENT_NOT_FOUND_DE = "WorkEvent nicht gefunden";

// ── Shared test helper: seed a non-superseded SaldoSnapshot for the row's month ──
async function seedLockedSnapshot(
  app: FastifyInstance,
  employeeId: string,
  closedBy: string,
  year: number,
  month: number,
  opts: { superseded?: boolean } = {},
): Promise<SaldoSnapshot> {
  const { start, end } = monthRangeUtc(year, month, "Europe/Berlin");
  return app.prisma.saldoSnapshot.create({
    data: {
      employeeId,
      periodType: "MONTHLY",
      periodStart: start,
      periodEnd: end,
      workedMinutes: 0,
      expectedMinutes: 0,
      balanceMinutes: 0,
      carryOver: 0,
      closedAt: new Date(),
      closedBy,
      superseded: opts.superseded ?? false,
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// POST /api/v1/work-events
// ───────────────────────────────────────────────────────────────────────────────
describe("POST /api/v1/work-events (Plan 79-03 Task 1)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let dataTenantB: Awaited<ReturnType<typeof seedTestData>>;

  // AZUBI employee (tenant A) — the only classification that accepts VOCATIONAL_SCHOOL.
  let azubiEmpId: string;
  let azubiUserId: string;
  // VOLLZEIT employee (tenant A) — used for the AZUBI gate negative test.
  let vollzeitEmpId: string;
  let vollzeitUserId: string;
  // Toggle target for Test P5 — same row's classification flips VOLLZEIT → AZUBI.
  let toggleEmpId: string;
  let toggleUserId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "we-mut-a");
    dataTenantB = await seedTestData(app, "we-mut-b");

    // AZUBI in tenant A.
    const azubiUser = await app.prisma.user.create({
      data: {
        email: `azubi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    azubiUserId = azubiUser.id;
    const azubiEmp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: azubiUser.id,
        employeeNumber: `AZ-${Date.now()}`,
        firstName: "Azubi",
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
        classification: EmployeeClassification.AZUBI,
      },
    });
    azubiEmpId = azubiEmp.id;

    // VOLLZEIT in tenant A.
    const vollzeitUser = await app.prisma.user.create({
      data: {
        email: `vollzeit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    vollzeitUserId = vollzeitUser.id;
    const vollzeitEmp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: vollzeitUser.id,
        employeeNumber: `VZ-${Date.now()}`,
        firstName: "Vollzeit",
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
        classification: EmployeeClassification.VOLLZEIT,
      },
    });
    vollzeitEmpId = vollzeitEmp.id;

    // Toggle target for Test P5 — starts VOLLZEIT.
    const toggleUser = await app.prisma.user.create({
      data: {
        email: `toggle-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    toggleUserId = toggleUser.id;
    const toggleEmp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: toggleUser.id,
        employeeNumber: `TG-${Date.now()}`,
        firstName: "Toggle",
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
        classification: EmployeeClassification.VOLLZEIT,
      },
    });
    toggleEmpId = toggleEmp.id;
  });

  afterAll(async () => {
    try {
      const allEmpIds = [
        data.adminEmployee.id,
        data.employee.id,
        azubiEmpId,
        vollzeitEmpId,
        toggleEmpId,
        dataTenantB.adminEmployee.id,
        dataTenantB.employee.id,
      ];
      await app.prisma.workEvent.deleteMany({ where: { employeeId: { in: allEmpIds } } });
      await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: { in: allEmpIds } } });
      await app.prisma.auditLog.deleteMany({
        where: { entity: "WorkEvent" },
      });
      await app.prisma.employee.deleteMany({
        where: { id: { in: [azubiEmpId, vollzeitEmpId, toggleEmpId] } },
      });
      await app.prisma.refreshToken.deleteMany({
        where: { userId: { in: [azubiUserId, vollzeitUserId, toggleUserId] } },
      });
      await app.prisma.user.deleteMany({
        where: { id: { in: [azubiUserId, vollzeitUserId, toggleUserId] } },
      });
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, dataTenantB.tenant.id);
    } catch (err) {
      console.error("work-events-mutations POST cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    const allEmpIds = [
      data.adminEmployee.id,
      data.employee.id,
      azubiEmpId,
      vollzeitEmpId,
      toggleEmpId,
      dataTenantB.adminEmployee.id,
      dataTenantB.employee.id,
    ];
    await app.prisma.workEvent.deleteMany({ where: { employeeId: { in: allEmpIds } } });
    await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: { in: allEmpIds } } });
    await app.prisma.auditLog.deleteMany({ where: { entity: "WorkEvent" } });
    // Reset toggle classification back to VOLLZEIT in case a previous test flipped it.
    await app.prisma.employee.update({
      where: { id: toggleEmpId },
      data: { classification: EmployeeClassification.VOLLZEIT },
    });
  });

  // ── Test P1 (happy path) ───────────────────────────────────────────────────
  it("P1: ADMIN POSTs a valid VOCATIONAL_SCHOOL for an AZUBI → 201 + DB row", async () => {
    const today = utcMidnightToday();
    const date = fmtDate(offsetDays(today, 14));

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: azubiEmpId,
        date,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBeTruthy();

    const row = await app.prisma.workEvent.findUnique({ where: { id: body.id } });
    expect(row).not.toBeNull();
    expect(row?.employeeId).toBe(azubiEmpId);
    expect(row?.type).toBe(WorkEventType.VOCATIONAL_SCHOOL);
  });

  // ── Test P2 (Zod — missing employeeId) ─────────────────────────────────────
  it("P2: POST missing employeeId → 400", async () => {
    const today = utcMidnightToday();
    const date = fmtDate(offsetDays(today, 7));

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        date,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        workedMinutes: 480,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Test P3 (Zod — payload discriminator mismatch) ─────────────────────────
  it("P3: POST with payload.type !== body.type → 400", async () => {
    const today = utcMidnightToday();
    const date = fmtDate(offsetDays(today, 7));

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: azubiEmpId,
        date,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        workedMinutes: 480,
        payload: { type: WorkEventType.OTHER },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Test P4 (tenant isolation) ─────────────────────────────────────────────
  it("P4: ADMIN of tenant A posts for employee in tenant B → 404", async () => {
    const today = utcMidnightToday();
    const date = fmtDate(offsetDays(today, 7));

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: dataTenantB.employee.id, // foreign tenant
        date,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        workedMinutes: 480,
      },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe(EMPLOYEE_NOT_FOUND_DE);
  });

  // ── Test P5 (DATA-driven AZUBI gate — classification toggle) ──────────────
  // Headline: the AZUBI gate is enforced as data-driven via workEventTypeRules,
  // NOT as a hardcoded if-statement. Flipping employee.classification VOLLZEIT
  // → AZUBI changes the verdict for the IDENTICAL POST — no code change.
  it("P5: VOLLZEIT → 400 'Berufsschule ist nur für Azubis zulässig'; then flip to AZUBI → 201 (data-driven gate proof)", async () => {
    const today = utcMidnightToday();
    const date = fmtDate(offsetDays(today, 21));

    // Round 1: VOLLZEIT → 400 + exact German message.
    const res1 = await app.inject({
      method: "POST",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: toggleEmpId,
        date,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        workedMinutes: 480,
      },
    });
    expect(res1.statusCode).toBe(400);
    expect(JSON.parse(res1.body).error).toBe(CLASSIFICATION_NOT_ALLOWED_DE);

    // Flip classification — pure DATA change, no code change.
    await app.prisma.employee.update({
      where: { id: toggleEmpId },
      data: { classification: EmployeeClassification.AZUBI },
    });

    // Round 2: IDENTICAL POST → 201 because the rule table now permits AZUBI.
    const res2 = await app.inject({
      method: "POST",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: toggleEmpId,
        date,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        workedMinutes: 480,
      },
    });
    expect(res2.statusCode).toBe(201);
  });

  // ── Test P6 (reserved type passes for any classification) ─────────────────
  it("P6: ADMIN posts FIELD_SERVICE for VOLLZEIT → 201 (reserved-type placeholder)", async () => {
    const today = utcMidnightToday();
    const date = fmtDate(offsetDays(today, 9));

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: vollzeitEmpId,
        date,
        type: WorkEventType.FIELD_SERVICE,
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });
    expect(res.statusCode).toBe(201);
  });

  // ── Test P7 (locked-month gate) ────────────────────────────────────────────
  it("P7: snapshot exists for target month → 403 with German message", async () => {
    const today = utcMidnightToday();
    // Target a date well in the future to avoid the default-window confusing things.
    const target = offsetDays(today, 35);
    const targetStr = fmtDate(target);
    const year = target.getUTCFullYear();
    const month = target.getUTCMonth() + 1;

    await seedLockedSnapshot(app, azubiEmpId, data.adminEmployee.id, year, month);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: azubiEmpId,
        date: targetStr,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        workedMinutes: 480,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe(LOCKED_MONTH_ERROR_DE);
  });

  // ── Test P8 (superseded snapshot does NOT lock) ────────────────────────────
  it("P8: superseded snapshot for target month → 201 (does NOT lock)", async () => {
    const today = utcMidnightToday();
    const target = offsetDays(today, 42);
    const targetStr = fmtDate(target);
    const year = target.getUTCFullYear();
    const month = target.getUTCMonth() + 1;

    await seedLockedSnapshot(app, azubiEmpId, data.adminEmployee.id, year, month, {
      superseded: true,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: azubiEmpId,
        date: targetStr,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        workedMinutes: 480,
      },
    });
    expect(res.statusCode).toBe(201);
  });

  // ── Test P9 (P2002 dedupe) ─────────────────────────────────────────────────
  it("P9: duplicate (employeeId, date, type) → 409 with German message", async () => {
    const today = utcMidnightToday();
    const date = fmtDate(offsetDays(today, 11));

    // Seed the first row.
    await app.prisma.workEvent.create({
      data: {
        employeeId: azubiEmpId,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: WorkEventSource.MANUAL,
        date: new Date(date + "T00:00:00.000Z"),
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });

    // POST the same triple again.
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: azubiEmpId,
        date,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        workedMinutes: 480,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe(DUPLICATE_WORK_EVENT_DE);
  });

  // ── Test P10 (AuditLog) ────────────────────────────────────────────────────
  it("P10: successful POST writes exactly 1 AuditLog row WORK_EVENT_CREATED", async () => {
    const today = utcMidnightToday();
    const date = fmtDate(offsetDays(today, 13));

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: azubiEmpId,
        date,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        workedMinutes: 480,
      },
    });
    expect(res.statusCode).toBe(201);
    const created = JSON.parse(res.body);

    const audits = await app.prisma.auditLog.findMany({
      where: {
        action: "WORK_EVENT_CREATED",
        entity: "WorkEvent",
        entityId: created.id,
      },
    });
    expect(audits.length).toBe(1);
    expect(audits[0].userId).toBe(data.adminUser.id);
    const newValue = audits[0].newValue as Record<string, unknown>;
    expect(newValue.employeeId).toBe(azubiEmpId);
    expect(newValue.date).toBe(date);
    expect(newValue.type).toBe(WorkEventType.VOCATIONAL_SCHOOL);
  });

  // ── Test P11 (EMPLOYEE forbidden) ──────────────────────────────────────────
  it("P11: EMPLOYEE-role POST → 403", async () => {
    const today = utcMidnightToday();
    const date = fmtDate(offsetDays(today, 7));

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: {
        employeeId: azubiEmpId,
        date,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        workedMinutes: 480,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── Test P12 (explicit workedMinutes + expectedMinutes persisted) ──────────
  it("P12: explicit workedMinutes + expectedMinutes persisted", async () => {
    const today = utcMidnightToday();
    const date = fmtDate(offsetDays(today, 19));

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: azubiEmpId,
        date,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);

    const row = await app.prisma.workEvent.findUnique({ where: { id: body.id } });
    expect(row?.workedMinutes).toBe(480);
    expect(row?.expectedMinutes).toBe(480);
  });

  // ── Test P13 (REVISION B1 — PATTERN source accepted; BOGUS rejected) ──────
  it("P13: POST with source=PATTERN → 201; source=BOGUS → 400 (REVISION B1 closed Prisma-enum domain)", async () => {
    const today = utcMidnightToday();
    const date = fmtDate(offsetDays(today, 17));

    // Round 1: PATTERN is in the Prisma enum domain → must be accepted.
    const res1 = await app.inject({
      method: "POST",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: azubiEmpId,
        date,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: WorkEventSource.PATTERN,
        workedMinutes: 480,
      },
    });
    expect(res1.statusCode).toBe(201);
    const created = JSON.parse(res1.body);
    const row = await app.prisma.workEvent.findUnique({ where: { id: created.id } });
    expect(row?.source).toBe(WorkEventSource.PATTERN);

    // Round 2: BOGUS is NOT in the enum → 400 (proves closed domain).
    const date2 = fmtDate(offsetDays(today, 23));
    const res2 = await app.inject({
      method: "POST",
      url: "/api/v1/work-events",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: azubiEmpId,
        date: date2,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: "BOGUS",
        workedMinutes: 480,
      },
    });
    expect(res2.statusCode).toBe(400);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// PATCH /api/v1/work-events/:id
// ───────────────────────────────────────────────────────────────────────────────
describe("PATCH /api/v1/work-events/:id (Plan 79-03 Task 2)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let dataTenantB: Awaited<ReturnType<typeof seedTestData>>;

  let azubiEmpId: string;
  let azubiUserId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "we-mut-patch-a");
    dataTenantB = await seedTestData(app, "we-mut-patch-b");

    const azubiUser = await app.prisma.user.create({
      data: {
        email: `azubi-patch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    azubiUserId = azubiUser.id;
    const azubiEmp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: azubiUser.id,
        employeeNumber: `AZ-PATCH-${Date.now()}`,
        firstName: "Azubi",
        lastName: "Patch",
        hireDate: new Date("2024-01-01"),
        classification: EmployeeClassification.AZUBI,
      },
    });
    azubiEmpId = azubiEmp.id;
  });

  afterAll(async () => {
    try {
      const allEmpIds = [
        data.adminEmployee.id,
        data.employee.id,
        azubiEmpId,
        dataTenantB.adminEmployee.id,
        dataTenantB.employee.id,
      ];
      await app.prisma.workEvent.deleteMany({ where: { employeeId: { in: allEmpIds } } });
      await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: { in: allEmpIds } } });
      await app.prisma.auditLog.deleteMany({ where: { entity: "WorkEvent" } });
      await app.prisma.employee.deleteMany({ where: { id: { in: [azubiEmpId] } } });
      await app.prisma.refreshToken.deleteMany({ where: { userId: { in: [azubiUserId] } } });
      await app.prisma.user.deleteMany({ where: { id: { in: [azubiUserId] } } });
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, dataTenantB.tenant.id);
    } catch (err) {
      console.error("work-events-mutations PATCH cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    const allEmpIds = [
      data.adminEmployee.id,
      data.employee.id,
      azubiEmpId,
      dataTenantB.adminEmployee.id,
      dataTenantB.employee.id,
    ];
    await app.prisma.workEvent.deleteMany({ where: { employeeId: { in: allEmpIds } } });
    await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: { in: allEmpIds } } });
    await app.prisma.auditLog.deleteMany({ where: { entity: "WorkEvent" } });
  });

  async function seedRow(
    opts: {
      employeeId?: string;
      date?: Date;
      type?: WorkEventType;
      source?: WorkEventSource;
    } = {},
  ) {
    const today = utcMidnightToday();
    const date = opts.date ?? offsetDays(today, 14);
    return app.prisma.workEvent.create({
      data: {
        employeeId: opts.employeeId ?? azubiEmpId,
        type: opts.type ?? WorkEventType.VOCATIONAL_SCHOOL,
        source: opts.source ?? WorkEventSource.MANUAL,
        date,
        workedMinutes: 480,
        expectedMinutes: 480,
        note: "initial",
      },
    });
  }

  // ── Test U1 (happy path) ───────────────────────────────────────────────────
  it("U1: ADMIN PATCH note + workedMinutes → 200 + DB updated", async () => {
    const row = await seedRow();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/work-events/${row.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { note: "updated", workedMinutes: 360 },
    });
    expect(res.statusCode).toBe(200);

    const updated = await app.prisma.workEvent.findUnique({ where: { id: row.id } });
    expect(updated?.note).toBe("updated");
    expect(updated?.workedMinutes).toBe(360);
  });

  // ── Test U2 (immutable type) ───────────────────────────────────────────────
  it("U2: PATCH with type field present → 400 'Typ kann nicht geändert werden'", async () => {
    const row = await seedRow();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/work-events/${row.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { type: WorkEventType.FIELD_SERVICE },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe(TYPE_IMMUTABLE_DE);
  });

  // ── Test U3 (tenant isolation) ────────────────────────────────────────────
  it("U3: ADMIN of tenant A PATCH row of tenant B → 404", async () => {
    const row = await app.prisma.workEvent.create({
      data: {
        employeeId: dataTenantB.employee.id,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: WorkEventSource.MANUAL,
        date: offsetDays(utcMidnightToday(), 14),
        workedMinutes: 480,
      },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/work-events/${row.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { note: "leak attempt" },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe(WORK_EVENT_NOT_FOUND_DE);
  });

  // ── Test U4 (locked-month gate) ────────────────────────────────────────────
  it("U4: snapshot for row's month → PATCH → 403", async () => {
    const today = utcMidnightToday();
    const target = offsetDays(today, 35);
    const row = await seedRow({ date: target });
    await seedLockedSnapshot(
      app,
      azubiEmpId,
      data.adminEmployee.id,
      target.getUTCFullYear(),
      target.getUTCMonth() + 1,
    );

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/work-events/${row.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { note: "blocked" },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe(LOCKED_MONTH_ERROR_DE);
  });

  // ── Test U5 (404 on non-existent id) ───────────────────────────────────────
  it("U5: PATCH /:randomUuid → 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/work-events/00000000-0000-0000-0000-000000000000`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { note: "irrelevant" },
    });
    expect(res.statusCode).toBe(404);
  });

  // ── Test U6 (404 on soft-deleted row) ──────────────────────────────────────
  it("U6: PATCH on soft-deleted row → 404", async () => {
    const row = await seedRow();
    await app.prisma.workEvent.update({
      where: { id: row.id },
      data: { deletedAt: new Date() },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/work-events/${row.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { note: "ghost" },
    });
    expect(res.statusCode).toBe(404);
  });

  // ── Test U7 (AuditLog UPDATED with before/after) ──────────────────────────
  it("U7: PATCH writes exactly 1 AuditLog row WORK_EVENT_UPDATED with old+new values", async () => {
    const row = await seedRow();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/work-events/${row.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { note: "updated", workedMinutes: 240 },
    });
    expect(res.statusCode).toBe(200);

    const audits = await app.prisma.auditLog.findMany({
      where: { action: "WORK_EVENT_UPDATED", entity: "WorkEvent", entityId: row.id },
    });
    expect(audits.length).toBe(1);
    const oldValue = audits[0].oldValue as Record<string, unknown>;
    const newValue = audits[0].newValue as Record<string, unknown>;
    expect(oldValue.note).toBe("initial");
    expect(oldValue.workedMinutes).toBe(480);
    expect(newValue.note).toBe("updated");
    expect(newValue.workedMinutes).toBe(240);
  });

  // ── Test U8 (payload re-validation) ────────────────────────────────────────
  it("U8: PATCH with invalid payload (mismatched type) → 400", async () => {
    const row = await seedRow();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/work-events/${row.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { payload: { type: WorkEventType.OTHER } },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Test U9 (EMPLOYEE forbidden) ───────────────────────────────────────────
  it("U9: EMPLOYEE PATCH → 403", async () => {
    const row = await seedRow();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/work-events/${row.id}`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { note: "forbidden" },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── Test U10 (REVISION B1 — PATCH source to PATTERN) ──────────────────────
  it("U10: ADMIN PATCH source=MANUAL → PATTERN → 200 (Zod accepts full Prisma enum domain)", async () => {
    const row = await seedRow({ source: WorkEventSource.MANUAL });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/work-events/${row.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { source: WorkEventSource.PATTERN },
    });
    expect(res.statusCode).toBe(200);

    const updated = await app.prisma.workEvent.findUnique({ where: { id: row.id } });
    expect(updated?.source).toBe(WorkEventSource.PATTERN);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/work-events/:id
// ───────────────────────────────────────────────────────────────────────────────
describe("DELETE /api/v1/work-events/:id (Plan 79-03 Task 3)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let dataTenantB: Awaited<ReturnType<typeof seedTestData>>;

  let azubiEmpId: string;
  let azubiUserId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "we-mut-del-a");
    dataTenantB = await seedTestData(app, "we-mut-del-b");

    const azubiUser = await app.prisma.user.create({
      data: {
        email: `azubi-del-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    azubiUserId = azubiUser.id;
    const azubiEmp = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: azubiUser.id,
        employeeNumber: `AZ-DEL-${Date.now()}`,
        firstName: "Azubi",
        lastName: "Del",
        hireDate: new Date("2024-01-01"),
        classification: EmployeeClassification.AZUBI,
      },
    });
    azubiEmpId = azubiEmp.id;
  });

  afterAll(async () => {
    try {
      const allEmpIds = [
        data.adminEmployee.id,
        data.employee.id,
        azubiEmpId,
        dataTenantB.adminEmployee.id,
        dataTenantB.employee.id,
      ];
      await app.prisma.workEvent.deleteMany({ where: { employeeId: { in: allEmpIds } } });
      await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: { in: allEmpIds } } });
      await app.prisma.auditLog.deleteMany({ where: { entity: "WorkEvent" } });
      await app.prisma.employee.deleteMany({ where: { id: { in: [azubiEmpId] } } });
      await app.prisma.refreshToken.deleteMany({ where: { userId: { in: [azubiUserId] } } });
      await app.prisma.user.deleteMany({ where: { id: { in: [azubiUserId] } } });
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, dataTenantB.tenant.id);
    } catch (err) {
      console.error("work-events-mutations DELETE cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    const allEmpIds = [
      data.adminEmployee.id,
      data.employee.id,
      azubiEmpId,
      dataTenantB.adminEmployee.id,
      dataTenantB.employee.id,
    ];
    await app.prisma.workEvent.deleteMany({ where: { employeeId: { in: allEmpIds } } });
    await app.prisma.saldoSnapshot.deleteMany({ where: { employeeId: { in: allEmpIds } } });
    await app.prisma.auditLog.deleteMany({ where: { entity: "WorkEvent" } });
  });

  async function seedRow(opts: { employeeId?: string; date?: Date } = {}) {
    const today = utcMidnightToday();
    const date = opts.date ?? offsetDays(today, 14);
    return app.prisma.workEvent.create({
      data: {
        employeeId: opts.employeeId ?? azubiEmpId,
        type: WorkEventType.VOCATIONAL_SCHOOL,
        source: WorkEventSource.MANUAL,
        date,
        workedMinutes: 480,
        expectedMinutes: 480,
        note: "to-delete",
      },
    });
  }

  // ── Test D1 (happy path) ───────────────────────────────────────────────────
  it("D1: ADMIN DELETE → 204 + DB row has deletedAt set", async () => {
    const row = await seedRow();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/work-events/${row.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(204);

    const after = await app.prisma.workEvent.findUnique({ where: { id: row.id } });
    expect(after).not.toBeNull();
    expect(after?.deletedAt).not.toBeNull();
  });

  // ── Test D2 (tenant isolation) ────────────────────────────────────────────
  it("D2: ADMIN of tenant A DELETE row of tenant B → 404", async () => {
    const row = await seedRow({ employeeId: dataTenantB.employee.id });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/work-events/${row.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // ── Test D3 (locked-month gate) ────────────────────────────────────────────
  it("D3: snapshot for row's month → DELETE → 403", async () => {
    const today = utcMidnightToday();
    const target = offsetDays(today, 35);
    const row = await seedRow({ date: target });
    await seedLockedSnapshot(
      app,
      azubiEmpId,
      data.adminEmployee.id,
      target.getUTCFullYear(),
      target.getUTCMonth() + 1,
    );

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/work-events/${row.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe(LOCKED_MONTH_ERROR_DE);
  });

  // ── Test D4 (404 on non-existent id) ───────────────────────────────────────
  it("D4: DELETE /:randomUuid → 404", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/work-events/00000000-0000-0000-0000-000000000000`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // ── Test D5 (idempotent via 404 on second DELETE) ──────────────────────────
  it("D5: DELETE then DELETE → second call → 404 (idempotent via not-found)", async () => {
    const row = await seedRow();
    const res1 = await app.inject({
      method: "DELETE",
      url: `/api/v1/work-events/${row.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res1.statusCode).toBe(204);

    const res2 = await app.inject({
      method: "DELETE",
      url: `/api/v1/work-events/${row.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res2.statusCode).toBe(404);
  });

  // ── Test D6 (AuditLog DELETED with oldValue) ──────────────────────────────
  it("D6: DELETE writes exactly 1 AuditLog row WORK_EVENT_DELETED with oldValue snapshot", async () => {
    const row = await seedRow();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/work-events/${row.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(204);

    const audits = await app.prisma.auditLog.findMany({
      where: { action: "WORK_EVENT_DELETED", entity: "WorkEvent", entityId: row.id },
    });
    expect(audits.length).toBe(1);
    expect(audits[0].userId).toBe(data.adminUser.id);
    const oldValue = audits[0].oldValue as Record<string, unknown>;
    expect(oldValue.employeeId).toBe(azubiEmpId);
    expect(oldValue.type).toBe(WorkEventType.VOCATIONAL_SCHOOL);
  });

  // ── Test D7 (EMPLOYEE forbidden) ───────────────────────────────────────────
  it("D7: EMPLOYEE DELETE → 403", async () => {
    const row = await seedRow();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/work-events/${row.id}`,
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── Test D8 (soft-delete proven — row still exists with deletedAt set) ────
  it("D8: after DELETE, findUnique still returns the row with deletedAt !== null (Revisionssicherheit)", async () => {
    const row = await seedRow();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/work-events/${row.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(204);

    const after = await app.prisma.workEvent.findUnique({ where: { id: row.id } });
    expect(after).not.toBeNull();
    expect(after?.deletedAt).not.toBe(null);
    expect(after?.deletedAt instanceof Date).toBe(true);
  });
});
