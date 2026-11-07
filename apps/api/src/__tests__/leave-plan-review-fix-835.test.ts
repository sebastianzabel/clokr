/**
 * Issue #835 — the fixes of the phase review (835-REVIEW.md, decisions D-835-38..45). One case per
 * finding; each case names its finding and decision.
 *
 * Fixture (REAL clock, plan year = next calendar year, so no wish is ever in the past and no audit row
 * carries a future stamp): tenant one. Every case builds its OWN salon (a fresh one per case keeps
 * "one open plan per salon and year" from colliding between cases) and its own persons homed in it,
 * Mo-Fr contract, 30 days of entitlement in the plan year. Callers are custom roles. No person names.
 *
 * Seams, both `vi.mock`ed in THIS file only and both delegating to the real function by default:
 * while the hoisted counter `mocks.refuse` is above 0, `approveLeaveRequestCore` refuses with
 * MONTH_CLOSED and counts down; `mocks.beforeCreate`, when set, runs once right before the next
 * takeover create (after the takeover read the wish), the deterministic way to move a wish under
 * the create (the pattern of leave-plan-takeover-concurrency-835).
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
  createTestSalon,
  seedEntitlementYears,
  tokenWithoutSignIn,
  auditRowsFor,
  soleNotification,
} from "./setup";
import { roleNameKey, normalizeRolePermissions } from "../contexts/platform/access-role";
import {
  approveLeaveRequestCore,
  loadLeaveRequestForReview,
} from "../contexts/absence/leave-decision";
import { takeoverLockName } from "../contexts/absence/leave-plan/constants";

const mocks = vi.hoisted(() => ({
  refuse: 0,
  /** Runs once right before the next takeover create (after the takeover read the wish). */
  beforeCreate: null as null | (() => Promise<void>),
}));

vi.mock("../contexts/absence/leave-request-create", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../contexts/absence/leave-request-create")>();
  return {
    ...actual,
    createLeaveRequestCore: async (
      ...args: Parameters<typeof actual.createLeaveRequestCore>
    ): ReturnType<typeof actual.createLeaveRequestCore> => {
      const callback = mocks.beforeCreate;
      if (callback && args[2]?.inTransaction) {
        mocks.beforeCreate = null;
        await callback();
      }
      return actual.createLeaveRequestCore(...args);
    },
  };
});

vi.mock("../contexts/absence/leave-decision", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../contexts/absence/leave-decision")>();
  return {
    ...actual,
    approveLeaveRequestCore: async (
      ...args: Parameters<typeof actual.approveLeaveRequestCore>
    ): ReturnType<typeof actual.approveLeaveRequestCore> => {
      if (mocks.refuse > 0) {
        mocks.refuse -= 1;
        return {
          ok: false,
          statusCode: 409,
          body: { error: "Der Monat ist bereits abgeschlossen", code: "LEAVE_MONTH_CLOSED" },
          reason: "MONTH_CLOSED",
        };
      }
      return actual.approveLeaveRequestCore(...args);
    },
  };
});

const MANAGE = "leave-plan:manage:ZUGEWIESEN";
const APPROVE = "leave-request:approve:ZUGEWIESEN";
const READ = "leave-request:read:ZUGEWIESEN";
const CREATE_OWN = "leave-request:create:EIGENE";
const CREATE_OTHERS = "leave-request:create:ZUGEWIESEN";
/** Everything a taker of the phase's own fixtures holds, plus the create reach of D-835-45. */
const TAKER = [MANAGE, APPROVE, READ, CREATE_OWN, CREATE_OTHERS];
const YEAR = new Date().getFullYear() + 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const AUDIT_META = { ip: "127.0.0.1", headers: {} };

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Mo-Fr of the `nth` Monday (1-based) of `month` (1-based) of `year`. */
function week(month: number, nth: number, year = YEAR): { startDate: string; endDate: string } {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const start = new Date(
    first.getTime() + (((8 - first.getUTCDay()) % 7) + 7 * (nth - 1)) * DAY_MS,
  );
  return { startDate: iso(start), endDate: iso(new Date(start.getTime() + 4 * DAY_MS)) };
}

type Person = { userId: string; employeeId: string; token: string };
type Scope = { kind: "TENANT" } | { kind: "SALONS"; salonIds: string[] };

type TakeoverAnswer = {
  created: Array<{ wishId: string; employeeId: string; leaveRequestId: string }>;
  pending: Array<{ wishId: string; employeeId: string; leaveRequestId: string; reason: string }>;
  refused: Array<{ wishId: string; employeeId: string; code: string; error: string }>;
  planStatus: "OPEN" | "TAKEN_OVER";
};

type PlannerAnswer = {
  plan: { id: string; status: string; openWishCount: number | null };
  persons: Array<{
    employeeId: string;
    wishes: Array<{
      id: string;
      leaveRequestId: string | null;
      leaveRequestStatus: string | null;
      refusalCode: string | null;
      refusalMessage: string | null;
    }>;
  }>;
};

describe("Issue #835 - review fixes of the leave planner", () => {
  let app: FastifyInstance;
  let one: Awaited<ReturnType<typeof seedTestData>>;

  function authed(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async function salon(): Promise<string> {
    const row = await createTestSalon(app.prisma, one.tenant.id, {
      name: `RF835 ${crypto.randomBytes(3).toString("hex")}`,
    });
    return row.id;
  }

  /** A person homed in `homeSalonId`, optionally holding `permissions` in `scope`. */
  async function person(
    label: string,
    homeSalonId: string,
    permissions: string[] = [],
    scope: Scope = { kind: "TENANT" },
  ): Promise<Person> {
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
        lastName: "ReviewFix835",
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
        salonId: homeSalonId,
        kind: "HOME",
        validFrom: new Date("2024-01-01T00:00:00Z"),
        validUntil: null,
        weekdays: [],
      },
    });
    await seedEntitlementYears(app, {
      employeeId: employee.id,
      leaveTypeId: one.vacationType.id,
      years: [YEAR, YEAR + 1],
    });
    if (permissions.length > 0) await grant(user.id, permissions, scope);
    return {
      userId: user.id,
      employeeId: employee.id,
      token: await tokenWithoutSignIn(app, email),
    };
  }

  async function grant(userId: string, permissions: string[], scope: Scope): Promise<void> {
    const name = `RF835 ${crypto.randomBytes(3).toString("hex")}`;
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
        userId,
        accessRoleId: role.id,
        scopeType: scope.kind,
        salonIds: scope.kind === "SALONS" ? scope.salonIds : [],
        employeeIds: [],
      },
    });
  }

  async function openPlan(token: string, salonId: string, year = YEAR): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/plans",
      headers: authed(token),
      payload: { salonId, year },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { plan: { id: string } }).plan.id;
  }

  async function addWish(
    token: string,
    planId: string,
    employeeId: string,
    range: { startDate: string; endDate: string },
  ): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planId}/wishes`,
      headers: authed(token),
      payload: { employeeId, ...range },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { wish: { id: string } }).wish.id;
  }

  async function takeOver(token: string, planId: string): Promise<TakeoverAnswer> {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planId}/takeover`,
      headers: authed(token),
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as TakeoverAnswer;
  }

  async function readPlan(token: string, planId: string): Promise<PlannerAnswer> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/plans/${planId}`,
      headers: authed(token),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as PlannerAnswer;
  }

  function wishOf(planner: PlannerAnswer, wishId: string) {
    const wish = planner.persons.flatMap((p) => p.wishes).find((w) => w.id === wishId);
    expect(wish, `wish ${wishId} is in the planner`).toBeDefined();
    return wish!;
  }

  beforeAll(async () => {
    app = await getTestApp();
    one = await seedTestData(app, "rf835");
  });

  afterAll(async () => {
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: one.tenant.id } });
      await cleanupTestData(app, one.tenant.id);
    } catch (err) {
      console.error("leave-plan-review-fix-835 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("WR-09 (D-835-44): a soft-deleted linked request is not shown as the wish's request status", async () => {
    const s = await salon();
    const taker = await person("taker", s, TAKER);
    const a = await person("a", s);
    const planId = await openPlan(taker.token, s);
    const wishId = await addWish(taker.token, planId, a.employeeId, week(2, 2));
    const run = await takeOver(taker.token, planId);
    expect(run.created.map((c) => c.wishId)).toEqual([wishId]);
    const requestId = run.created[0]!.leaveRequestId;

    expect(wishOf(await readPlan(taker.token, planId), wishId).leaveRequestStatus).toBe("APPROVED");
    await app.prisma.leaveRequest.update({
      where: { id: requestId },
      data: { deletedAt: new Date() },
    });
    const after = wishOf(await readPlan(taker.token, planId), wishId);
    expect(after.leaveRequestId).toBe(requestId);
    expect(after.leaveRequestStatus).toBeNull();
  });

  it("WR-08 (D-835-44): refusal and request status of a colleague's wish only inside the read reach", async () => {
    const s = await salon();
    const taker = await person("taker", s, TAKER);
    const reader = await person("reader", s, [READ], { kind: "SALONS", salonIds: [s] });
    const member = await person("member", s, [CREATE_OWN]);
    const a = await person("a", s);
    const c = await person("c", s);
    const planId = await openPlan(taker.token, s);
    const wishA = await addWish(taker.token, planId, a.employeeId, week(6, 2));
    const wishC = await addWish(taker.token, planId, c.employeeId, week(3, 2));
    const ownWish = await addWish(member.token, planId, member.employeeId, week(7, 2));
    // A and the member leave before their wishes: the takeover stores a refusal on both wishes.
    for (const employeeId of [a.employeeId, member.employeeId]) {
      await app.prisma.employee.update({
        where: { id: employeeId },
        data: { exitDate: new Date(`${YEAR}-05-31T00:00:00Z`) },
      });
    }
    const run = await takeOver(taker.token, planId);
    expect(run.refused.map((r) => r.wishId).sort()).toEqual([wishA, ownWish].sort());
    expect(run.created.map((r) => r.wishId)).toEqual([wishC]);

    // Inside the read reach: the code, the text and the request status.
    const asReader = await readPlan(reader.token, planId);
    expect(wishOf(asReader, wishA)).toMatchObject({ refusalCode: "LEAVE_PLAN_WISH_NOT_EMPLOYED" });
    expect(wishOf(asReader, wishA).refusalMessage).not.toBeNull();
    expect(wishOf(asReader, wishC).leaveRequestStatus).toBe("APPROVED");

    // A team member admitted by the own Stammsalon only: a colleague's wish without the reason
    // and without the request status, the own wish with both.
    const asMember = await readPlan(member.token, planId);
    expect(wishOf(asMember, wishA)).toMatchObject({ refusalCode: null, refusalMessage: null });
    expect(wishOf(asMember, wishC)).toMatchObject({ leaveRequestStatus: null });
    expect(wishOf(asMember, wishC).leaveRequestId).not.toBeNull();
    expect(wishOf(asMember, ownWish)).toMatchObject({
      refusalCode: "LEAVE_PLAN_WISH_NOT_EMPLOYED",
    });
  });

  it("WR-05 (D-835-41): the decision core approves a request once, also for a stale or a concurrent second decider", async () => {
    const s = await salon();
    const approver = await person("approver", s, [APPROVE, READ]);
    const a = await person("a", s, [CREATE_OWN]);

    async function pendingRequest(range: { startDate: string; endDate: string }) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: authed(a.token),
        payload: { type: "VACATION", ...range },
      });
      expect(res.statusCode, res.body).toBe(201);
      return (res.json() as { id: string }).id;
    }
    async function usedDays(): Promise<number> {
      const row = await app.prisma.leaveEntitlement.findFirstOrThrow({
        where: { employeeId: a.employeeId, leaveTypeId: one.vacationType.id, year: YEAR },
      });
      return Number(row.usedDays);
    }
    const decide = (existing: NonNullable<Awaited<ReturnType<typeof loadLeaveRequestForReview>>>) =>
      approveLeaveRequestCore(app, {
        existing,
        reviewerUserId: approver.userId,
        request: AUDIT_META,
      });

    // A stale second decider: both read the request while it was PENDING.
    const staleId = await pendingRequest(week(3, 3));
    const stale = (await loadLeaveRequestForReview(app, staleId))!;
    const before = await usedDays();
    const first = await decide(stale);
    const second = await decide(stale);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, statusCode: 409, reason: "NOT_DECIDABLE" });
    expect(await usedDays()).toBe(before + 5);
    expect(
      await app.prisma.auditLog.count({
        where: { entity: "LeaveRequest", entityId: staleId, action: "APPROVE" },
      }),
    ).toBe(1);

    // Two concurrent deciders: exactly one wins.
    const raceId = await pendingRequest(week(4, 3));
    const raced = (await loadLeaveRequestForReview(app, raceId))!;
    const beforeRace = await usedDays();
    const outcomes = await Promise.all([decide(raced), decide(raced)]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok)).toMatchObject([{ reason: "NOT_DECIDABLE" }]);
    expect(await usedDays()).toBe(beforeRace + 5);
  });

  it("WR-05 (D-835-41): a second takeover run of a plan while one runs is 409 and changes nothing", async () => {
    const s = await salon();
    const taker = await person("taker", s, TAKER);
    const a = await person("a", s);
    const planId = await openPlan(taker.token, s);
    const wishId = await addWish(taker.token, planId, a.employeeId, week(5, 2));

    // A run in flight holds the plan's lock; the takeover asked meanwhile is refused.
    let refused: Awaited<ReturnType<typeof app.inject>> | null = null;
    await app.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${takeoverLockName(planId)}, 0))`;
        refused = await app.inject({
          method: "POST",
          url: `/api/v1/leave/plans/${planId}/takeover`,
          headers: authed(taker.token),
          payload: {},
        });
      },
      { timeout: 30_000 },
    );
    expect(refused!.statusCode, refused!.body).toBe(409);
    expect(refused!.json()).toEqual({
      error: "Diese Urlaubsplanung wird gerade übernommen. Warte kurz und lade die Seite dann neu.",
      code: "LEAVE_PLAN_TAKEOVER_RUNNING",
    });
    const untouched = await app.prisma.leavePlanWish.findUniqueOrThrow({ where: { id: wishId } });
    expect(untouched.leaveRequestId).toBeNull();
    expect(await app.prisma.leaveRequest.count({ where: { employeeId: a.employeeId } })).toBe(0);

    // Once the lock is free the run goes through.
    const run = await takeOver(taker.token, planId);
    expect(run.created.map((c) => c.wishId)).toEqual([wishId]);
    expect(run.planStatus).toBe("TAKEN_OVER");
  });

  it("WR-06 (D-835-42): a stored refusal and the link of a wish are audited with codes only", async () => {
    const s = await salon();
    const taker = await person("taker", s, TAKER);
    const a = await person("a", s);
    const c = await person("c", s);
    const planId = await openPlan(taker.token, s);
    const wishA = await addWish(taker.token, planId, a.employeeId, week(9, 2));
    const wishC = await addWish(taker.token, planId, c.employeeId, week(9, 3));
    await app.prisma.employee.update({
      where: { id: a.employeeId },
      data: { exitDate: new Date(`${YEAR}-05-31T00:00:00Z`) },
    });
    const run = await takeOver(taker.token, planId);
    expect(run.refused.map((r) => r.wishId)).toEqual([wishA]);
    const requestC = run.created.find((r) => r.wishId === wishC)!.leaveRequestId;

    const refusalRows = await auditRowsFor(app, "LeavePlanWish", wishA, "UPDATE");
    expect(refusalRows).toHaveLength(1);
    expect(refusalRows[0]).toMatchObject({
      userId: taker.userId,
      oldValue: { planId, employeeId: a.employeeId, leaveRequestId: null, refusalCode: null },
      newValue: {
        planId,
        employeeId: a.employeeId,
        leaveRequestId: null,
        refusalCode: "LEAVE_PLAN_WISH_NOT_EMPLOYED",
        takenOverAt: null,
      },
    });
    // Codes only: the German refusal text never reaches the audit row.
    expect(JSON.stringify(refusalRows[0]!.newValue)).not.toContain(run.refused[0]!.error);

    const linkRows = await auditRowsFor(app, "LeavePlanWish", wishC, "UPDATE");
    expect(linkRows).toHaveLength(1);
    expect(linkRows[0]).toMatchObject({
      userId: taker.userId,
      oldValue: { employeeId: c.employeeId, leaveRequestId: null, takenOverAt: null },
      newValue: { employeeId: c.employeeId, leaveRequestId: requestC, refusalCode: null },
    });
    expect(typeof (linkRows[0]!.newValue as { takenOverAt: unknown }).takenOverAt).toBe("string");
  });

  it("WR-02 (D-835-39): a takeover request whose approval is refused notifies its approvers once", async () => {
    const s = await salon();
    const taker = await person("taker", s, TAKER);
    const approver = await person("approver", s, [APPROVE, READ]);
    const a = await person("a", s);
    const planId = await openPlan(taker.token, s);
    const wishId = await addWish(taker.token, planId, a.employeeId, week(10, 2));

    mocks.refuse = 1;
    const first = await takeOver(taker.token, planId);
    expect(mocks.refuse).toBe(0);
    expect(first.pending).toMatchObject([{ wishId, reason: "APPROVAL_REFUSED" }]);
    const requestId = first.pending[0]!.leaveRequestId;
    const notice = await soleNotification(app.prisma, {
      where: { userId: approver.userId, type: "LEAVE_REQUEST", relatedId: requestId },
    });
    expect(notice).toMatchObject({
      relatedType: "LeaveRequest",
      link: `/team/leave?request=${requestId}`,
    });

    // A second run whose approval is refused again tells nobody a second time.
    mocks.refuse = 1;
    const second = await takeOver(taker.token, planId);
    expect(second.pending).toMatchObject([{ wishId, reason: "APPROVAL_REFUSED" }]);
    await soleNotification(app.prisma, {
      where: { userId: approver.userId, type: "LEAVE_REQUEST", relatedId: requestId },
    });
  });

  it("WR-01 (D-835-38): terminally refused wishes, hidden ones included, never keep the plan open", async () => {
    const s = await salon();
    const elsewhere = await salon();
    const taker = await person("taker", s, TAKER);
    const member = await person("member", s, [CREATE_OWN]);
    const a = await person("a", s);
    const b = await person("b", s);
    const c = await person("c", s);
    const planId = await openPlan(taker.token, s);
    const wishA = await addWish(taker.token, planId, a.employeeId, week(11, 1));
    const wishB = await addWish(taker.token, planId, b.employeeId, week(11, 2));
    const wishC = await addWish(taker.token, planId, c.employeeId, week(11, 3));
    // A leaves before the wish; B's Stammsalon is moved to another salon for the whole time, so B
    // drops out of the plan population and the planner no longer shows B's wish.
    await app.prisma.employee.update({
      where: { id: a.employeeId },
      data: { exitDate: new Date(`${YEAR}-05-31T00:00:00Z`) },
    });
    await app.prisma.employeeSalonAssignment.updateMany({
      where: { employeeId: b.employeeId, kind: "HOME" },
      data: { salonId: elsewhere },
    });

    const before = await readPlan(taker.token, planId);
    expect(before.persons.some((p) => p.employeeId === b.employeeId)).toBe(false);
    // The served count is the takeover's close rule over every wish, the hidden one included.
    expect(before.plan.openWishCount).toBe(3);
    expect((await readPlan(member.token, planId)).plan.openWishCount).toBeNull();

    const run = await takeOver(taker.token, planId);
    expect(run.refused.map((r) => [r.wishId, r.code]).sort()).toEqual(
      [
        [wishA, "LEAVE_PLAN_WISH_NOT_EMPLOYED"],
        [wishB, "LEAVE_PLAN_WISH_NOT_IN_SALON"],
      ].sort(),
    );
    expect(run.created.map((r) => r.wishId)).toEqual([wishC]);
    expect(run.planStatus).toBe("TAKEN_OVER");
    // The refused wishes stay as a record with their refusal.
    const kept = await app.prisma.leavePlanWish.findMany({
      where: { id: { in: [wishA, wishB] }, deletedAt: null },
      select: { refusalCode: true },
    });
    expect(kept).toHaveLength(2);
  });

  it("WR-01 (D-835-38): a retry by a taker who may not approve clears the refusal, reports the wish and closes the plan", async () => {
    const s = await salon();
    const taker = await person("taker", s, TAKER);
    const second = await person("second", s, [MANAGE, READ, CREATE_OTHERS]);
    const approver = await person("approver", s, [APPROVE, READ]);
    const a = await person("a", s);
    const planId = await openPlan(taker.token, s);
    const wishId = await addWish(taker.token, planId, a.employeeId, week(12, 2));

    mocks.refuse = 1;
    const first = await takeOver(taker.token, planId);
    expect(first.pending).toMatchObject([{ wishId, reason: "APPROVAL_REFUSED" }]);
    expect(first.planStatus).toBe("OPEN");
    const requestId = first.pending[0]!.leaveRequestId;
    // The linked wish whose approval was refused still counts as open, so the button stays usable.
    expect((await readPlan(taker.token, planId)).plan.openWishCount).toBe(1);

    // The second taker holds no approve permission: the request stays PENDING for an approver.
    const rerun = await takeOver(second.token, planId);
    expect(rerun.pending).toEqual([
      {
        wishId,
        employeeId: a.employeeId,
        leaveRequestId: requestId,
        reason: "OUTSIDE_APPROVE_REACH",
      },
    ]);
    expect(rerun.created).toEqual([]);
    expect(rerun.planStatus).toBe("TAKEN_OVER");
    const request = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(request.status).toBe("PENDING");
    const wish = await app.prisma.leavePlanWish.findUniqueOrThrow({ where: { id: wishId } });
    expect(wish).toMatchObject({
      leaveRequestId: requestId,
      refusalCode: null,
      refusalMessage: null,
    });
    const cleared = (await auditRowsFor(app, "LeavePlanWish", wishId, "UPDATE")).filter(
      (row) => row.userId === second.userId,
    );
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({
      oldValue: { refusalCode: "APPROVAL_MONTH_CLOSED", leaveRequestId: requestId },
      newValue: { refusalCode: null, leaveRequestId: requestId },
    });
    // The approver was told once (the refused approval of the first run), not again.
    await soleNotification(app.prisma, {
      where: { userId: approver.userId, type: "LEAVE_REQUEST", relatedId: requestId },
    });
  });

  it("WR-03 (D-835-43): an approved wish later in the current month refreshes the stored overtime balance", async () => {
    // A fixed PAST clock (a future stamp would leak into usual-work-days-backfill-route-481): today
    // is Tuesday 2026-11-03, the wish is the week of Monday 2026-11-23 — after today, inside the
    // running month.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T10:00:00.000Z"));
    try {
      const s = await salon();
      const taker = await person("taker", s, TAKER);
      const a = await person("a", s);
      const later = await person("later", s);
      for (const employeeId of [a.employeeId, later.employeeId]) {
        await seedEntitlementYears(app, {
          employeeId,
          leaveTypeId: one.vacationType.id,
          years: [2026],
        });
      }
      const planId = await openPlan(taker.token, s, 2026);
      const inMonth = await addWish(taker.token, planId, a.employeeId, {
        startDate: "2026-11-23",
        endDate: "2026-11-27",
      });
      const nextMonth = await addWish(taker.token, planId, later.employeeId, {
        startDate: "2026-12-07",
        endDate: "2026-12-11",
      });
      const balanceRow = (employeeId: string) =>
        app.prisma.overtimeAccount.findUnique({ where: { employeeId } });
      expect(await balanceRow(a.employeeId)).toBeNull();
      expect(await balanceRow(later.employeeId)).toBeNull();

      const run = await takeOver(taker.token, planId);
      expect(run.created.map((c) => c.wishId).sort()).toEqual([inMonth, nextMonth].sort());
      // The current-month wish's person gets the refresh; a wish of a later month cannot move the
      // live saldo and stays without one (D-835-37 unchanged).
      expect(await balanceRow(a.employeeId)).not.toBeNull();
      expect(await balanceRow(later.employeeId)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("WR-04 (D-835-40): a wish moved under the create runs the whole pipeline again on its new dates", async () => {
    const s = await salon();
    const s2 = await salon();
    const taker = await person("taker", s, TAKER);
    const a = await person("a", s);
    const planId = await openPlan(taker.token, s);
    const march = week(3, 2);
    const wishId = await addWish(taker.token, planId, a.employeeId, march);
    // A is homed in S through March and in S2 from April on.
    await app.prisma.employeeSalonAssignment.updateMany({
      where: { employeeId: a.employeeId, kind: "HOME" },
      data: { validUntil: new Date(`${YEAR}-03-31T00:00:00Z`) },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: one.tenant.id,
        employeeId: a.employeeId,
        salonId: s2,
        kind: "HOME",
        validFrom: new Date(`${YEAR}-04-01T00:00:00Z`),
        validUntil: null,
        weekdays: [],
      },
    });

    // After the takeover checked the March wish, it moves to May — days on which A belongs to S2.
    const may = week(5, 2);
    mocks.beforeCreate = async () => {
      await app.prisma.leavePlanWish.update({
        where: { id: wishId },
        data: {
          startDate: new Date(`${may.startDate}T00:00:00Z`),
          endDate: new Date(`${may.endDate}T00:00:00Z`),
        },
      });
    };
    const run = await takeOver(taker.token, planId);
    expect(mocks.beforeCreate).toBeNull();
    // The decision on the March dates does not carry over: May fails the Stammsalon check.
    expect(run.created).toEqual([]);
    expect(run.refused).toMatchObject([{ wishId, code: "LEAVE_PLAN_WISH_NOT_IN_SALON" }]);
    expect(await app.prisma.leaveRequest.count({ where: { employeeId: a.employeeId } })).toBe(0);
  });
});
