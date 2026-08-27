/**
 * leave-provisional-readside.test.ts
 *
 * Phase 107 Plan 07 — integration coverage for the READ side of D-12/D-13/D-19/D-20/D-21:
 * `provisionalUsedDays` on `GET /entitlements/:employeeId` and `lastDaysAdjustment` (plus the
 * already-scalar `daysProvisional`) on `GET /requests`.
 *
 * Everything these two fields expose was already PERSISTED by Plans 04/05 — `daysProvisional`
 * is set at approval time, `LEAVE_DAYS_ADJUSTED` audit rows are written by the roster-triggered
 * recompute (`shift-leave-recalc-resolver.ts`). This suite therefore seeds `LeaveRequest`/
 * `AuditLog` rows DIRECTLY via Prisma rather than driving the full approval/roster-recompute
 * flow — that machinery is already covered by `leave-provisional-approval.test.ts` and
 * `shift-leave-recalc.test.ts`. This file is READ-side only and needs no SHIFT_BASED
 * `WorkSchedule` or any roster at all: `daysProvisional` and the audit trail are read exactly
 * as stored, independent of schedule type.
 *
 * Also pins the CONTRACT between Plan 05's audit payload shape —
 * `oldValue: { days, daysProvisional }`, `newValue: { days, daysProvisional, trigger }` (see
 * `shift-leave-recalc-resolver.ts`'s own `deps.audit(...)` call) — and this plan's reader: if
 * that shape ever changes, THIS suite goes red rather than the badge silently going blank in
 * the browser.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

// Derived once, `currentYear`-relative (never a fixed calendar year) — see seedTestData's own
// `LeaveEntitlement.year` derivation, which this suite must agree with. Every date built from
// this is a literal, directly-set `LeaveRequest.startDate`/`endDate` — never validated against
// "today" by any code path this suite exercises (no approval flow, no resolver guard chain is
// invoked), so unlike a hardcoded-date fixture this cannot expire.
const CURRENT_YEAR = new Date().getFullYear();

/**
 * Minimal extra employee + a VACATION LeaveEntitlement for `CURRENT_YEAR`. No `WorkSchedule`,
 * no `OvertimeAccount` — this suite is read-side only and neither GET endpoint under test
 * touches either model.
 */
async function makeEmployeeWithEntitlement(
  app: FastifyInstance,
  tenantId: string,
  vacationTypeId: string,
  label: string,
) {
  const suffix = `lpr-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const user = await app.prisma.user.create({
    data: { email: `${suffix}@test.de`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
  });
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: suffix.slice(0, 20).toUpperCase(),
      firstName: "LPR",
      lastName: label,
      hireDate: new Date(`${CURRENT_YEAR}-01-01`),
    },
  });
  await app.prisma.leaveEntitlement.create({
    data: {
      employeeId: employee.id,
      leaveTypeId: vacationTypeId,
      year: CURRENT_YEAR,
      totalDays: 30,
      usedDays: 0,
    },
  });
  return employee;
}

describe("Leave provisional read side — GET /entitlements + GET /requests (Phase 107 Plan 07)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "lpr");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("leave-provisional-readside cleanup failed:", err);
    }
    await closeTestApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("GET /entitlements/:employeeId — provisionalUsedDays (D-12/D-13)", () => {
    it("sums provisional days separately while usedDays keeps counting them at full value (D-13)", async () => {
      const emp = await makeEmployeeWithEntitlement(
        app,
        data.tenant.id,
        data.vacationType.id,
        "d13",
      );
      await app.prisma.leaveRequest.create({
        data: {
          employeeId: emp.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date(`${CURRENT_YEAR}-02-02`),
          endDate: new Date(`${CURRENT_YEAR}-02-04`),
          days: 3,
          halfDay: false,
          status: "APPROVED",
          daysProvisional: true,
        },
      });
      await app.prisma.leaveRequest.create({
        data: {
          employeeId: emp.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date(`${CURRENT_YEAR}-03-02`),
          endDate: new Date(`${CURRENT_YEAR}-03-03`),
          days: 2,
          halfDay: false,
          status: "APPROVED",
          daysProvisional: false,
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/leave/entitlements/${emp.id}?year=${CURRENT_YEAR}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Array<Record<string, unknown>>;
      const vac = body.find((r) => r.typeCode === "VACATION");
      expect(vac).toBeDefined();
      expect(vac!.provisionalUsedDays).toBe(3);
      expect(Number(vac!.usedDays)).toBe(5); // 3 provisional + 2 confirmed — full value (D-13)
    });

    it("returns provisionalUsedDays: 0 and an otherwise unchanged body for an employee with no provisional requests (AC-REG-02)", async () => {
      const emp = await makeEmployeeWithEntitlement(
        app,
        data.tenant.id,
        data.vacationType.id,
        "reg02",
      );

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/leave/entitlements/${emp.id}?year=${CURRENT_YEAR}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Array<Record<string, unknown>>;
      const vac = body.find((r) => r.typeCode === "VACATION");
      expect(vac).toBeDefined();
      expect(vac!.provisionalUsedDays).toBe(0);
      // Every pre-existing field keeps its current name and value — nothing renamed/removed.
      expect(Number(vac!.totalDays)).toBe(30);
      expect(Number(vac!.usedDays)).toBe(0);
      expect(vac!.typeCode).toBe("VACATION");
      expect(vac).toHaveProperty("effectiveEntitlementDays");
      expect(vac).toHaveProperty("carryOverDeadline");
      expect(vac).toHaveProperty("section9Movements");
    });

    it("excludes a soft-deleted provisional request from the aggregate", async () => {
      const emp = await makeEmployeeWithEntitlement(
        app,
        data.tenant.id,
        data.vacationType.id,
        "softdel",
      );
      await app.prisma.leaveRequest.create({
        data: {
          employeeId: emp.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date(`${CURRENT_YEAR}-02-02`),
          endDate: new Date(`${CURRENT_YEAR}-02-05`),
          days: 4,
          halfDay: false,
          status: "APPROVED",
          daysProvisional: true,
          deletedAt: new Date(),
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/leave/entitlements/${emp.id}?year=${CURRENT_YEAR}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Array<Record<string, unknown>>;
      const vac = body.find((r) => r.typeCode === "VACATION");
      expect(vac!.provisionalUsedDays).toBe(0);
      expect(Number(vac!.usedDays)).toBe(0); // selfHealUsedDays also excludes it (pre-existing)
    });
  });

  describe("GET /requests — daysProvisional + lastDaysAdjustment (D-12/D-19/D-20/D-21)", () => {
    it("reports lastDaysAdjustment: null for a request that was never adjusted", async () => {
      const emp = await makeEmployeeWithEntitlement(
        app,
        data.tenant.id,
        data.vacationType.id,
        "never",
      );
      const req = await app.prisma.leaveRequest.create({
        data: {
          employeeId: emp.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date(`${CURRENT_YEAR}-02-02`),
          endDate: new Date(`${CURRENT_YEAR}-02-03`),
          days: 2,
          halfDay: false,
          status: "APPROVED",
          daysProvisional: true,
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/leave/requests?year=${CURRENT_YEAR}&employeeId=${emp.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Array<Record<string, unknown>>;
      const row = body.find((r) => r.id === req.id);
      expect(row).toBeDefined();
      expect(row!.daysProvisional).toBe(true);
      expect(row!.lastDaysAdjustment).toBeNull();
    });

    it("reports only the latest of two LEAVE_DAYS_ADJUSTED audit rows for the same request (down direction)", async () => {
      const emp = await makeEmployeeWithEntitlement(
        app,
        data.tenant.id,
        data.vacationType.id,
        "twice",
      );
      const req = await app.prisma.leaveRequest.create({
        data: {
          employeeId: emp.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date(`${CURRENT_YEAR}-02-02`),
          endDate: new Date(`${CURRENT_YEAR}-02-06`),
          days: 3,
          halfDay: false,
          status: "APPROVED",
          daysProvisional: true,
        },
      });

      // Exact JSON shape shift-leave-recalc-resolver.ts writes (107-05-SUMMARY.md) — pins the
      // writer/reader contract. Both timestamps are fixed offsets INTO THE PAST from "now" (not
      // calendar literals), so ordering is deterministic regardless of when this suite runs.
      const olderAt = new Date(Date.now() - 2 * 60_000);
      const newerAt = new Date(Date.now() - 60_000);
      await app.prisma.auditLog.create({
        data: {
          userId: data.adminUser.id,
          action: "LEAVE_DAYS_ADJUSTED",
          entity: "LeaveRequest",
          entityId: req.id,
          oldValue: { days: 5, daysProvisional: true },
          newValue: { days: 4, daysProvisional: true, trigger: "Roster-Planung" },
          createdAt: olderAt,
        },
      });
      await app.prisma.auditLog.create({
        data: {
          userId: data.adminUser.id,
          action: "LEAVE_DAYS_ADJUSTED",
          entity: "LeaveRequest",
          entityId: req.id,
          oldValue: { days: 4, daysProvisional: true },
          newValue: { days: 3, daysProvisional: true, trigger: "Roster-Planung" },
          createdAt: newerAt,
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/leave/requests?year=${CURRENT_YEAR}&employeeId=${emp.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Array<Record<string, unknown>>;
      const row = body.find((r) => r.id === req.id);
      expect(row!.lastDaysAdjustment).toEqual({
        oldDays: 4,
        newDays: 3,
        direction: "down",
        at: newerAt.toISOString(),
      });
    });

    it("reports the upward direction when newDays > oldDays", async () => {
      const emp = await makeEmployeeWithEntitlement(
        app,
        data.tenant.id,
        data.vacationType.id,
        "up",
      );
      const req = await app.prisma.leaveRequest.create({
        data: {
          employeeId: emp.id,
          leaveTypeId: data.vacationType.id,
          startDate: new Date(`${CURRENT_YEAR}-02-02`),
          endDate: new Date(`${CURRENT_YEAR}-02-03`),
          days: 2,
          halfDay: false,
          status: "APPROVED",
          daysProvisional: false,
        },
      });
      const at = new Date(Date.now() - 60_000);
      await app.prisma.auditLog.create({
        data: {
          userId: data.adminUser.id,
          action: "LEAVE_DAYS_ADJUSTED",
          entity: "LeaveRequest",
          entityId: req.id,
          oldValue: { days: 1, daysProvisional: true },
          newValue: { days: 2, daysProvisional: false, trigger: "Roster-Planung" },
          createdAt: at,
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/leave/requests?year=${CURRENT_YEAR}&employeeId=${emp.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Array<Record<string, unknown>>;
      const row = body.find((r) => r.id === req.id);
      expect(row!.lastDaysAdjustment).toEqual({
        oldDays: 1,
        newDays: 2,
        direction: "up",
        at: at.toISOString(),
      });
    });

    it("runs the audit lookup ONCE per response regardless of how many adjusted requests are in it (no N+1, T-107-32)", async () => {
      const emp = await makeEmployeeWithEntitlement(
        app,
        data.tenant.id,
        data.vacationType.id,
        "n1",
      );
      const requests: { id: string }[] = [];
      for (let i = 0; i < 4; i++) {
        const req = await app.prisma.leaveRequest.create({
          data: {
            employeeId: emp.id,
            leaveTypeId: data.vacationType.id,
            startDate: new Date(`${CURRENT_YEAR}-0${i + 2}-02`),
            endDate: new Date(`${CURRENT_YEAR}-0${i + 2}-03`),
            days: 2,
            halfDay: false,
            status: "APPROVED",
            daysProvisional: true,
          },
        });
        requests.push(req);
        await app.prisma.auditLog.create({
          data: {
            userId: data.adminUser.id,
            action: "LEAVE_DAYS_ADJUSTED",
            entity: "LeaveRequest",
            entityId: req.id,
            oldValue: { days: 3, daysProvisional: true },
            newValue: { days: 2, daysProvisional: true, trigger: "Roster-Planung" },
            createdAt: new Date(Date.now() - 60_000),
          },
        });
      }

      const auditSpy = vi.spyOn(app.prisma.auditLog, "findMany");

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/leave/requests?year=${CURRENT_YEAR}&employeeId=${emp.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      // ONE bulk call for the whole response — not one per adjusted request (N=4 here).
      expect(auditSpy.mock.calls.length).toBeLessThanOrEqual(1);

      const body = JSON.parse(res.body) as Array<Record<string, unknown>>;
      for (const req of requests) {
        const row = body.find((r) => r.id === req.id);
        expect(row).toBeDefined();
        expect(row!.lastDaysAdjustment).not.toBeNull();
        expect((row!.lastDaysAdjustment as { newDays: number }).newDays).toBe(2);
      }
    });

    it("costs zero auditLog queries for an empty leave list", async () => {
      const emp = await makeEmployeeWithEntitlement(
        app,
        data.tenant.id,
        data.vacationType.id,
        "empty",
      );
      const auditSpy = vi.spyOn(app.prisma.auditLog, "findMany");

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/leave/requests?year=${CURRENT_YEAR}&employeeId=${emp.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
      expect(auditSpy).not.toHaveBeenCalled();
    });
  });
});
