/**
 * Issue #835 (AC-7; D-835-13, D-835-17) — the takeover under concurrency: two clicks at once create
 * exactly one request per wish, and a wish that is moved or removed between the takeover's read and
 * its create never produces a request with stale dates.
 *
 * The move and removal races are made deterministic with a SEAM, never with timing: this file
 * `vi.mock`s `contexts/absence/leave-request-create` and wraps `createLeaveRequestCore` so that a
 * hoisted, per-test callback (null by default, then the wrapper only delegates) runs right before
 * the real core — after the takeover read the wish, before its create. The callback edits the wish
 * through the real route. The double-takeover case keeps `Promise.all`: its assertion (one request
 * per wish) holds for every interleaving.
 *
 * Fixture (REAL clock, plan year = next calendar year): tenant with its default salon S; the taker T
 * (manage + read + create-own, NO approve permission, so every request stays PENDING and notifies
 * the approvers), a second approver A2 (approve + read), persons B and C homed in S. No person names.
 *
 * Mutation proof (Phase 835-07, 2026-11-06) — recorded here, not re-run by CI; reverted with cp:
 * M1 takeover.ts link hook: the `startDate` / `endDate` comparison removed -> red: the move-race
 *    case and the double-move case (the stale-dated request is created and linked).
 * M2 takeover.ts link hook: the `deletedAt` / `leaveRequestId` checks removed -> red: the removal
 *    case and the double-takeover case.
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
  auditRowsFor,
} from "./setup";
import { roleNameKey, normalizeRolePermissions } from "../contexts/platform/access-role";

const seam = vi.hoisted(() => ({
  beforeCreate: null as null | (() => Promise<void>),
  everyCall: false,
}));

vi.mock("../contexts/absence/leave-request-create", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../contexts/absence/leave-request-create")>();
  return {
    ...actual,
    createLeaveRequestCore: async (
      ...args: Parameters<typeof actual.createLeaveRequestCore>
    ): ReturnType<typeof actual.createLeaveRequestCore> => {
      const callback = seam.beforeCreate;
      if (callback && args[2]?.inTransaction) {
        if (!seam.everyCall) seam.beforeCreate = null;
        await callback();
      }
      return actual.createLeaveRequestCore(...args);
    },
  };
});

const MANAGE = "leave-plan:manage:ZUGEWIESEN";
const APPROVE = "leave-request:approve:ZUGEWIESEN";
const READ = "leave-request:read:ZUGEWIESEN";
const CREATE_OWN = "leave-request:create:EIGENE";
const YEAR = new Date().getFullYear() + 1;
const DAY_MS = 24 * 60 * 60 * 1000;

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
  return iso(new Date(new Date(`${day}T00:00:00Z`).getTime() + days * DAY_MS));
}

/** The `nth` Monday of `month` of the plan year. */
function monday(month: number, nth: number): string {
  const first = new Date(Date.UTC(YEAR, month - 1, 1));
  return iso(
    new Date(first.getTime() + ((8 - first.getUTCDay()) % 7) * DAY_MS + 7 * (nth - 1) * DAY_MS),
  );
}

type Person = { userId: string; employeeId: string };

describe("Issue #835 - takeover under concurrency and wish races", () => {
  let app: FastifyInstance;
  let one: Awaited<ReturnType<typeof seedTestData>>;
  let takerToken: string;
  let takerUserId: string;
  let approver2: Person;

  function authed(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async function rawPerson(label: string): Promise<Person & { email: string }> {
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
        lastName: "Race835",
        hireDate: new Date("2024-01-01"),
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
        validFrom: new Date("2024-01-01"),
      },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: one.tenant.id,
        employeeId: employee.id,
        salonId: one.salonId,
        kind: "HOME",
        validFrom: new Date("2024-01-01T00:00:00Z"),
        validUntil: null,
        weekdays: [],
      },
    });
    await seedEntitlementYears(app, {
      employeeId: employee.id,
      leaveTypeId: one.vacationType.id,
      years: [YEAR],
    });
    return { userId: user.id, employeeId: employee.id, email };
  }

  async function actor(label: string, permissions: string[]) {
    const person = await rawPerson(label);
    const name = `Race835 ${crypto.randomBytes(3).toString("hex")}`;
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
        userId: person.userId,
        accessRoleId: role.id,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    return { ...person, token: await tokenWithoutSignIn(app, person.email) };
  }

  async function freshPlan(): Promise<string> {
    await app.prisma.leavePlan.updateMany({
      where: { tenantId: one.tenant.id, salonId: one.salonId, year: YEAR, status: "OPEN" },
      data: { status: "TAKEN_OVER", takenOverAt: new Date(), takenOverByUserId: takerUserId },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/plans",
      headers: authed(takerToken),
      payload: { salonId: one.salonId, year: YEAR },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { plan: { id: string } }).plan.id;
  }

  async function addWish(planId: string, employeeId: string, startDate: string, endDate: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planId}/wishes`,
      headers: authed(takerToken),
      payload: { employeeId, startDate, endDate },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { wish: { id: string } }).wish.id;
  }

  function takeOverRaw(planId: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planId}/takeover`,
      headers: authed(takerToken),
      payload: {},
    });
  }

  type TakeoverBody = {
    created: Array<{ wishId: string; leaveRequestId: string }>;
    pending: Array<{ wishId: string; leaveRequestId: string }>;
    refused: Array<{ wishId: string; code: string }>;
    planStatus: string;
  };

  async function takeOver(planId: string): Promise<TakeoverBody> {
    const res = await takeOverRaw(planId);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as TakeoverBody;
  }

  async function patchWish(planId: string, wishId: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/leave/plans/${planId}/wishes/${wishId}`,
      headers: authed(takerToken),
      payload,
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    one = await seedTestData(app, "rc835");
    const t = await actor("taker", [MANAGE, READ, CREATE_OWN]);
    takerToken = t.token;
    takerUserId = t.userId;
    approver2 = await actor("second", [APPROVE, READ]);
  });

  afterAll(async () => {
    seam.beforeCreate = null;
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: one.tenant.id } });
      await cleanupTestData(app, one.tenant.id);
    } catch (err) {
      console.error("leave-plan-takeover-concurrency-835 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("two takeovers of one plan started together create exactly one request per wish and no 5xx", async () => {
    const b = await rawPerson("b-double");
    const c = await rawPerson("c-double");
    const planId = await freshPlan();
    const wishes = [
      await addWish(planId, b.employeeId, monday(3, 1), addDays(monday(3, 1), 4)),
      await addWish(planId, b.employeeId, monday(3, 3), addDays(monday(3, 3), 4)),
      await addWish(planId, c.employeeId, monday(3, 1), addDays(monday(3, 1), 4)),
      await addWish(planId, c.employeeId, monday(3, 3), addDays(monday(3, 3), 2)),
    ];

    const [first, second] = await Promise.all([takeOverRaw(planId), takeOverRaw(planId)]);
    for (const res of [first, second]) {
      expect([200, 409], res.body).toContain(res.statusCode);
      // D-835-41: the second click either finds the plan closed or finds the first run holding the
      // plan's takeover lock.
      if (res.statusCode === 409) {
        expect(["LEAVE_PLAN_CLOSED", "LEAVE_PLAN_TAKEOVER_RUNNING"]).toContain(
          (res.json() as { code: string }).code,
        );
      }
    }

    const stored = await app.prisma.leavePlanWish.findMany({
      where: { planId },
      select: { id: true, leaveRequestId: true },
    });
    expect(stored.map((w) => w.id).sort()).toEqual([...wishes].sort());
    const requestIds = stored.map((w) => w.leaveRequestId);
    expect(requestIds.every((id) => id !== null)).toBe(true);
    expect(new Set(requestIds).size).toBe(wishes.length);
    // One request per person and start: no duplicate created by the losing run.
    expect(
      await app.prisma.leaveRequest.count({
        where: { employeeId: { in: [b.employeeId, c.employeeId] } },
      }),
    ).toBe(wishes.length);
    // One CREATE audit per wish id.
    const creates = await app.prisma.auditLog.findMany({
      where: {
        entity: "LeaveRequest",
        action: "CREATE",
        newValue: { path: ["leavePlanId"], equals: planId },
      },
      select: { newValue: true },
    });
    expect(
      creates.map((row) => (row.newValue as { leavePlanWishId: string }).leavePlanWishId).sort(),
    ).toEqual([...wishes].sort());
    const plan = await app.prisma.leavePlan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.status).toBe("TAKEN_OVER");
  });

  it("a wish moved between the read and the create: the first create is rolled back, the retry creates ONE request on the moved dates", async () => {
    const b = await rawPerson("b-move");
    const planId = await freshPlan();
    const start = monday(4, 1);
    const wishId = await addWish(planId, b.employeeId, start, addDays(start, 1));

    seam.beforeCreate = async () => {
      const res = await patchWish(planId, wishId, { endDate: addDays(start, 2) });
      expect(res.statusCode, res.body).toBe(200);
    };
    const body = await takeOver(planId);
    expect(seam.beforeCreate).toBeNull();

    expect(body.refused).toEqual([]);
    expect(body.pending.map((p) => p.wishId)).toEqual([wishId]);
    const requests = await app.prisma.leaveRequest.findMany({
      where: { employeeId: b.employeeId },
    });
    expect(requests).toHaveLength(1);
    expect(iso(requests[0]!.startDate)).toBe(start);
    expect(iso(requests[0]!.endDate)).toBe(addDays(start, 2));
    expect(requests[0]!.halfDay).toBe(false);
    const wish = await app.prisma.leavePlanWish.findUniqueOrThrow({ where: { id: wishId } });
    expect(wish.leaveRequestId).toBe(requests[0]!.id);
    expect(iso(wish.endDate)).toBe(addDays(start, 2));

    // Nothing of the rolled-back create survives: one CREATE audit, one notice, on the live request.
    expect(await auditRowsFor(app, "LeaveRequest", requests[0]!.id, "CREATE")).toHaveLength(1);
    const creates = await app.prisma.auditLog.findMany({
      where: {
        entity: "LeaveRequest",
        action: "CREATE",
        newValue: { path: ["leavePlanWishId"], equals: wishId },
      },
      select: { entityId: true },
    });
    expect(creates.map((row) => row.entityId)).toEqual([requests[0]!.id]);
    const notes = await app.prisma.notification.findMany({
      where: { userId: approver2.userId, type: "LEAVE_REQUEST", relatedId: requests[0]!.id },
      select: { id: true },
    });
    expect(notes).toHaveLength(1);
    expect(body.planStatus).toBe("TAKEN_OVER");
  });

  it("a wish removed between the read and the create: no request at all, the wish stays removed and unlinked, the plan closes", async () => {
    const b = await rawPerson("b-remove");
    const planId = await freshPlan();
    const start = monday(5, 1);
    const wishId = await addWish(planId, b.employeeId, start, addDays(start, 1));

    seam.beforeCreate = async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/leave/plans/${planId}/wishes/${wishId}`,
        headers: authed(takerToken),
      });
      expect(res.statusCode, res.body).toBe(204);
    };
    const body = await takeOver(planId);

    expect(body.created).toEqual([]);
    expect(body.pending).toEqual([]);
    expect(body.refused).toEqual([]);
    expect(await app.prisma.leaveRequest.count({ where: { employeeId: b.employeeId } })).toBe(0);
    const wish = await app.prisma.leavePlanWish.findUniqueOrThrow({ where: { id: wishId } });
    expect(wish.deletedAt).not.toBeNull();
    expect(wish.leaveRequestId).toBeNull();
    const summary = await soleAuditRow(app.prisma, {
      where: { entity: "LeavePlan", entityId: planId, action: "LEAVE_PLAN_TAKEN_OVER" },
    });
    expect(summary.newValue).toMatchObject({ skippedCount: 1, createdCount: 0, pendingCount: 0 });
    expect(body.planStatus).toBe("TAKEN_OVER");
  });

  it("a wish moved again before the retry: nothing is created in this run, the plan stays OPEN, the next run creates ONE request on the latest dates", async () => {
    const b = await rawPerson("b-double-move");
    const planId = await freshPlan();
    const start = monday(6, 1);
    const wishId = await addWish(planId, b.employeeId, start, addDays(start, 1));

    let moves = 0;
    seam.everyCall = true;
    seam.beforeCreate = async () => {
      moves += 1;
      const res = await patchWish(planId, wishId, { endDate: addDays(start, 1 + moves) });
      expect(res.statusCode, res.body).toBe(200);
    };
    let body: TakeoverBody;
    try {
      body = await takeOver(planId);
    } finally {
      seam.everyCall = false;
      seam.beforeCreate = null;
    }
    expect(moves).toBe(2);
    expect(body.created).toEqual([]);
    expect(body.pending).toEqual([]);
    expect(body.refused).toEqual([]);
    expect(body.planStatus).toBe("OPEN");
    expect(await app.prisma.leaveRequest.count({ where: { employeeId: b.employeeId } })).toBe(0);
    const wish = await app.prisma.leavePlanWish.findUniqueOrThrow({ where: { id: wishId } });
    expect(wish.leaveRequestId).toBeNull();
    expect(iso(wish.endDate)).toBe(addDays(start, 3));

    const next = await takeOver(planId);
    expect(next.pending.map((p) => p.wishId)).toEqual([wishId]);
    const requests = await app.prisma.leaveRequest.findMany({
      where: { employeeId: b.employeeId },
    });
    expect(requests).toHaveLength(1);
    expect(iso(requests[0]!.endDate)).toBe(addDays(start, 3));
    expect(next.planStatus).toBe("TAKEN_OVER");
  });

  it("after the takeover linked a wish, a move is 409 LEAVE_PLAN_WISH_TAKEN_OVER and the request keeps its dates", async () => {
    const b = await rawPerson("b-linked");
    const exited = await rawPerson("c-exited");
    const planId = await freshPlan();
    const start = monday(7, 1);
    const wishId = await addWish(planId, b.employeeId, start, addDays(start, 1));
    // A second wish that is refused keeps the plan OPEN, so the linked wish is reachable by the route.
    const keepOpen = monday(7, 3);
    await addWish(planId, exited.employeeId, keepOpen, addDays(keepOpen, 1));
    await app.prisma.employee.update({
      where: { id: exited.employeeId },
      data: { exitDate: new Date(Date.UTC(YEAR, 0, 15)) },
    });

    const body = await takeOver(planId);
    expect(body.planStatus).toBe("OPEN");
    expect(body.refused.map((r) => r.code)).toEqual(["LEAVE_PLAN_WISH_NOT_EMPLOYED"]);
    expect(body.pending.map((p) => p.wishId)).toEqual([wishId]);

    const res = await patchWish(planId, wishId, { endDate: addDays(start, 3) });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "LEAVE_PLAN_WISH_TAKEN_OVER" });
    const requests = await app.prisma.leaveRequest.findMany({
      where: { employeeId: b.employeeId },
    });
    expect(requests).toHaveLength(1);
    expect(iso(requests[0]!.startDate)).toBe(start);
    expect(iso(requests[0]!.endDate)).toBe(addDays(start, 1));
  });
});
