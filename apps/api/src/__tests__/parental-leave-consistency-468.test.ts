/**
 * Issue #468 plan 07 (D-07, D-09, D-10) — consistency guards around a declared Elternzeit-
 * Kürzung (plan 04): a correction or a cancellation of the anchoring PARENTAL `LeaveRequest` must
 * not silently invalidate an ACTIVE reduction, and the statutory floor of a reduced year follows
 * the SAME reduced value in the `PUT /settings/vacation` write guard that the Prüfbericht
 * (audit-vacation-entitlements.test.ts) also asserts for its own (read-only) side.
 *
 * Fixed calendar-date literals throughout (this project's documented time-bomb-fixture rule) —
 * every Elternzeit span and every `declaredAt` sits safely in the past relative to any plausible
 * test-run clock. Own seeded tenant ("plc468"); every fixture employee is isolated (its own
 * Employee + WorkSchedule + LeaveRequest) so tests never share mutable state. Initials-only names
 * (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";

describe("Issue #468 plan 07 — Elternzeit-Kürzung consistency guards (D-07/D-09/D-10)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let parentalTypeId: string;
  let vacationTypeId: string;

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createFixedEmployee(label: string) {
    const s = uniqueSuffix(label);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: "P",
        lastName: "PLC468",
        hireDate: new Date("2020-01-01"),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2020-01-01"),
      },
    });
    return { user, employee };
  }

  async function seedVacationRow(employeeId: string, year: number, totalDays = 30) {
    return app.prisma.leaveEntitlement.create({
      data: { employeeId, leaveTypeId: vacationTypeId, year, totalDays, usedDays: 0 },
    });
  }

  async function createApprovedParental(employeeId: string, start: string, end: string) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: parentalTypeId,
        startDate: new Date(start),
        endDate: new Date(end),
        days: 0,
        status: "APPROVED",
        reviewedBy: "system",
        reviewedAt: new Date(),
      },
    });
  }

  async function commitReduction(leaveRequestId: string, declaredAt: string, years: number[]) {
    return app.inject({
      method: "POST",
      url: `/api/v1/leave/parental-reductions/${leaveRequestId}`,
      headers: { authorization: `Bearer ${data.adminToken}`, "content-type": "application/json" },
      payload: JSON.stringify({ declaredAt, years }),
    });
  }

  async function revokeReduction(leaveRequestId: string, year: number, reason: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/leave/parental-reductions/${leaveRequestId}/revoke`,
      headers: { authorization: `Bearer ${data.adminToken}`, "content-type": "application/json" },
      payload: JSON.stringify({ year, reason }),
    });
  }

  async function correctRequest(id: string, body: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/correct`,
      headers: { authorization: `Bearer ${data.adminToken}`, "content-type": "application/json" },
      // correctSchema requires `reason` (mandatory Korrektur-Begründung) — a shared default,
      // overridable per call, keeps every call site below focused on what it actually varies.
      payload: JSON.stringify({ reason: "Korrektur Test #468", ...body }),
    });
  }

  async function reviewRequest(id: string, body: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}`, "content-type": "application/json" },
      payload: JSON.stringify(body),
    });
  }

  async function putVacation(employeeId: string, body: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/api/v1/settings/vacation/${employeeId}`,
      headers: { authorization: `Bearer ${data.adminToken}`, "content-type": "application/json" },
      payload: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "plc468");
    vacationTypeId = data.vacationType.id;
    const parentalType = await app.prisma.leaveType.create({
      data: {
        tenantId: data.tenant.id,
        code: "PARENTAL",
        name: "Elternzeit",
        isPaid: false,
        requiresApproval: true,
      },
    });
    parentalTypeId = parentalType.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── Task 1 (D-10): /correct guard ─────────────────────────────────────────────────────────
  describe("PATCH /requests/:id/correct — revoke before changing a reduced year's full months", () => {
    let employeeA: string;
    let requestA: { id: string };

    it("shortening the Elternzeit so a reduced year's full-month count changes -> 409, no write (RED: 200)", async () => {
      const { employee } = await createFixedEmployee("a");
      employeeA = employee.id;
      await seedVacationRow(employeeA, 2026);
      requestA = await createApprovedParental(employeeA, "2026-09-15", "2027-04-10");

      const commit = await commitReduction(requestA.id, "2020-01-01", [2026]);
      expect(commit.statusCode).toBe(201);

      const res = await correctRequest(requestA.id, {
        startDate: "2026-09-15",
        endDate: "2026-11-20",
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toContain("Kürzung");
      expect(body.error).toContain("2026");
      expect(body.error).toContain("widerrufen");

      // No partial write: the request's own dates, the entitlement, and the reduction are
      // byte-identical to before the (rejected) correction attempt.
      const storedRequest = await app.prisma.leaveRequest.findUniqueOrThrow({
        where: { id: requestA.id },
      });
      expect(storedRequest.startDate.toISOString().slice(0, 10)).toBe("2026-09-15");
      expect(storedRequest.endDate.toISOString().slice(0, 10)).toBe("2027-04-10");
      expect(storedRequest.status).toBe("APPROVED");

      const entitlement2026 = await app.prisma.leaveEntitlement.findUniqueOrThrow({
        where: {
          employeeId_leaveTypeId_year: {
            employeeId: employeeA,
            leaveTypeId: vacationTypeId,
            year: 2026,
          },
        },
      });
      expect(Number(entitlement2026.totalDays)).toBe(23);

      const reduction = await app.prisma.parentalLeaveReduction.findFirstOrThrow({
        where: { leaveRequestId: requestA.id, year: 2026 },
      });
      expect(reduction.status).toBe("ACTIVE");
    });

    it("a correction that keeps the reduced year's full-month count unchanged -> 200", async () => {
      // Same employee/request as the test above: the rejected correction left it untouched, so
      // the original 2026-09-15..2027-04-10 range (3 full months in 2026) is still live.
      const res = await correctRequest(requestA.id, {
        startDate: "2026-09-20",
        endDate: "2027-04-10",
      });
      expect(res.statusCode).toBe(200);

      const reduction = await app.prisma.parentalLeaveReduction.findFirstOrThrow({
        where: { leaveRequestId: requestA.id, year: 2026 },
      });
      expect(reduction.status).toBe("ACTIVE");
      expect(reduction.months).toBe(3);
    });

    it("a type change away from PARENTAL while an ACTIVE reduction exists -> 409", async () => {
      const { employee } = await createFixedEmployee("c");
      await seedVacationRow(employee.id, 2026);
      const request = await createApprovedParental(employee.id, "2026-02-01", "2026-04-30");
      const commit = await commitReduction(request.id, "2020-01-01", [2026]);
      expect(commit.statusCode).toBe(201);

      const res = await correctRequest(request.id, {
        startDate: "2026-02-01",
        endDate: "2026-04-30",
        type: "SICK",
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toContain("Kürzung");
      expect(body.error).toContain("widerrufen");

      const stored = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(stored.leaveTypeId).toBe(parentalTypeId);
    });

    it("control: correcting an UNREDUCED PARENTAL request (no ACTIVE reduction) stays 200", async () => {
      const { employee } = await createFixedEmployee("e");
      const request = await createApprovedParental(employee.id, "2026-01-05", "2026-01-20");

      const res = await correctRequest(request.id, {
        startDate: "2026-01-05",
        endDate: "2026-01-16",
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // ── Task 1 (D-10): cancellation-approval guard ────────────────────────────────────────────
  describe("PATCH /requests/:id/review — cancellation approval of a PARENTAL request with an ACTIVE reduction", () => {
    it("CANCELLATION_REQUESTED -> APPROVED is blocked while a reduction is ACTIVE -> 409 (RED: 200 CANCELLED); after revoke -> 200", async () => {
      const { user, employee } = await createFixedEmployee("d");
      await seedVacationRow(employee.id, 2026);
      const request = await createApprovedParental(employee.id, "2026-06-01", "2026-08-31");
      const commit = await commitReduction(request.id, "2020-01-01", [2026]);
      expect(commit.statusCode).toBe(201);

      // Move to CANCELLATION_REQUESTED directly (same idiom as
      // leave-closed-month-guard.test.ts): reviewedBy MUST be null or the 4-eyes
      // original-approver check would mask this guard; cancellationRequestedBy is the
      // employee's own user, never the admin approving below.
      await app.prisma.leaveRequest.update({
        where: { id: request.id },
        data: {
          status: "CANCELLATION_REQUESTED",
          reviewedBy: null,
          cancellationRequestedBy: user.id,
        },
      });

      const blocked = await reviewRequest(request.id, { status: "APPROVED" });
      expect(blocked.statusCode).toBe(409);
      const blockedBody = JSON.parse(blocked.body) as { error: string };
      expect(blockedBody.error).toContain("Kürzung");
      expect(blockedBody.error).toContain("widerrufen");

      const stillPending = await app.prisma.leaveRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(stillPending.status).toBe("CANCELLATION_REQUESTED");

      const revoke = await revokeReduction(request.id, 2026, "Erklärung zurückgenommen");
      expect(revoke.statusCode).toBe(200);

      const approved = await reviewRequest(request.id, { status: "APPROVED" });
      expect(approved.statusCode).toBe(200);
      const cancelled = await app.prisma.leaveRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(cancelled.status).toBe("CANCELLED");
    });
  });

  // ── Task 2 (D-07/D-09): PUT /settings/vacation reduced floor ──────────────────────────────
  describe("PUT /settings/vacation/:employeeId — the reduced statutory floor for a reduced year", () => {
    let employeeF: string;

    it("ACTIVE 2027 reduction of 6 months (row 30 -> 15): totalDays=12 -> 200 (reduced floor 10) (RED: 400 below 20)", async () => {
      const { employee } = await createFixedEmployee("f");
      employeeF = employee.id;
      await seedVacationRow(employeeF, 2026);
      await seedVacationRow(employeeF, 2027);
      const request = await createApprovedParental(employeeF, "2027-01-01", "2027-06-30");
      const commit = await commitReduction(request.id, "2020-01-01", [2027]);
      expect(commit.statusCode).toBe(201);

      const row2027Before = await app.prisma.leaveEntitlement.findUniqueOrThrow({
        where: {
          employeeId_leaveTypeId_year: {
            employeeId: employeeF,
            leaveTypeId: vacationTypeId,
            year: 2027,
          },
        },
      });
      expect(Number(row2027Before.totalDays)).toBe(15);

      const res = await putVacation(employeeF, { year: 2027, totalDays: 12 });
      expect(res.statusCode).toBe(200);
    });

    it("the same reduced year: totalDays=9 -> 400, message built from the reduced floor (10, not 20)", async () => {
      const res = await putVacation(employeeF, { year: 2027, totalDays: 9 });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toContain("10 Tagen");
      expect(body.error).not.toContain("20 Tagen");
    });

    it("control: the same employee's UNREDUCED 2026 year still rejects below the unreduced floor (20)", async () => {
      const res = await putVacation(employeeF, { year: 2026, totalDays: 15 });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toContain("20 Tagen");
    });
  });
});
