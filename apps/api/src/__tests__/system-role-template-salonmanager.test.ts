/**
 * Phase 76b Plan 06 (Issue #76), AK-76b-5 — proves the SHIPPED Salonmanager template bundle
 * (`SYSTEM_ROLE_IDS.SALON_MANAGER`, migrated in Plan 76b-01) against real routes: #91 salon-scope
 * rules apply to time entries, leave requests and shifts, and NO saldo is reachable anywhere — not
 * per-employee (`GET /:id`, `/snapshots/:id`, `/month-saldo/:id`), not on the two dashboard
 * aggregates gated in Plan 76b-03 (D-06/D-15), not in the monthly report, not on month-close, not
 * via correcting an approved leave — even for a Stammsalon-A colleague of the salon manager's own
 * salon. Also proves the recommended real-world combination (template + Mitarbeiter) reads only
 * the holder's own saldo, never a colleague's, and still fails the dashboard's AND-gate.
 *
 * D-05/D-12 anti-pattern (mirrors 76b-04/76b-05's own note): the role assignment below points at
 * the REAL `SYSTEM_ROLE_IDS.SALON_MANAGER` row, never an ad-hoc custom `AccessRole` — the point is
 * proving the shipped bundle, not a hand-picked permission set.
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { SYSTEM_ROLE_IDS, type SystemRoleSlot } from "../contexts/platform";

const PASSWORD = "test1234";

// Mutation-proof lever (Task 1's <action> sets this to "HR", Task 2's <action> sets this to
// "OWNER"): flipping this single constant must make the corresponding saldo-403 case(s) fail —
// that is the mutation proof itself, run and restored during execution, quoted in the SUMMARY,
// never left flipped in the committed file.
const TEMPLATE_SLOT: SystemRoleSlot = "SALON_MANAGER";

// Fixed fixture window, inside 2026, well away from month boundaries — so the 90-day default
// window used elsewhere in the suite never matters here (Task 1 <action>).
const WINDOW_FROM = "2026-07-01";
const WINDOW_TO = "2026-07-31";
const X_ENTRY_DATE = "2026-07-05";
const Y_ENTRY_DATE = "2026-07-06";
const Z_ENTRY_DATE = "2026-07-07"; // Z worked in salon A although Z's Stammsalon is B
const X_PENDING_LEAVE_START = "2026-07-10";
const X_PENDING_LEAVE_END = "2026-07-10";
const X_APPROVED_LEAVE_START = "2026-07-15";
const X_APPROVED_LEAVE_END = "2026-07-15";
const Y_PENDING_LEAVE_START = "2026-07-11";
const Y_PENDING_LEAVE_END = "2026-07-11";
const X_SHIFT_A_DATE = "2026-07-20";
const X_SHIFT_B_DATE = "2026-07-21";
const YEAR = 2026;
const MONTH = 7;

const NONEXISTENT_EMPLOYEE_ID = "00000000-0000-4000-8000-000000000001";

describe("Issue #76 (Phase 76b Plan 06), AK-76b-5 — Salonmanager behavioural matrix", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createEmployee(label: string) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "SalonManagerScopeTest",
        hireDate: new Date("2024-01-01"),
      },
    });
    return { user, employee };
  }

  function createHome(employeeId: string, salonId: string) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
  }

  function createEntry(employeeId: string, salonId: string, date: string) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: new Date(date),
        startTime: new Date(`${date}T08:00:00Z`),
        endTime: new Date(`${date}T16:00:00Z`),
        source: "MANUAL",
      },
    });
  }

  function createShift(employeeId: string, salonId: string, date: string) {
    return app.prisma.shift.create({
      data: {
        employeeId,
        salonId,
        date: new Date(date),
        startTime: "08:00",
        endTime: "16:00",
      },
    });
  }

  function createLeaveRequest(
    employeeId: string,
    startDate: string,
    endDate: string,
    status: "PENDING" | "APPROVED",
  ) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        days: 1,
        status,
      },
    });
  }

  /**
   * Assigns a REAL system-role slot (never an ad-hoc AccessRole) to `userId`. Defaults to the
   * SALONS scope this plan proves (D-05's own intended scope for Salonmanager).
   */
  function assignSystemRole(
    userId: string,
    slot: SystemRoleSlot,
    scope: {
      scopeType?: "TENANT" | "SALONS" | "PERSONS";
      salonIds?: string[];
      employeeIds?: string[];
    } = {},
  ) {
    return app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId,
        accessRoleId: SYSTEM_ROLE_IDS[slot],
        scopeType: scope.scopeType ?? "SALONS",
        salonIds: scope.salonIds ?? [],
        employeeIds: scope.employeeIds ?? [],
      },
    });
  }

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  let x: Awaited<ReturnType<typeof createEmployee>>;
  let y: Awaited<ReturnType<typeof createEmployee>>;
  let z: Awaited<ReturnType<typeof createEmployee>>;
  let s: Awaited<ReturnType<typeof createEmployee>>;
  let sToken: string;
  let xEntry: { id: string };
  let zEntry: { id: string };

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "sprsm");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "SPRSM Salon A" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "SPRSM Salon B" });

    // X: Stammsalon A, one entry in A, OvertimeAccount.
    x = await createEmployee("salonmgr-x");
    await createHome(x.employee.id, salonA.id);
    xEntry = await createEntry(x.employee.id, salonA.id, X_ENTRY_DATE);
    await app.prisma.overtimeAccount.create({
      data: { employeeId: x.employee.id, balanceHours: 2 },
    });

    // Y: Stammsalon B, one entry in B, OvertimeAccount.
    y = await createEmployee("salonmgr-y");
    await createHome(y.employee.id, salonB.id);
    await createEntry(y.employee.id, salonB.id, Y_ENTRY_DATE);
    await app.prisma.overtimeAccount.create({
      data: { employeeId: y.employee.id, balanceHours: 1 },
    });

    // Z: Stammsalon B, but worked in salon A on Z_ENTRY_DATE (entry-salon rule, #91 D-09).
    z = await createEmployee("salonmgr-z");
    await createHome(z.employee.id, salonB.id);
    zEntry = await createEntry(z.employee.id, salonA.id, Z_ENTRY_DATE);

    // S: the salon manager, SALONS scope [A], on the real template.
    s = await createEmployee("salonmgr-s");
    await assignSystemRole(s.user.id, TEMPLATE_SLOT, {
      scopeType: "SALONS",
      salonIds: [salonA.id],
    });
    sToken = await login(s.user.email);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("Task 1 (tracer): #91 salon scope for time entries; saldo 403 even for a Stammsalon-A employee", () => {
    // Queried per-employeeId (not the unfiltered list): 76b-05-SUMMARY.md documented that GET
    // /time-entries without ?employeeId falls back to the CALLER's own employeeId
    // (time-entries.ts:1017), ignoring the manager's scope entirely — a pre-existing, already
    // recorded finding unrelated to this template. Every *-salon-scope.test.ts fixture (Stammsalon
    // and entry-salon rules alike) exercises the route the same way, via an explicit employeeId.
    it("GET /time-entries?employeeId=<X> → 200 with X's entry (Stammsalon A match)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?employeeId=${x.employee.id}&from=${WINDOW_FROM}&to=${WINDOW_TO}`,
        headers: { authorization: `Bearer ${sToken}` },
      });
      expect(res.statusCode).toBe(200);
      const ids = (JSON.parse(res.body) as Array<{ id: string }>).map((e) => e.id);
      expect(ids).toContain(xEntry.id);
    });

    it("GET /time-entries?employeeId=<Z> → 200 with Z's A-entry (entry salon A, although Z's Stammsalon is B)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?employeeId=${z.employee.id}&from=${WINDOW_FROM}&to=${WINDOW_TO}`,
        headers: { authorization: `Bearer ${sToken}` },
      });
      expect(res.statusCode).toBe(200);
      const ids = (JSON.parse(res.body) as Array<{ id: string }>).map((e) => e.id);
      expect(ids).toContain(zEntry.id);
    });

    it("GET /time-entries?employeeId=<Y> → 200 [] (Stammsalon B, entry in B — out of scope)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/time-entries?employeeId=${y.employee.id}&from=${WINDOW_FROM}&to=${WINDOW_TO}`,
        headers: { authorization: `Bearer ${sToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    });

    it("GET /overtime/<X> → 403, although X's Stammsalon is A and X is fully in S's salon scope", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${x.employee.id}`,
        headers: { authorization: `Bearer ${sToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("GET /overtime/<Y> → 403", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${y.employee.id}`,
        headers: { authorization: `Bearer ${sToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("control: the tenant admin's identical request to GET /overtime/<X> still answers 200", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${x.employee.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("Task 2: leave/shifts/master data per scope; every saldo, month-close and correction surface 403", () => {
    let xPendingLeave: { id: string };
    let yPendingLeave: { id: string };
    let xApprovedLeave: { id: string };
    let xShiftA: { id: string };
    let xShiftB: { id: string };

    beforeAll(async () => {
      xPendingLeave = await createLeaveRequest(
        x.employee.id,
        X_PENDING_LEAVE_START,
        X_PENDING_LEAVE_END,
        "PENDING",
      );
      yPendingLeave = await createLeaveRequest(
        y.employee.id,
        Y_PENDING_LEAVE_START,
        Y_PENDING_LEAVE_END,
        "PENDING",
      );
      xApprovedLeave = await createLeaveRequest(
        x.employee.id,
        X_APPROVED_LEAVE_START,
        X_APPROVED_LEAVE_END,
        "APPROVED",
      );
      xShiftA = await createShift(x.employee.id, salonA.id, X_SHIFT_A_DATE);
      xShiftB = await createShift(x.employee.id, salonB.id, X_SHIFT_B_DATE);
      void yPendingLeave;
      void xShiftB;
    });

    it("GET /leave/requests → 200 contains X's PENDING request, not Y's", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${sToken}` },
      });
      expect(res.statusCode).toBe(200);
      const ids = (JSON.parse(res.body) as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toContain(xPendingLeave.id);
      expect(ids).not.toContain(yPendingLeave.id);
    });

    it("GET /shifts/range?employeeId=<X> → 200 contains X's shift in A, not X's shift in B (shift-own-salon rule, 91b D-11)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/range?from=${WINDOW_FROM}&to=${WINDOW_TO}&employeeId=${x.employee.id}`,
        headers: { authorization: `Bearer ${sToken}` },
      });
      expect(res.statusCode).toBe(200);
      const dates = (JSON.parse(res.body) as Array<{ date: string }>).map((r) => r.date);
      expect(dates).toContain(X_SHIFT_A_DATE);
      expect(dates).not.toContain(X_SHIFT_B_DATE);
      void xShiftA;
    });

    it("GET /employees/<X> → 200", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${x.employee.id}`,
        headers: { authorization: `Bearer ${sToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it("GET /employees/<Y> is byte-identical to a nonexistent id (T-100-09)", async () => {
      const yRes = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${y.employee.id}`,
        headers: { authorization: `Bearer ${sToken}` },
      });
      const nonexistentRes = await app.inject({
        method: "GET",
        url: `/api/v1/employees/${NONEXISTENT_EMPLOYEE_ID}`,
        headers: { authorization: `Bearer ${sToken}` },
      });
      expect(yRes.statusCode).toBe(nonexistentRes.statusCode);
      expect(yRes.body).toBe(nonexistentRes.body);
      expect(yRes.statusCode).toBe(404);
    });

    it("GET /overtime/snapshots/<X> → 403", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/snapshots/${x.employee.id}`,
        headers: { authorization: `Bearer ${sToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("GET /overtime/month-saldo/<X>?year&month → 403", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/month-saldo/${x.employee.id}?year=${YEAR}&month=${MONTH}`,
        headers: { authorization: `Bearer ${sToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("GET /dashboard/overtime-overview → 403 (D-06; control: admin 200)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/overtime-overview",
        headers: { authorization: `Bearer ${sToken}` },
      });
      expect(res.statusCode).toBe(403);

      const controlRes = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/overtime-overview",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(controlRes.statusCode).toBe(200);
    });

    it("GET /dashboard/overtime-trend → 403 (D-15; control: admin 200)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/overtime-trend",
        headers: { authorization: `Bearer ${sToken}` },
      });
      expect(res.statusCode).toBe(403);

      const controlRes = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/overtime-trend",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(controlRes.statusCode).toBe(200);
    });

    it("GET /dashboard/ → 200 with overtime:null and vacation:null (CR-01/WR-01, code review; control: admin gets both non-null)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/",
        headers: { authorization: `Bearer ${sToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { overtime: unknown; vacation: unknown };
      // A bare Salonmanager (no Mitarbeiter) holds neither overtime:read:EIGENE nor
      // leave-entitlement:read:EIGENE (D-05) — the route must degrade both sections to null
      // rather than leaking S's own saldo/vacation, contradicting AK-76b-5.
      expect(body.overtime).toBeNull();
      expect(body.vacation).toBeNull();

      const controlRes = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/",
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(controlRes.statusCode).toBe(200);
      const controlBody = JSON.parse(controlRes.body) as { overtime: unknown; vacation: unknown };
      expect(controlBody.overtime).not.toBeNull();
      expect(controlBody.vacation).not.toBeNull();
    });

    it("GET /reports/monthly?employeeId=<X>&year&month → 403 (report:* excluded, D-05)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/monthly?employeeId=${x.employee.id}&year=${YEAR}&month=${MONTH}`,
        headers: { authorization: `Bearer ${sToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("GET /overtime/close-month/status?year&month → 403 (month-close:* excluded, D-05)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/close-month/status?year=${YEAR}&month=${MONTH}`,
        headers: { authorization: `Bearer ${sToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("POST /overtime/close-month → 403 (minimal valid body)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/overtime/close-month",
        headers: { authorization: `Bearer ${sToken}` },
        payload: { employeeId: x.employee.id, year: YEAR, month: MONTH },
      });
      expect(res.statusCode).toBe(403);
    });

    it("PATCH /leave/requests/<X approved>/correct → 403 (leave-request:correct excluded, D-05; minimal valid body)", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${xApprovedLeave.id}/correct`,
        headers: { authorization: `Bearer ${sToken}` },
        payload: {
          startDate: X_APPROVED_LEAVE_START,
          endDate: X_APPROVED_LEAVE_END,
          reason: "Testkorrektur AK-76b-5",
        },
      });
      expect(res.statusCode).toBe(403);
    });

    describe("working salon manager (template + Mitarbeiter at TENANT) — own saldo only, never a colleague's (T-76b-23)", () => {
      let s2: Awaited<ReturnType<typeof createEmployee>>;
      let s2Token: string;

      beforeAll(async () => {
        s2 = await createEmployee("salonmgr-s2");
        await assignSystemRole(s2.user.id, TEMPLATE_SLOT, {
          scopeType: "SALONS",
          salonIds: [salonA.id],
        });
        await assignSystemRole(s2.user.id, "EMPLOYEE", { scopeType: "TENANT" });
        await app.prisma.overtimeAccount.create({
          data: { employeeId: s2.employee.id, balanceHours: 0 },
        });
        s2Token = await login(s2.user.email);
      });

      it("GET /overtime/<S2's own employee> → 200 (EIGENE self-path via Mitarbeiter)", async () => {
        const res = await app.inject({
          method: "GET",
          url: `/api/v1/overtime/${s2.employee.id}`,
          headers: { authorization: `Bearer ${s2Token}` },
        });
        expect(res.statusCode).toBe(200);
      });

      it("GET /overtime/<X> → 403 (Mitarbeiter does not reopen a colleague's saldo)", async () => {
        const res = await app.inject({
          method: "GET",
          url: `/api/v1/overtime/${x.employee.id}`,
          headers: { authorization: `Bearer ${s2Token}` },
        });
        expect(res.statusCode).toBe(403);
      });

      it("GET /dashboard/overtime-overview → 403 (AND-gate: overtime:read:EIGENE does not satisfy the :ZUGEWIESEN gate)", async () => {
        const res = await app.inject({
          method: "GET",
          url: "/api/v1/dashboard/overtime-overview",
          headers: { authorization: `Bearer ${s2Token}` },
        });
        expect(res.statusCode).toBe(403);
      });

      it("GET /dashboard/ → 200 with overtime and vacation both non-null (CR-01/WR-01, code review; Mitarbeiter grants EIGENE)", async () => {
        const res = await app.inject({
          method: "GET",
          url: "/api/v1/dashboard/",
          headers: { authorization: `Bearer ${s2Token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { overtime: unknown; vacation: unknown };
        // S2 additionally holds the Mitarbeiter system role at TENANT scope, which carries
        // overtime:read:EIGENE and leave-entitlement:read:EIGENE — both sections must be
        // populated (S2's OWN data only, per the sibling "own saldo only" tests above).
        expect(body.overtime).not.toBeNull();
        expect(body.vacation).not.toBeNull();
      });
    });
  });
});
