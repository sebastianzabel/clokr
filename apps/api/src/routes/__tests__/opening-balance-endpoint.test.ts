import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import { recalculateSnapshots } from "../../utils/recalculate-snapshots";
import type { FastifyInstance } from "fastify";

/**
 * Phase 99 Plan 06 (OB-03) — POST /api/v1/overtime/opening-balance.
 *
 * Verifies: ADMIN-only authz, tenant isolation (+ CROSS_TENANT_ACCESS_DENIED audit),
 * supersede-before-create inside one $transaction (never two active rows), CREATE/SUPERSEDE
 * audit trail, `.optional().nullable()` validation (v1.9.11 hazard), the recalc being
 * awaited (not fire-and-forget) before the response returns, and locked months being
 * reported/untouched rather than overwritten.
 *
 * Fixed calendar dates only. Initials/synthetic names only, no PII
 * (memory feedback_no_pii_in_github) — this file will be quoted in reviews.
 */
describe("POST /overtime/opening-balance (OB-03)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let other: Awaited<ReturnType<typeof seedTestData>>;
  let managerToken: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "ob06");
    other = await seedTestData(app, "ob06b");

    // A MANAGER user in `data`'s tenant (mirrors reports.test.ts's DATEV-04a pattern) —
    // seedTestData only creates ADMIN + EMPLOYEE tokens.
    const passwordHash = await bcrypt.hash("test1234", 10);
    const mgrUser = await app.prisma.user.create({
      data: {
        email: `mgr-ob06-${Date.now().toString(36)}@test.de`,
        passwordHash,
        role: "MANAGER",
        isActive: true,
      },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: mgrUser.id,
        employeeNumber: `MGR-OB06-${Date.now().toString(36)}`,
        firstName: "Mgr",
        lastName: "OB06",
        hireDate: new Date("2024-01-01T00:00:00Z"),
      },
    });
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: mgrUser.email, password: "test1234" },
    });
    managerToken = JSON.parse(loginRes.body).accessToken;
  });

  afterAll(async () => {
    try {
      // OpeningBalance.employeeId is onDelete: Restrict (Revisionssicherheit) — must be
      // cleared before cleanupTestData deletes the tenants' employees, or the FK blocks it.
      await app.prisma.openingBalance.deleteMany({
        where: { employee: { tenantId: { in: [data.tenant.id, other.tenant.id] } } },
      });
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, other.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  /** Create a fresh Employee (own User + WorkSchedule + OvertimeAccount) in `data`'s tenant. */
  async function createEmployee(suffix: string, hireDateStr: string) {
    const passwordHash = await bcrypt.hash("test1234", 10);
    const user = await app.prisma.user.create({
      data: {
        email: `ob06-${suffix}-${Date.now().toString(36)}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `OB06-${suffix}-${Date.now().toString(36)}`,
        firstName: "Test",
        lastName: suffix,
        hireDate: new Date(`${hireDateStr}T00:00:00Z`),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date(`${hireDateStr}T00:00:00Z`),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: employee.id, balanceHours: 0 },
    });
    return employee;
  }

  /** Create a fixed-date, fixed-hours WORK time entry (8h net, 60min break). */
  async function createEntry(employeeId: string, dateStr: string) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        date: new Date(`${dateStr}T00:00:00Z`),
        startTime: new Date(`${dateStr}T08:00:00.000Z`),
        endTime: new Date(`${dateStr}T17:00:00.000Z`),
        breakMinutes: 60,
        source: "MANUAL",
        type: "WORK",
      },
    });
  }

  async function postOpeningBalance(token: string | undefined, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/overtime/opening-balance",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload,
    });
  }

  it("Test 1: EMPLOYEE -> 403, MANAGER -> 403, unauthenticated -> 401", async () => {
    const basePayload = {
      employeeId: data.employee.id,
      minutes: 100,
      effectiveFrom: "2024-01-01",
      reason: "Test 1 authz payload",
    };

    const empRes = await postOpeningBalance(data.empToken, basePayload);
    expect(empRes.statusCode).toBe(403);

    const mgrRes = await postOpeningBalance(managerToken, basePayload);
    expect(mgrRes.statusCode).toBe(403);

    const anonRes = await postOpeningBalance(undefined, basePayload);
    expect(anonRes.statusCode).toBe(401);
  });

  it("Test 2: cross-tenant admin -> 404 'Mitarbeiter nicht gefunden', no row written, CROSS_TENANT_ACCESS_DENIED audit", async () => {
    const res = await postOpeningBalance(data.adminToken, {
      employeeId: other.employee.id, // belongs to a DIFFERENT tenant than data.adminToken
      minutes: 500,
      effectiveFrom: "2024-01-01",
      reason: "Cross-tenant attempt — must be rejected",
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("Mitarbeiter nicht gefunden");

    const rows = await app.prisma.openingBalance.findMany({
      where: { employeeId: other.employee.id },
    });
    expect(rows.length).toBe(0);

    const audit = await app.prisma.auditLog.findFirst({
      where: {
        action: "CROSS_TENANT_ACCESS_DENIED",
        entity: "OpeningBalance",
        entityId: other.employee.id,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
  });

  it("Test 3: happy path -> 201, exactly one active row, source ADMIN_ENTRY, createdBy = admin, CREATE audit", async () => {
    const emp = await createEmployee("t3", "2025-01-01");

    const res = await postOpeningBalance(data.adminToken, {
      employeeId: emp.id,
      minutes: 3000,
      effectiveFrom: "2025-01-01",
      reason: "Übernommenes Guthaben aus Altsystem (Test 3)",
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.openingBalance.minutes).toBe(3000);
    expect(body.openingBalance.source).toBe("ADMIN_ENTRY");
    expect(body.openingBalance.createdBy).toBe(data.adminUser.id);
    expect(body.supersededId).toBeNull();

    const rows = await app.prisma.openingBalance.findMany({
      where: { employeeId: emp.id, superseded: false },
    });
    expect(rows.length).toBe(1);
    expect(rows[0].minutes).toBe(3000);

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "CREATE", entity: "OpeningBalance", entityId: rows[0].id },
    });
    expect(audit).not.toBeNull();
  });

  it("Test 4: supersede with reason -> 201, old row superseded+linked, exactly one active row, SUPERSEDE audit carries oldValue", async () => {
    const emp = await createEmployee("t4", "2025-01-01");

    const first = await postOpeningBalance(data.adminToken, {
      employeeId: emp.id,
      minutes: 1000,
      effectiveFrom: "2025-01-01",
      reason: "Erste Erfassung (Test 4)",
    });
    expect(first.statusCode).toBe(201);
    const firstId = JSON.parse(first.body).openingBalance.id;

    const second = await postOpeningBalance(data.adminToken, {
      employeeId: emp.id,
      minutes: 1500,
      effectiveFrom: "2025-01-01",
      reason: "Korrektur (Test 4)",
      supersededReason: "Ursprünglicher Wert war falsch berechnet",
    });
    expect(second.statusCode).toBe(201);
    const body = JSON.parse(second.body);
    expect(body.supersededId).toBe(firstId);

    const oldRow = await app.prisma.openingBalance.findUnique({ where: { id: firstId } });
    expect(oldRow?.superseded).toBe(true);
    expect(oldRow?.supersededBy).toBe(body.openingBalance.id);

    const activeRows = await app.prisma.openingBalance.findMany({
      where: { employeeId: emp.id, superseded: false },
    });
    expect(activeRows.length).toBe(1);
    expect(activeRows[0].id).toBe(body.openingBalance.id);

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "SUPERSEDE", entity: "OpeningBalance", entityId: body.openingBalance.id },
    });
    expect(audit).not.toBeNull();
    expect((audit?.oldValue as { id?: string } | null)?.id).toBe(firstId);
  });

  it("Test 5: correction without supersededReason -> 400, original row untouched and still active", async () => {
    const emp = await createEmployee("t5", "2025-01-01");
    const existing = await app.prisma.openingBalance.create({
      data: {
        employeeId: emp.id,
        minutes: 800,
        effectiveFrom: new Date("2025-01-01T00:00:00Z"),
        reason: "Vorbestehender aktiver Eröffnungssaldo (Test 5)",
        source: "ADMIN_ENTRY",
        createdBy: data.adminUser.id,
      },
    });

    const res = await postOpeningBalance(data.adminToken, {
      employeeId: emp.id,
      minutes: 900,
      effectiveFrom: "2025-01-01",
      reason: "Korrekturversuch ohne Begründung (Test 5)",
      // supersededReason intentionally omitted
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe(
      "Für die Korrektur eines bestehenden Eröffnungssaldos ist eine Begründung erforderlich.",
    );

    const rows = await app.prisma.openingBalance.findMany({ where: { employeeId: emp.id } });
    expect(rows.length).toBe(1);
    const untouched = await app.prisma.openingBalance.findUnique({ where: { id: existing.id } });
    expect(untouched?.superseded).toBe(false);
    expect(untouched?.minutes).toBe(800);
  });

  it("Test 6: validation — reason too short -> 400; explicit evidenceRef:null + approvedBy:null accepted -> 201", async () => {
    const emp = await createEmployee("t6", "2025-01-01");

    const tooShort = await postOpeningBalance(data.adminToken, {
      employeeId: emp.id,
      minutes: 100,
      effectiveFrom: "2025-01-01",
      reason: "kurz", // well under min(10)
    });
    expect(tooShort.statusCode).toBe(400);

    const rows0 = await app.prisma.openingBalance.findMany({ where: { employeeId: emp.id } });
    expect(rows0.length).toBe(0);

    // v1.9.11 hazard: Clokr web clients send `field: x ? x : null` — a bare `.optional()`
    // would 400 this with a naked "Validierungsfehler".
    const withNulls = await postOpeningBalance(data.adminToken, {
      employeeId: emp.id,
      minutes: 100,
      effectiveFrom: "2025-01-01",
      reason: "Ausreichend lange Begründung (Test 6)",
      evidenceRef: null,
      approvedBy: null,
    });
    expect(withNulls.statusCode).toBe(201);
    const body = JSON.parse(withNulls.body);
    expect(body.openingBalance.evidenceRef).toBeNull();
    expect(body.openingBalance.approvedBy).toBeNull();
    expect(body.openingBalance.approvedAt).toBeNull();
  });

  it("Test 7: the chain is re-threaded before the response returns — no second request needed", async () => {
    // June 2025 (Berlin summer, UTC+2): June 1 00:00 Berlin = May 31 22:00 UTC.
    const JUNE_START = new Date("2025-05-31T22:00:00Z");
    const JUNE_END = new Date("2025-06-30T21:59:59.999Z");
    const emp = await createEmployee("t7", "2025-06-01");
    await createEntry(emp.id, "2025-06-02");

    // An UNLOCKED, injectedDelta-neutral placeholder — no OpeningBalance exists yet,
    // so this is a genuine "not yet computed" head row (mirrors the OB-06 fixture's
    // Step 1 in recalculate-snapshots.test.ts). Deliberately NOT created via the
    // close-month endpoint, which would lock the TimeEntries and make this Test 8's
    // scenario instead of Test 7's.
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: emp.id,
        periodType: "MONTHLY",
        periodStart: JUNE_START,
        periodEnd: JUNE_END,
        workedMinutes: 0,
        expectedMinutes: 1, // nonzero so isBridgeSnapshot() never classifies this a bridge
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date("2025-07-01T00:00:00Z"),
        closedBy: null,
        note: "Test 7 bootstrap placeholder (pre-OB)",
      },
    });
    await recalculateSnapshots(app, emp.id, JUNE_START);
    const bootstrapped = await app.prisma.saldoSnapshot.findFirstOrThrow({
      where: { employeeId: emp.id, periodType: "MONTHLY", superseded: false },
    });
    // Head of chain, no OpeningBalance yet — carryOver is a pure no-op of balanceMinutes.
    expect(bootstrapped.carryOver).toBe(bootstrapped.balanceMinutes);

    const obRes = await postOpeningBalance(data.adminToken, {
      employeeId: emp.id,
      minutes: 4200,
      effectiveFrom: "2025-05-01", // before hireDate — guarantees a full-history re-thread
      reason: "Übernommenes Guthaben aus Altsystem (Test 7)",
    });
    expect(obRes.statusCode).toBe(201);
    const obBody = JSON.parse(obRes.body);
    expect(obBody.lockedMonthsSkipped).toEqual([]);

    // No second request, no waiting: the re-threaded value must already be stored.
    const updatedSnapshot = await app.prisma.saldoSnapshot.findFirst({
      where: { employeeId: emp.id, periodType: "MONTHLY", superseded: false },
    });
    expect(updatedSnapshot).not.toBeNull();
    expect(updatedSnapshot?.carryOver).toBe(4200 + bootstrapped.balanceMinutes);
  });

  it("Test 8: a locked month is reported in lockedMonthsSkipped, left untouched, and a German warning is returned", async () => {
    const emp = await createEmployee("t8", "2025-05-01");

    // June 2025 (Berlin summer, UTC+2): June 1 00:00 Berlin = May 31 22:00 UTC;
    // July 1 00:00 Berlin = June 30 22:00 UTC, minus 1s.
    const juneStart = new Date("2025-05-31T22:00:00Z");
    const juneEnd = new Date("2025-06-30T21:59:59Z");
    const LOCKED_CARRY_OVER = 999;

    // A locked TimeEntry is the canonical "this month is closed" signal isSnapshotLocked() reads.
    await app.prisma.timeEntry.create({
      data: {
        employeeId: emp.id,
        date: new Date("2025-06-10T00:00:00Z"),
        startTime: new Date("2025-06-10T08:00:00Z"),
        endTime: new Date("2025-06-10T16:00:00Z"),
        breakMinutes: 30,
        source: "MANUAL",
        type: "WORK",
        isLocked: true,
        lockedAt: new Date("2025-07-01T00:00:00Z"),
      },
    });

    // expectedMinutes:1 (not 0) so this row is never mistaken for an isBridgeSnapshot() row —
    // it must hit the lock-skip branch under test, not the pre-existing bridge branch.
    const lockedSnap = await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: emp.id,
        periodType: "MONTHLY",
        periodStart: juneStart,
        periodEnd: juneEnd,
        workedMinutes: 0,
        expectedMinutes: 1,
        balanceMinutes: 0,
        carryOver: LOCKED_CARRY_OVER,
        closedAt: new Date("2025-07-01T00:00:00Z"),
        closedBy: data.adminUser.id,
        note: "Locked-month fixture (Test 8)",
      },
    });

    const res = await postOpeningBalance(data.adminToken, {
      employeeId: emp.id,
      minutes: 500,
      effectiveFrom: "2025-05-01",
      reason: "Übernommenes Guthaben trotz gesperrtem Monat (Test 8)",
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.lockedMonthsSkipped).toHaveLength(1);
    expect(body.lockedMonthsSkipped[0].snapshotId).toBe(lockedSnap.id);
    expect(typeof body.warning).toBe("string");
    expect(body.warning).toContain("abgeschlossene");

    const stillLocked = await app.prisma.saldoSnapshot.findUnique({
      where: { id: lockedSnap.id },
    });
    expect(stillLocked?.superseded).toBe(false);
    expect(stillLocked?.carryOver).toBe(LOCKED_CARRY_OVER);
  });
});
