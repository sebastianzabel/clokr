/**
 * Issue #835 (AC-1, AC-2, AC-7, AC-9; D-835-01/06/08/13) — the TRACER of the leave planner: open a
 * plan, add a wish, take it over. One path through every layer (route, wish write, takeover, the
 * two leave cores, the audit), against the real database.
 *
 * Fixture (fake clock 2026-11-10, installed BEFORE the app boots; plan year 2027): tenant one with
 * its default salon S, tenant two with its own salon. Callers are built from custom roles, never
 * from what the seeded admin holds: the taker T (leave-plan:manage + leave-request:approve/read/
 * create), a second approver A2 (approve + read), and the seeded employee B (system role EMPLOYEE),
 * all three homed in S. No person names.
 *
 * Mutation proof (Phase 835-03, 2026-11-06) — recorded here, not re-run by CI; each change was
 * reverted with cp afterwards:
 * M1 takeover.ts: `willApprove` forced to true (the taker also approves the own wish) → red: the
 *    takeover case ("... T's own wish into a PENDING one") and everything that builds on its state
 *    (7 failed | 8 passed).
 * M2 takeover.ts link hook: the `startDate` / `endDate` comparison removed → red: both
 *    "a wish moved ..." cases (2 failed | 13 passed).
 * Not provable here: a plan lookup without the tenant (`findFirst({ id })`) stays green because the
 * tenant-scoped salon admission is a second wall; the lookup itself is held by `lint:tenant-scoping`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  seedEntitlementYears,
  tokenWithoutSignIn,
  soleAuditRow,
  soleNotification,
  auditRowsFor,
} from "./setup";
import { roleNameKey, normalizeRolePermissions } from "../contexts/platform/access-role";

const MANAGE = "leave-plan:manage:ZUGEWIESEN";
const APPROVE = "leave-request:approve:ZUGEWIESEN";
const READ = "leave-request:read:ZUGEWIESEN";
const CREATE_OWN = "leave-request:create:EIGENE";
const PLAN_NOT_FOUND = '{"error":"Urlaubsplanung nicht gefunden"}';
const YEAR = 2027;

// 2027 weekdays (Mon-Fri): 1 March is a Monday, 12 April is a Monday, 7 June is a Monday.
const B_WISH = { startDate: "2027-03-01", endDate: "2027-03-05" };
const T_WISH = { startDate: "2027-04-12", endDate: "2027-04-14" };
const B_PENDING = { startDate: "2027-06-07", endDate: "2027-06-09" };

describe("Issue #835 - leave plan tracer (open -> wish -> takeover)", () => {
  let app: FastifyInstance;
  let one: Awaited<ReturnType<typeof seedTestData>>;
  let two: Awaited<ReturnType<typeof seedTestData>>;
  let takerToken: string;
  let takerUserId: string;
  let takerEmployeeId: string;
  let secondApproverUserId: string;
  let planId: string;
  let bWishId: string;
  let tWishId: string;

  function authed(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async function homeIn(tenantId: string, employeeId: string, salonId: string) {
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date("2024-01-01T00:00:00Z"),
        validUntil: null,
        weekdays: [],
      },
    });
  }

  async function mondayToFridaySchedule(employeeId: string) {
    await app.prisma.workSchedule.create({
      data: {
        employeeId,
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
  }

  /** A user with exactly the given permissions at TENANT scope, an employee homed in S, a 2027 entitlement. */
  async function actor(label: string, permissions: string[]) {
    const email = `${label}-${crypto.randomBytes(3).toString("hex")}@example.invalid`;
    const user = await app.prisma.user.create({
      data: { email, passwordHash: await bcrypt.hash("test1234", 4), isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: one.tenant.id,
        userId: user.id,
        employeeNumber: `P${crypto.randomBytes(4).toString("hex")}`,
        firstName: label,
        lastName: "Plan835",
        hireDate: new Date("2024-01-01"),
      },
    });
    const name = `Plan835 ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: one.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(permissions),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: one.tenant.id,
        userId: user.id,
        accessRoleId: role.id,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    await homeIn(one.tenant.id, employee.id, one.salonId);
    await mondayToFridaySchedule(employee.id);
    await seedEntitlementYears(app, {
      employeeId: employee.id,
      leaveTypeId: one.vacationType.id,
      years: [YEAR],
    });
    return { user, employee, token: await tokenWithoutSignIn(app, email) };
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T10:00:00.000Z"));
    app = await getTestApp();
    one = await seedTestData(app, "lp835a");
    two = await seedTestData(app, "lp835b");

    const taker = await actor("taker", [MANAGE, APPROVE, READ, CREATE_OWN]);
    takerToken = taker.token;
    takerUserId = taker.user.id;
    takerEmployeeId = taker.employee.id;
    secondApproverUserId = (await actor("second", [APPROVE, READ])).user.id;

    // B is the seeded employee (system role EMPLOYEE), homed in S.
    await homeIn(one.tenant.id, one.employee.id, one.salonId);
    await seedEntitlementYears(app, {
      employeeId: one.employee.id,
      leaveTypeId: one.vacationType.id,
      years: [YEAR],
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: one.tenant.id } });
      await cleanupTestData(app, one.tenant.id);
      await cleanupTestData(app, two.tenant.id);
    } catch (err) {
      console.error("leave-plan-tracer-835 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("a holder of leave-plan:manage over S opens a plan for S and next year (201, audited)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/plans",
      headers: authed(takerToken),
      payload: { salonId: one.salonId, year: YEAR, deadline: "2027-01-31" },
    });
    expect(res.statusCode, res.body).toBe(201);
    const { plan } = res.json() as {
      plan: { id: string; salonId: string; year: number; deadline: string; status: string };
    };
    expect(plan).toMatchObject({
      salonId: one.salonId,
      year: YEAR,
      deadline: "2027-01-31",
      status: "OPEN",
    });
    planId = plan.id;

    const audit = await soleAuditRow(app.prisma, {
      where: { entity: "LeavePlan", entityId: planId, action: "CREATE" },
    });
    expect(audit.userId).toBe(takerUserId);
    expect(audit.newValue).toEqual({ salonId: one.salonId, year: YEAR, deadline: "2027-01-31" });
  });

  it("a second open plan for S and the same year is 409 LEAVE_PLAN_ALREADY_OPEN", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/plans",
      headers: authed(takerToken),
      payload: { salonId: one.salonId, year: YEAR },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "LEAVE_PLAN_ALREADY_OPEN" });
  });

  it("an employee homed in S adds an own VACATION wish (201, audited with actor and person)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planId}/wishes`,
      headers: authed(one.empToken),
      payload: B_WISH,
    });
    expect(res.statusCode, res.body).toBe(201);
    const { wish } = res.json() as { wish: Record<string, unknown> };
    expect(wish).toMatchObject({
      planId,
      ...B_WISH,
      halfDay: false,
      leaveRequestId: null,
      editable: true,
    });
    bWishId = wish.id as string;

    const audit = await soleAuditRow(app.prisma, {
      where: { entity: "LeavePlanWish", entityId: bWishId, action: "CREATE" },
    });
    expect(audit.userId).toBe(one.empUser.id);
    expect(audit.newValue).toEqual({
      planId,
      employeeId: one.employee.id,
      startDate: B_WISH.startDate,
      endDate: B_WISH.endDate,
      halfDay: false,
    });
  });

  it("a wish over a PENDING request of the same person is 409 LEAVE_PLAN_WISH_OVERLAP", async () => {
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: one.employee.id,
        leaveTypeId: one.vacationType.id,
        startDate: new Date(`${B_PENDING.startDate}T00:00:00Z`),
        endDate: new Date(`${B_PENDING.endDate}T00:00:00Z`),
        days: 3,
        status: "PENDING",
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planId}/wishes`,
      headers: authed(one.empToken),
      payload: { startDate: "2027-06-08", endDate: "2027-06-10" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "LEAVE_PLAN_WISH_OVERLAP" });
    expect(
      await app.prisma.leavePlanWish.count({ where: { planId, employeeId: one.employee.id } }),
    ).toBe(1);
  });

  it("the taker adds an own wish too", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planId}/wishes`,
      headers: authed(takerToken),
      payload: T_WISH,
    });
    expect(res.statusCode, res.body).toBe(201);
    tWishId = (res.json() as { wish: { id: string } }).wish.id;
  });

  it("a reader of the plan sees the wishes of both persons in the planner shape", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/plans/${planId}`,
      headers: authed(one.empToken),
    });
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as {
      plan: { status: string; year: number; deadlinePassed: boolean };
      viewer: { canManage: boolean; canWishOwn: boolean };
      persons: Array<{ employeeId: string; wishes: Array<{ id: string }>; rows: unknown[] }>;
      holidays: Array<{ date: string }>;
      dayLoad: unknown[];
    };
    expect(dto.plan).toMatchObject({ status: "OPEN", year: YEAR, deadlinePassed: false });
    expect(dto.viewer).toMatchObject({ canManage: false, canWishOwn: true });
    // Since 835-06 the planner lists the whole plan population (the second approver is homed in S too).
    expect(dto.persons.map((p) => p.employeeId)).toEqual(
      expect.arrayContaining([one.employee.id, takerEmployeeId]),
    );
    const ids = dto.persons.flatMap((p) => p.wishes.map((w) => w.id)).sort();
    expect(ids).toEqual([bWishId, tWishId].sort());
    // The salon's statutory holidays are served now (New Year's Day is a holiday in every state).
    expect(dto.holidays.map((h) => h.date)).toContain(`${YEAR}-01-01`);
  });

  it("an unknown plan id and another tenant's plan answer byte-identical 404 bodies", async () => {
    const foreign = await app.prisma.leavePlan.create({
      data: {
        tenantId: two.tenant.id,
        salonId: two.salonId,
        year: YEAR,
        openedByUserId: two.adminUser.id,
      },
    });
    const unknown = await app.inject({
      method: "GET",
      url: `/api/v1/leave/plans/${crypto.randomUUID()}`,
      headers: authed(takerToken),
    });
    const foreignRes = await app.inject({
      method: "GET",
      url: `/api/v1/leave/plans/${foreign.id}`,
      headers: authed(takerToken),
    });
    expect(unknown.statusCode).toBe(404);
    expect(foreignRes.statusCode).toBe(unknown.statusCode);
    expect(foreignRes.body).toBe(unknown.body);
    expect(unknown.body).toBe(PLAN_NOT_FOUND);

    const takeover = await app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${foreign.id}/takeover`,
      headers: authed(takerToken),
      payload: {},
    });
    expect(takeover.statusCode).toBe(404);
    expect(takeover.body).toBe(PLAN_NOT_FOUND);
  });

  let takeoverBody: {
    created: Array<{ wishId: string; employeeId: string; leaveRequestId: string }>;
    pending: Array<{ wishId: string; leaveRequestId: string; reason: string }>;
    refused: unknown[];
    planStatus: string;
  };

  it("the takeover turns B's wish into an APPROVED request and T's own wish into a PENDING one", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planId}/takeover`,
      headers: authed(takerToken),
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    takeoverBody = res.json();
    expect(takeoverBody.refused).toEqual([]);
    expect(takeoverBody.planStatus).toBe("TAKEN_OVER");
    expect(takeoverBody.created.map((c) => c.wishId)).toEqual([bWishId]);
    expect(takeoverBody.pending).toMatchObject([{ wishId: tWishId, reason: "OWN_WISH" }]);

    const bRequest = await app.prisma.leaveRequest.findUniqueOrThrow({
      where: { id: takeoverBody.created[0]!.leaveRequestId },
    });
    expect(bRequest.status).toBe("APPROVED");
    expect(bRequest.reviewedBy).toBe(takerUserId);
    expect(bRequest.employeeId).toBe(one.employee.id);
    expect(bRequest.startDate.toISOString().slice(0, 10)).toBe(B_WISH.startDate);
    expect(bRequest.endDate.toISOString().slice(0, 10)).toBe(B_WISH.endDate);
    expect(bRequest.halfDay).toBe(false);

    const tRequest = await app.prisma.leaveRequest.findUniqueOrThrow({
      where: { id: takeoverBody.pending[0]!.leaveRequestId },
    });
    expect(tRequest.status).toBe("PENDING");
    expect(tRequest.employeeId).toBe(takerEmployeeId);
  });

  it("each created request carries the CREATE audit marker (trigger, plan id, wish id)", async () => {
    for (const [requestId, wishId] of [
      [takeoverBody.created[0]!.leaveRequestId, bWishId],
      [takeoverBody.pending[0]!.leaveRequestId, tWishId],
    ] as const) {
      const create = await soleAuditRow(app.prisma, {
        where: { entity: "LeaveRequest", entityId: requestId, action: "CREATE" },
      });
      expect(create.userId).toBe(takerUserId);
      expect(create.newValue).toMatchObject({
        trigger: "LEAVE_PLAN",
        leavePlanId: planId,
        leavePlanWishId: wishId,
      });
    }
    // Filed for someone else: the on-behalf marker of the normal create stays.
    const onBehalf = await soleAuditRow(app.prisma, {
      where: {
        entity: "LeaveRequest",
        entityId: takeoverBody.created[0]!.leaveRequestId,
        action: "CREATE",
      },
    });
    expect(onBehalf.newValue).toMatchObject({
      source: "MANAGER_CREATED",
      targetEmployeeId: one.employee.id,
    });
  });

  it("T's own wish notifies another approver once; the approved wish pings nobody (D-835-35)", async () => {
    const note = await soleNotification(app.prisma, {
      where: {
        userId: secondApproverUserId,
        type: "LEAVE_REQUEST",
        relatedId: takeoverBody.pending[0]!.leaveRequestId,
      },
    });
    expect(note.relatedType).toBe("LeaveRequest");
    const approvedPing = await app.prisma.notification.count({
      where: {
        type: "LEAVE_REQUEST",
        relatedId: takeoverBody.created[0]!.leaveRequestId,
      },
    });
    expect(approvedPing).toBe(0);
    // The approval core's own notice to the person stays.
    const approved = await soleNotification(app.prisma, {
      where: {
        userId: one.empUser.id,
        type: "LEAVE_APPROVED",
        link: `/leave?request=${takeoverBody.created[0]!.leaveRequestId}`,
      },
    });
    expect(approved.userId).toBe(one.empUser.id);
  });

  it("both wishes are linked and the plan is TAKEN_OVER with one summary audit of ids and counts", async () => {
    const wishes = await app.prisma.leavePlanWish.findMany({
      where: { planId },
      orderBy: { id: "asc" },
    });
    const linked = Object.fromEntries(wishes.map((w) => [w.id, w.leaveRequestId]));
    expect(linked).toEqual({
      [bWishId]: takeoverBody.created[0]!.leaveRequestId,
      [tWishId]: takeoverBody.pending[0]!.leaveRequestId,
    });
    for (const wish of wishes) {
      expect(wish.takenOverAt).not.toBeNull();
      expect(wish.refusalCode).toBeNull();
    }
    const plan = await app.prisma.leavePlan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.status).toBe("TAKEN_OVER");
    expect(plan.takenOverByUserId).toBe(takerUserId);
    expect(plan.takenOverAt).not.toBeNull();

    const rows = await auditRowsFor(app, "LeavePlan", planId, "LEAVE_PLAN_TAKEN_OVER");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(takerUserId);
    expect(Object.keys(rows[0]!.newValue as object).sort()).toEqual(
      [
        "createdCount",
        "createdWishIds",
        "pendingCount",
        "pendingWishIds",
        "planStatus",
        "refusedCount",
        "refusedWishIds",
        "skippedCount",
      ].sort(),
    );
    expect(rows[0]!.newValue).toMatchObject({
      createdWishIds: [bWishId],
      pendingWishIds: [tWishId],
      refusedWishIds: [],
      createdCount: 1,
      pendingCount: 1,
      refusedCount: 0,
      skippedCount: 0,
      planStatus: "TAKEN_OVER",
    });
  });

  it("a second takeover is 409 LEAVE_PLAN_CLOSED and creates no further request", async () => {
    const before = await app.prisma.leaveRequest.count({
      where: { employee: { tenantId: one.tenant.id } },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planId}/takeover`,
      headers: authed(takerToken),
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "LEAVE_PLAN_CLOSED" });
    const after = await app.prisma.leaveRequest.count({
      where: { employee: { tenantId: one.tenant.id } },
    });
    expect(after).toBe(before);
  });

  it("a wish on a TAKEN_OVER plan is 409 LEAVE_PLAN_CLOSED", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planId}/wishes`,
      headers: authed(one.empToken),
      payload: { startDate: "2027-09-06", endDate: "2027-09-07" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "LEAVE_PLAN_CLOSED" });
  });

  describe("a wish moved while its request is created (T-835-13)", () => {
    async function openPlanWithWish(startDate: string, endDate: string) {
      const opened = await app.inject({
        method: "POST",
        url: "/api/v1/leave/plans",
        headers: authed(takerToken),
        payload: { salonId: one.salonId, year: YEAR },
      });
      expect(opened.statusCode, opened.body).toBe(201);
      const id = (opened.json() as { plan: { id: string } }).plan.id;
      const wished = await app.inject({
        method: "POST",
        url: `/api/v1/leave/plans/${id}/wishes`,
        headers: authed(one.empToken),
        payload: { startDate, endDate },
      });
      expect(wished.statusCode, wished.body).toBe(201);
      return { planId: id, wishId: (wished.json() as { wish: { id: string } }).wish.id };
    }

    /** Moves the wish's end one day later right after the takeover read it (a concurrent edit). */
    function moveWishAfterRead(wishId: string, times: number) {
      const original = app.prisma.leavePlanWish.findFirst.bind(app.prisma.leavePlanWish);
      let moves = 0;
      const spy = vi.spyOn(app.prisma.leavePlanWish, "findFirst").mockImplementation((async (
        args: Parameters<typeof original>[0],
      ) => {
        const read = await original(args);
        if (read && read.id === wishId && moves < times) {
          moves += 1;
          const end = new Date(read.endDate.getTime() + 24 * 60 * 60 * 1000);
          await app.prisma.leavePlanWish.update({ where: { id: wishId }, data: { endDate: end } });
        }
        return read;
      }) as typeof original);
      return spy;
    }

    async function takeOver(id: string) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/leave/plans/${id}/takeover`,
        headers: authed(takerToken),
        payload: {},
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as {
        created: Array<{ wishId: string; leaveRequestId: string }>;
        refused: unknown[];
        planStatus: string;
      };
    }

    it("a wish moved once is retried once and the request equals the wish as stored now", async () => {
      const { planId: id, wishId } = await openPlanWithWish("2027-09-06", "2027-09-07");
      const spy = moveWishAfterRead(wishId, 1);
      let body;
      try {
        body = await takeOver(id);
      } finally {
        spy.mockRestore();
      }
      expect(body.created.map((c) => c.wishId)).toEqual([wishId]);
      const requests = await app.prisma.leaveRequest.findMany({
        where: { employeeId: one.employee.id, startDate: new Date("2027-09-06T00:00:00Z") },
      });
      // Exactly one request, for the moved dates: the first create was rolled back with its audit.
      expect(requests).toHaveLength(1);
      expect(requests[0]!.endDate.toISOString().slice(0, 10)).toBe("2027-09-08");
      expect(await auditRowsFor(app, "LeaveRequest", requests[0]!.id, "CREATE")).toHaveLength(1);
      const wish = await app.prisma.leavePlanWish.findUniqueOrThrow({ where: { id: wishId } });
      expect(wish.leaveRequestId).toBe(requests[0]!.id);
      expect(body.planStatus).toBe("TAKEN_OVER");
    });

    it("a wish moved twice is skipped in this run: no request, still unlinked, the plan stays OPEN", async () => {
      const { planId: id, wishId } = await openPlanWithWish("2027-10-04", "2027-10-05");
      const spy = moveWishAfterRead(wishId, 2);
      let body;
      try {
        body = await takeOver(id);
      } finally {
        spy.mockRestore();
      }
      expect(body.created).toEqual([]);
      expect(body.refused).toEqual([]);
      expect(body.planStatus).toBe("OPEN");
      expect(
        await app.prisma.leaveRequest.count({
          where: { employeeId: one.employee.id, startDate: new Date("2027-10-04T00:00:00Z") },
        }),
      ).toBe(0);
      const wish = await app.prisma.leavePlanWish.findUniqueOrThrow({ where: { id: wishId } });
      expect(wish.leaveRequestId).toBeNull();
      const summary = await soleAuditRow(app.prisma, {
        where: { entity: "LeavePlan", entityId: id, action: "LEAVE_PLAN_TAKEN_OVER" },
      });
      expect(summary.newValue).toMatchObject({ skippedCount: 1, createdCount: 0 });
    });
  });
});
