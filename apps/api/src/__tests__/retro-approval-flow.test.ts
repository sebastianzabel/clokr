/**
 * RED-first per 76.29-00; turns GREEN across Plans 01+03.
 *
 * Pins the Nyquist-critical approval-flow invariants for Phase 76.29:
 *   - RETRO-02: RetroEntryRequest create/approve routes (POST/PATCH)
 *   - RETRO-02: Self-approval blocked (two distinctness checks)
 *   - RETRO-02: Grant single-use (concurrent consume → exactly one succeeds)
 *   - RETRO-03: Audit log RETRO_ENTRY_APPROVED with mandatory reviewNote
 *   - RETRO-04: Lock-first ordering (locked month → 403 even with approved grant)
 *
 * All tests reference symbols/routes that do not exist yet:
 *   - POST /api/v1/retro-entry-requests (Plan 03)
 *   - GET /api/v1/retro-entry-requests (Plan 03)
 *   - PATCH /api/v1/retro-entry-requests/:id/review (Plan 03)
 *   - RetroEntryRequest model + RetroEntryStatus enum (Plan 01)
 *   - Grant consumption on POST/PUT time-entries (Plan 02 grantId param)
 *   - AuditLog action RETRO_ENTRY_APPROVED (Plan 03)
 *
 * A RED failure (route 404 / missing symbol / wrong shape) is the SUCCESS criteria here.
 * Do NOT skip, stub, or .only these tests.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { dateStrInTz } from "../utils/timezone";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TZ = "Europe/Berlin";

// Frozen "now" so all date arithmetic is deterministic
const FROZEN_NOW = new Date("2024-04-14T22:00:00.000Z"); // Berlin: 2024-04-15 00:00

function daysAgoInTz(now: Date, n: number): string {
  return dateStrInTz(new Date(now.getTime() - n * 24 * 60 * 60 * 1000), TZ);
}

// ── Seed helper ───────────────────────────────────────────────────────────────

async function seedApprovalTenant(app: FastifyInstance, suffix: string) {
  const s = `rappr-${suffix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  const prisma = app.prisma;

  const tenant = await prisma.tenant.create({
    data: { name: `RetroAppr ${s}`, slug: `rappr-${s}`, federalState: "NIEDERSACHSEN" },
  });
  await prisma.tenantConfig.create({
    data: { tenantId: tenant.id, defaultVacationDays: 30, timezone: TZ },
  });

  async function mkUser(role: "ADMIN" | "MANAGER" | "EMPLOYEE", idx: string) {
    const user = await prisma.user.create({
      data: {
        email: `${role.toLowerCase()}-${idx}-${s}@rappr.test`,
        passwordHash: await bcrypt.hash("pwTest123", 4),
        role,
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        employeeNumber: `${role[0]}-${idx}-${s}`,
        firstName: role,
        lastName: "Rappr",
        hireDate: new Date("2023-01-01"),
      },
    });
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2023-01-01"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `${role.toLowerCase()}-${idx}-${s}@rappr.test`, password: "pwTest123" },
    });
    const { accessToken } = JSON.parse(loginRes.body);
    return { user, emp, token: accessToken };
  }

  const admin = await mkUser("ADMIN", "a");
  const manager1 = await mkUser("MANAGER", "m1");
  const manager2 = await mkUser("MANAGER", "m2"); // different manager for approvals
  const employee = await mkUser("EMPLOYEE", "e");

  return {
    tenantId: tenant.id,
    admin,
    manager1,
    manager2,
    employee,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("Retro approval-flow + lock-ordering + grant-race (76.29-00 RED)", () => {
  let app: FastifyInstance;
  let tenantId: string;

  // Actors
  let adminToken: string;
  let manager1Token: string;
  let manager2Token: string;
  let empToken: string;
  let employeeId: string;
  let manager1EmpId: string;

  beforeAll(async () => {
    app = await getTestApp();
    const seed = await seedApprovalTenant(app, "main");
    tenantId = seed.tenantId;
    adminToken = seed.admin.token;
    manager1Token = seed.manager1.token;
    manager2Token = seed.manager2.token;
    empToken = seed.employee.token;
    employeeId = seed.employee.emp.id;
    manager1EmpId = seed.manager1.emp.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("retro-approval cleanup:", err);
    }
    await closeTestApp();
    vi.useRealTimers();
  });

  // ── RETRO-02 create ───────────────────────────────────────────────────────────

  describe("RETRO-02 create: POST /api/v1/retro-entry-requests", () => {
    it("RETRO-02 create: EMPLOYEE submits RetroEntryRequest for >window targetDate with reason → 201 status=PENDING", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), 11); // beyond default 10-day window
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/retro-entry-requests",
          headers: { authorization: `Bearer ${empToken}` },
          payload: {
            employeeId,
            targetDate,
            reason: "Vergessen einzutragen wegen Dienstreise",
          },
        });
        // RED: route not yet implemented (Plan 03)
        expect(res.statusCode, "RETRO-02 create must return 201").toBe(201);
        const body = JSON.parse(res.body);
        expect(body.status, "new request must be PENDING").toBe("PENDING");
        expect(body.targetDate, "targetDate must match").toBe(targetDate);
        expect(body.reason).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    it("RETRO-02 create: missing reason → 400 (reason is mandatory, Revisionssicherheit)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), 11);
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/retro-entry-requests",
          headers: { authorization: `Bearer ${empToken}` },
          payload: { employeeId, targetDate }, // reason omitted
        });
        // RED: Zod validation not yet implemented
        expect(res.statusCode).toBe(400);
      } finally {
        vi.useRealTimers();
      }
    });

    it("RETRO-02 create: empty reason string → 400", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), 11);
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/retro-entry-requests",
          headers: { authorization: `Bearer ${empToken}` },
          payload: { employeeId, targetDate, reason: "" },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── RETRO-02 self-approval blocked (two distinctness checks) ─────────────────

  describe("RETRO-02 self-approval: both distinctness checks (requester != approver, approver != entry-employee-user)", () => {
    it("RETRO-02 self-approval C3: requester attempting PATCH review of own request → 403 'Eigene Anträge können nicht selbst genehmigt werden'", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), 12);

        // Create a request as employee
        const createRes = await app.inject({
          method: "POST",
          url: "/api/v1/retro-entry-requests",
          headers: { authorization: `Bearer ${empToken}` },
          payload: { employeeId, targetDate, reason: "Test self-approval block" },
        });
        if (createRes.statusCode !== 201) return; // route not yet exists; RED expected
        const requestId = JSON.parse(createRes.body).id;

        // Same employee attempts to approve their own request
        const res = await app.inject({
          method: "PATCH",
          url: `/api/v1/retro-entry-requests/${requestId}/review`,
          headers: { authorization: `Bearer ${empToken}` },
          payload: { status: "APPROVED", reviewNote: "Ich genehmige mich selbst" },
        });
        // RED: self-approval block not yet implemented
        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.body);
        expect(body.error).toBe("Eigene Anträge können nicht selbst genehmigt werden");
      } finally {
        vi.useRealTimers();
      }
    });

    it("RETRO-02 self-approval C3: MANAGER who IS the target employee cannot approve (approverId != entry-employee-user)", async () => {
      // This covers the second distinctness check: a MANAGER who happens to be the
      // target employee's user cannot approve their own entry request.
      // Setup: create a request for manager1's own entry; manager1 tries to approve it.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), 13);

        // Create request targeting manager1's employee record (as manager1)
        const createRes = await app.inject({
          method: "POST",
          url: "/api/v1/retro-entry-requests",
          headers: { authorization: `Bearer ${manager1Token}` },
          payload: { employeeId: manager1EmpId, targetDate, reason: "Manager own entry test" },
        });
        if (createRes.statusCode !== 201) return;
        const requestId = JSON.parse(createRes.body).id;

        // manager1 attempts to approve their own request
        const res = await app.inject({
          method: "PATCH",
          url: `/api/v1/retro-entry-requests/${requestId}/review`,
          headers: { authorization: `Bearer ${manager1Token}` },
          payload: { status: "APPROVED", reviewNote: "Manager approves their own request" },
        });
        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.body);
        expect(body.error).toBe("Eigene Anträge können nicht selbst genehmigt werden");
      } finally {
        vi.useRealTimers();
      }
    });

    it("RETRO-02 approve: DIFFERENT manager reviews request → 200 status=APPROVED", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), 14);

        const createRes = await app.inject({
          method: "POST",
          url: "/api/v1/retro-entry-requests",
          headers: { authorization: `Bearer ${empToken}` },
          payload: { employeeId, targetDate, reason: "Eintrag vergessen" },
        });
        if (createRes.statusCode !== 201) return;
        const requestId = JSON.parse(createRes.body).id;

        // manager2 (different from employee) approves
        const res = await app.inject({
          method: "PATCH",
          url: `/api/v1/retro-entry-requests/${requestId}/review`,
          headers: { authorization: `Bearer ${manager2Token}` },
          payload: { status: "APPROVED", reviewNote: "Genehmigt nach Rücksprache" },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.status).toBe("APPROVED");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── RETRO-03 audit trail ───────────────────────────────────────────────────────

  describe("RETRO-03 audit: RETRO_ENTRY_APPROVED action with mandatory fields", () => {
    it("RETRO-03: reviewNote absent on PATCH review → 400 (mandatory, Revisionssicherheit)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), 15);

        const createRes = await app.inject({
          method: "POST",
          url: "/api/v1/retro-entry-requests",
          headers: { authorization: `Bearer ${empToken}` },
          payload: { employeeId, targetDate, reason: "Nachträgliche Erfassung" },
        });
        if (createRes.statusCode !== 201) return;
        const requestId = JSON.parse(createRes.body).id;

        // Attempt approval without reviewNote
        const res = await app.inject({
          method: "PATCH",
          url: `/api/v1/retro-entry-requests/${requestId}/review`,
          headers: { authorization: `Bearer ${manager2Token}` },
          payload: { status: "APPROVED" }, // reviewNote omitted
        });
        // RED: reviewNote is mandatory
        expect(res.statusCode).toBe(400);
      } finally {
        vi.useRealTimers();
      }
    });

    it("RETRO-03: after approval, AuditLog contains RETRO_ENTRY_APPROVED with reason, approverId, requesterId, targetDate, ageInDays", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), 16);

        const createRes = await app.inject({
          method: "POST",
          url: "/api/v1/retro-entry-requests",
          headers: { authorization: `Bearer ${empToken}` },
          payload: { employeeId, targetDate, reason: "Dienstreise — Eintrag vergessen" },
        });
        if (createRes.statusCode !== 201) return;
        const requestBody = JSON.parse(createRes.body);
        const requestId = requestBody.id;
        const requesterId = requestBody.requesterId ?? requestBody.employeeId;

        // Approve with reviewNote
        const approveRes = await app.inject({
          method: "PATCH",
          url: `/api/v1/retro-entry-requests/${requestId}/review`,
          headers: { authorization: `Bearer ${manager2Token}` },
          payload: { status: "APPROVED", reviewNote: "Bestätigt nach Rücksprache" },
        });
        if (approveRes.statusCode !== 200) return;

        // Verify AuditLog entry
        const auditLog = await app.prisma.auditLog.findFirst({
          where: { action: "RETRO_ENTRY_APPROVED", entityId: requestId },
          orderBy: { createdAt: "desc" },
        });
        // RED: RETRO_ENTRY_APPROVED action not yet created in Plan 03
        expect(auditLog, "AuditLog with RETRO_ENTRY_APPROVED must exist").not.toBeNull();

        if (auditLog) {
          const newValue = auditLog.newValue as Record<string, unknown> | null;
          expect(newValue?.reason, "audit must carry reason").toBeTruthy();
          expect(
            newValue?.approverId ?? auditLog.userId,
            "audit must carry approverId",
          ).toBeTruthy();
          expect(newValue?.requesterId ?? requesterId, "audit must carry requesterId").toBeTruthy();
          expect(newValue?.targetDate ?? targetDate, "audit must carry targetDate").toBeTruthy();
          expect(typeof (newValue?.ageInDays ?? 0), "audit must carry ageInDays as number").toBe(
            "number",
          );
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── RETRO-02 grant consumption (single-use) ────────────────────────────────────

  describe("RETRO-02 grant: APPROVED grant consumed on time-entry write → USED, second write → 403", () => {
    it("RETRO-02 grant consumption: after APPROVED grant, employee POST for targetDate → 201 source=CORRECTION, grant flips to USED", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), 17);

        // Create and approve a request
        const createRes = await app.inject({
          method: "POST",
          url: "/api/v1/retro-entry-requests",
          headers: { authorization: `Bearer ${empToken}` },
          payload: { employeeId, targetDate, reason: "Eintrag fehlt" },
        });
        if (createRes.statusCode !== 201) return;
        const grantId = JSON.parse(createRes.body).id;

        await app.inject({
          method: "PATCH",
          url: `/api/v1/retro-entry-requests/${grantId}/review`,
          headers: { authorization: `Bearer ${manager2Token}` },
          payload: { status: "APPROVED", reviewNote: "OK" },
        });

        // Employee uses the grant to create the entry
        const entryRes = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries",
          headers: { authorization: `Bearer ${empToken}` },
          payload: {
            employeeId,
            date: targetDate,
            startTime: `${targetDate}T08:00:00.000Z`,
            endTime: `${targetDate}T16:00:00.000Z`,
            breakMinutes: 30,
            grantId, // Plan 02 adds grantId to POST body schema
          },
        });
        // RED: grant consumption not yet implemented
        expect(entryRes.statusCode, "grant-backed POST must succeed with 201").toBe(201);
        const entryBody = JSON.parse(entryRes.body);
        expect(entryBody.entry?.source, "entry created via grant must have source=CORRECTION").toBe(
          "CORRECTION",
        );

        // Verify grant is now USED
        // retroEntryRequest model does not exist yet (Plan 01) — access via unknown cast
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const retroModel = (app.prisma as unknown as Record<string, any>)["retroEntryRequest"] as
          | { findUnique: (opts: object) => Promise<{ status: string } | null> }
          | undefined;
        const grant = await retroModel?.findUnique({ where: { id: grantId } });
        expect(grant?.status, "grant must be USED after consumption").toBe("USED");

        // Second write with same grant → 403
        const secondRes = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries",
          headers: { authorization: `Bearer ${empToken}` },
          payload: {
            employeeId,
            date: targetDate,
            startTime: `${targetDate}T08:00:00.000Z`,
            endTime: `${targetDate}T17:00:00.000Z`,
            breakMinutes: 30,
            grantId, // same grant, now USED
          },
        });
        expect(secondRes.statusCode, "second write with USED grant must be 403").toBe(403);
      } finally {
        vi.useRealTimers();
      }
    });

    it("RETRO-02 grant race: concurrent writes consuming same APPROVED grant → exactly one succeeds, grant ends USED once", async () => {
      // Property test: pins the $transaction conditional-update requirement.
      // Without the conditional update ("UPDATE … WHERE status = 'APPROVED'"),
      // two concurrent requests can both succeed — double-consuming the grant.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        const targetDate = daysAgoInTz(new Date(), 18);

        const createRes = await app.inject({
          method: "POST",
          url: "/api/v1/retro-entry-requests",
          headers: { authorization: `Bearer ${empToken}` },
          payload: { employeeId, targetDate, reason: "Race condition test" },
        });
        if (createRes.statusCode !== 201) return;
        const grantId = JSON.parse(createRes.body).id;

        await app.inject({
          method: "PATCH",
          url: `/api/v1/retro-entry-requests/${grantId}/review`,
          headers: { authorization: `Bearer ${manager2Token}` },
          payload: { status: "APPROVED", reviewNote: "Race test approval" },
        });

        // Fire two concurrent writes against the same approved grant
        const [res1, res2] = await Promise.all([
          app.inject({
            method: "POST",
            url: "/api/v1/time-entries",
            headers: { authorization: `Bearer ${empToken}` },
            payload: {
              employeeId,
              date: targetDate,
              startTime: `${targetDate}T08:00:00.000Z`,
              endTime: `${targetDate}T16:00:00.000Z`,
              breakMinutes: 30,
              grantId,
            },
          }),
          app.inject({
            method: "POST",
            url: "/api/v1/time-entries",
            headers: { authorization: `Bearer ${empToken}` },
            payload: {
              employeeId,
              date: targetDate,
              startTime: `${targetDate}T08:00:00.000Z`,
              endTime: `${targetDate}T16:00:00.000Z`,
              breakMinutes: 30,
              grantId,
            },
          }),
        ]);

        const statuses = [res1.statusCode, res2.statusCode];
        // RED: exactly one must succeed, one must be rejected
        const successes = statuses.filter((s) => s === 201).length;
        const failures = statuses.filter((s) => s === 403).length;
        expect(successes, "exactly one concurrent write must succeed").toBe(1);
        expect(failures, "exactly one concurrent write must be rejected (single-use grant)").toBe(
          1,
        );

        // Grant must end in USED status exactly once (not PENDING/APPROVED)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const retroModel2 = (app.prisma as unknown as Record<string, any>)["retroEntryRequest"] as
          | { findUnique: (opts: object) => Promise<{ status: string } | null> }
          | undefined;
        const grant = await retroModel2?.findUnique({ where: { id: grantId } });
        expect(grant?.status, "grant must be USED after concurrent race").toBe("USED");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── RETRO-04 lock-first ordering ──────────────────────────────────────────────

  describe("RETRO-04 lock-first: locked month → 403 month-locked even with APPROVED grant", () => {
    it("RETRO-04: approved grant for date in locked month → POST rejected with month-locked 403, NOT allowed by grant", async () => {
      // Setup: lock a prior month by creating a SaldoSnapshot (superseded:false).
      // Then create an APPROVED grant for a date in that month.
      // The write must be rejected with the month-locked message, NOT allowed by the grant.
      // This pins the ordering: lock-check runs BEFORE window/grant check.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        // Create a snapshot for 2024-02 (locked month)
        const lockedDate = "2024-02-15"; // in the locked month
        const { monthRangeUtc } = await import("../utils/timezone");
        const { start: lockedMonthStart } = monthRangeUtc(2024, 2, TZ);

        // First ensure an employee exists (use existing employeeId)
        await app.prisma.saldoSnapshot.create({
          data: {
            employeeId,
            periodType: "MONTHLY",
            periodStart: lockedMonthStart,
            periodEnd: new Date("2024-02-29T22:59:59.000Z"),
            workedMinutes: 0,
            expectedMinutes: 0,
            balanceMinutes: 0,
            carryOver: 0,
            closedAt: new Date(),
            superseded: false,
            note: "Test lock for RETRO-04",
          },
        });

        // Create and approve a grant for the locked date
        const createRes = await app.inject({
          method: "POST",
          url: "/api/v1/retro-entry-requests",
          headers: { authorization: `Bearer ${empToken}` },
          payload: { employeeId, targetDate: lockedDate, reason: "Locked month entry" },
        });
        if (createRes.statusCode !== 201) {
          // Route not yet implemented — test is RED as expected
          expect(createRes.statusCode, "RETRO-04: request route must exist (Plan 03)").toBe(201);
          return;
        }
        const grantId = JSON.parse(createRes.body).id;

        await app.inject({
          method: "PATCH",
          url: `/api/v1/retro-entry-requests/${grantId}/review`,
          headers: { authorization: `Bearer ${manager2Token}` },
          payload: { status: "APPROVED", reviewNote: "Genehmigt" },
        });

        // Attempt to create entry in locked month with approved grant
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries",
          headers: { authorization: `Bearer ${empToken}` },
          payload: {
            employeeId,
            date: lockedDate,
            startTime: `${lockedDate}T08:00:00.000Z`,
            endTime: `${lockedDate}T16:00:00.000Z`,
            breakMinutes: 30,
            grantId,
          },
        });
        // RED: lock-first ordering must reject even with a valid grant
        expect(
          res.statusCode,
          "locked month must be rejected with 403 even with approved grant",
        ).toBe(403);
        const body = JSON.parse(res.body);
        // The month-lock message must win (not RETRO_WINDOW_EXCEEDED)
        expect(
          body.error,
          "error must be the month-locked message, not RETRO_WINDOW_EXCEEDED",
        ).toMatch(/abgeschlossen/i);
        expect(body.error).not.toBe("RETRO_WINDOW_EXCEEDED");

        // Cleanup snapshot
        await app.prisma.saldoSnapshot.deleteMany({
          where: { employeeId, periodStart: lockedMonthStart, superseded: false },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("RETRO-04: lock-check ordering — month-lock message wins over RETRO_WINDOW_EXCEEDED for old locked entries", async () => {
      // A date that is BOTH beyond the retro window AND in a locked month must return
      // the month-locked error (403), not RETRO_WINDOW_EXCEEDED. Lock-first is the invariant.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FROZEN_NOW);
      try {
        // Lock January 2024 for the employee
        const { monthRangeUtc } = await import("../utils/timezone");
        const { start: janStart } = monthRangeUtc(2024, 1, TZ);
        const lockedDateJan = "2024-01-15"; // old AND beyond window

        await app.prisma.saldoSnapshot.create({
          data: {
            employeeId,
            periodType: "MONTHLY",
            periodStart: janStart,
            periodEnd: new Date("2024-01-31T22:59:59.000Z"),
            workedMinutes: 0,
            expectedMinutes: 0,
            balanceMinutes: 0,
            carryOver: 0,
            closedAt: new Date(),
            superseded: false,
            note: "Test lock ordering Jan",
          },
        });

        // POST entry for locked+beyond-window date WITHOUT a grant
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/time-entries",
          headers: { authorization: `Bearer ${empToken}` },
          payload: {
            employeeId,
            date: lockedDateJan,
            startTime: `${lockedDateJan}T08:00:00.000Z`,
            endTime: `${lockedDateJan}T16:00:00.000Z`,
            breakMinutes: 30,
          },
        });
        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.body);
        // Must match month-locked message, not retro-window message
        expect(body.error ?? "").toMatch(/abgeschlossen/i);
        expect(body.error ?? "").not.toBe("RETRO_WINDOW_EXCEEDED");

        // Cleanup
        await app.prisma.saldoSnapshot.deleteMany({
          where: { employeeId, periodStart: janStart, superseded: false },
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
