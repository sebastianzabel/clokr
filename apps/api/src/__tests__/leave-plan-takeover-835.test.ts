/**
 * Issue #835 (AC-7; D-835-13/14/24/27/29/30/35, D-05) — the takeover of a leave plan in full: the
 * buckets of a run, the #836 limit pre-check with per-wish exceptions, the refusals stored on the
 * wish (core refusals, a lapsed employment window, a person who left the plan's salon), the
 * idempotent re-run, the audit marker of a created request and the strictly increasing `createdAt`.
 *
 * Fixture (REAL clock — the ordering case needs a clock that advances; plan year = next calendar
 * year, so no wish is ever in the past): tenant one with its default salon S and a second salon S2.
 * The taker T holds `leave-plan:manage`, `leave-request:read` and `leave-request:create:EIGENE`
 * tenant-wide, but may APPROVE only the persons listed in a PERSONS role assignment (so "inside" and
 * "outside the approve reach" are two named sets). A second approver A2 holds approve + read
 * tenant-wide. Persons are raw employees created per case, homed in S, Mo-Fr contract, 2027+ entitlement.
 * No person names.
 *
 * Mutation proof (Phase 835-07, 2026-11-06) — recorded here, not re-run by CI; each change was
 * reverted with cp afterwards:
 * M1 takeover.ts: the `evaluateLeaveLimits` pre-check disabled -> red: the three limit cases (A is
 *    created first and the approval core's own refusal is stored as APPROVAL_LIMIT_EXCEPTION_REQUIRED
 *    instead of the pre-check code; 3 failed | 9 skipped with -t limit).
 * M2 takeover.ts: the Stammsalon re-check disabled -> red: the salon-move case (1 failed | 11 passed).
 * The ordering mutation (`waitOneTick` removed) is recorded in the parity file.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
  soleAuditRow,
  auditRowsFor,
} from "./setup";
import { roleNameKey, normalizeRolePermissions } from "../contexts/platform/access-role";
import { getTenantTimezone, monthRangeUtc } from "../contexts/working-time-account";

const MANAGE = "leave-plan:manage:ZUGEWIESEN";
/** D-835-45: the takeover files requests, so a taker needs the create reach over each person. */
const CREATE_OTHERS = "leave-request:create:ZUGEWIESEN";
const APPROVE = "leave-request:approve:ZUGEWIESEN";
const READ = "leave-request:read:ZUGEWIESEN";
const CREATE_OWN = "leave-request:create:EIGENE";
const YEAR = new Date().getFullYear() + 1;
const REASON = "Teamabsprache in der Urlaubsrunde";
const DAY_MS = 24 * 60 * 60 * 1000;

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The `nth` Monday (1-based) of `month` (1-based) of the plan year, as a UTC date. */
function monday(month: number, nth: number): Date {
  const first = new Date(Date.UTC(YEAR, month - 1, 1));
  const offset = (8 - first.getUTCDay()) % 7;
  return new Date(first.getTime() + (offset + 7 * (nth - 1)) * DAY_MS);
}

/** Mo-Fr of the `nth` Monday of `month`. */
function week(month: number, nth: number): { startDate: string; endDate: string } {
  const start = monday(month, nth);
  return { startDate: iso(start), endDate: iso(new Date(start.getTime() + 4 * DAY_MS)) };
}

type Person = { userId: string; employeeId: string };

describe("Issue #835 - leave plan takeover in full", () => {
  let app: FastifyInstance;
  let one: Awaited<ReturnType<typeof seedTestData>>;
  let salonS2: string;
  let takerToken: string;
  let taker: Person;
  let approver2: Person;
  let approveAssignmentId: string;
  let approveRoleId: string;

  function authed(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async function rawPerson(label: string, entitlementDays = 30): Promise<Person> {
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
        lastName: "Takeover835",
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
      totalDays: entitlementDays,
    });
    return { userId: user.id, employeeId: employee.id };
  }

  async function roleFor(permissions: string[]) {
    const name = `Takeover835 ${crypto.randomBytes(3).toString("hex")}`;
    return app.prisma.accessRole.create({
      data: {
        tenantId: one.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(permissions),
      },
    });
  }

  /** A person holding exactly `permissions` tenant-wide. */
  async function actor(label: string, permissions: string[]) {
    const person = await rawPerson(label);
    const role = await roleFor(permissions);
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
    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: person.userId } });
    return { ...person, token: await tokenWithoutSignIn(app, user.email) };
  }

  /** Puts the persons into the taker's approve reach. */
  async function approvable(...ids: string[]) {
    const current = await app.prisma.roleAssignment.findUniqueOrThrow({
      where: { id: approveAssignmentId },
    });
    await app.prisma.roleAssignment.update({
      where: { id: approveAssignmentId },
      data: { employeeIds: [...current.employeeIds, ...ids] },
    });
  }

  /** Closes any open plan of S for the year (fixture reset) and opens a fresh one as the taker. */
  async function freshPlan(salonId = one.salonId): Promise<string> {
    await app.prisma.leavePlan.updateMany({
      where: { tenantId: one.tenant.id, salonId, year: YEAR, status: "OPEN" },
      data: { status: "TAKEN_OVER", takenOverAt: new Date(), takenOverByUserId: taker.userId },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/plans",
      headers: authed(takerToken),
      payload: { salonId, year: YEAR },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { plan: { id: string } }).plan.id;
  }

  async function addWish(
    planId: string,
    employeeId: string,
    range: { startDate: string; endDate: string },
    token = takerToken,
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

  async function takeOver(
    planId: string,
    payload: Record<string, unknown> = {},
    token = takerToken,
  ) {
    return app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planId}/takeover`,
      headers: authed(token),
      payload,
    });
  }

  type TakeoverBody = {
    created: Array<{ wishId: string; employeeId: string; leaveRequestId: string }>;
    pending: Array<{ wishId: string; employeeId: string; leaveRequestId: string; reason: string }>;
    refused: Array<{ wishId: string; employeeId: string; code: string; error: string }>;
    planStatus: string;
  };

  async function run(
    planId: string,
    payload: Record<string, unknown> = {},
    token = takerToken,
  ): Promise<TakeoverBody> {
    const res = await takeOver(planId, payload, token);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as TakeoverBody;
  }

  async function closeMonth(employeeId: string, month: number) {
    const tz = await getTenantTimezone(app.prisma, one.tenant.id);
    const { start, end } = monthRangeUtc(YEAR, month, tz);
    await app.prisma.saldoSnapshot.create({
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
        closedBy: "test-system",
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    one = await seedTestData(app, "tk835a");
    salonS2 = (await createTestSalon(app.prisma, one.tenant.id, { name: "Zweiter Salon" })).id;

    const t = await actor("taker", [MANAGE, READ, CREATE_OWN, CREATE_OTHERS]);
    taker = { userId: t.userId, employeeId: t.employeeId };
    takerToken = t.token;
    // The approve reach of the taker: a PERSONS assignment, filled per case through `approvable()`.
    const approveRole = await roleFor([APPROVE]);
    approveRoleId = approveRole.id;
    const assignment = await app.prisma.roleAssignment.create({
      data: {
        tenantId: one.tenant.id,
        userId: taker.userId,
        accessRoleId: approveRoleId,
        scopeType: "PERSONS",
        salonIds: [],
        employeeIds: [crypto.randomUUID()],
      },
    });
    approveAssignmentId = assignment.id;

    const second = await actor("second", [APPROVE, READ]);
    approver2 = { userId: second.userId, employeeId: second.employeeId };
  });

  afterAll(async () => {
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: one.tenant.id } });
      await cleanupTestData(app, one.tenant.id);
    } catch (err) {
      console.error("leave-plan-takeover-835 cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── The three buckets of a run ────────────────────────────────────────────────────────────────

  describe("buckets, notifications and audit marker", () => {
    let planId: string;
    let a: Person;
    let c: Person;
    let wishes: { a: string; t: string; c: string };
    let body: TakeoverBody;

    it("A (approve reach) is created and APPROVED, T's own and C's (outside the reach) wait PENDING", async () => {
      a = await rawPerson("a-buckets");
      c = await rawPerson("c-buckets");
      await approvable(a.employeeId);
      planId = await freshPlan();
      wishes = {
        a: await addWish(planId, a.employeeId, week(3, 1)),
        t: await addWish(planId, taker.employeeId, week(3, 2)),
        c: await addWish(planId, c.employeeId, week(3, 3)),
      };

      body = await run(planId);
      expect(body.refused).toEqual([]);
      expect(body.created.map((x) => x.wishId)).toEqual([wishes.a]);
      expect(body.pending.map((x) => [x.wishId, x.reason]).sort()).toEqual(
        [
          [wishes.t, "OWN_WISH"],
          [wishes.c, "OUTSIDE_APPROVE_REACH"],
        ].sort(),
      );
      expect(body.planStatus).toBe("TAKEN_OVER");

      const states = await app.prisma.leaveRequest.findMany({
        where: {
          id: { in: [...body.created, ...body.pending].map((x) => x.leaveRequestId) },
        },
        select: { employeeId: true, status: true, reviewedBy: true },
      });
      const byPerson = Object.fromEntries(states.map((s) => [s.employeeId, s]));
      expect(byPerson[a.employeeId]).toMatchObject({
        status: "APPROVED",
        reviewedBy: taker.userId,
      });
      expect(byPerson[taker.employeeId]).toMatchObject({ status: "PENDING", reviewedBy: null });
      expect(byPerson[c.employeeId]).toMatchObject({ status: "PENDING", reviewedBy: null });
    });

    it("an approved request pings no approver; PENDING ones ping approvers, never the taker; A hears LEAVE_APPROVED once", async () => {
      const requestOf = Object.fromEntries(
        [...body.created, ...body.pending].map((x) => [x.employeeId, x.leaveRequestId]),
      );
      const about = (employeeId: string) =>
        app.prisma.notification.findMany({
          where: { type: "LEAVE_REQUEST", relatedId: requestOf[employeeId] },
          select: { userId: true },
        });
      expect(await about(a.employeeId)).toEqual([]);
      const forT = await about(taker.employeeId);
      expect(forT.length).toBeGreaterThanOrEqual(1);
      expect(forT.map((n) => n.userId)).not.toContain(taker.userId);
      const forC = await about(c.employeeId);
      expect(forC.length).toBeGreaterThanOrEqual(1);
      expect(forC.map((n) => n.userId)).not.toContain(taker.userId);
      expect(forC.map((n) => n.userId)).toContain(approver2.userId);

      const approved = await app.prisma.notification.findMany({
        where: { type: "LEAVE_APPROVED", userId: a.userId },
        select: { id: true },
      });
      expect(approved).toHaveLength(1);
    });

    it("every created request has a CREATE audit with the plan marker, filed by the taker", async () => {
      for (const [entry, wishId] of [
        [body.created[0]!, wishes.a],
        [body.pending.find((p) => p.wishId === wishes.t)!, wishes.t],
        [body.pending.find((p) => p.wishId === wishes.c)!, wishes.c],
      ] as const) {
        const create = await soleAuditRow(app.prisma, {
          where: { entity: "LeaveRequest", entityId: entry.leaveRequestId, action: "CREATE" },
        });
        expect(create.userId).toBe(taker.userId);
        expect(create.newValue).toMatchObject({
          trigger: "LEAVE_PLAN",
          leavePlanId: planId,
          leavePlanWishId: wishId,
        });
      }
    });

    it("running the takeover again on a plan of linked wishes creates no request and writes one more summary", async () => {
      const before = await app.prisma.leaveRequest.count({
        where: { employee: { tenantId: one.tenant.id } },
      });
      // Reopen the closed plan by hand: the route refuses a TAKEN_OVER plan, the core must not
      // create again for wishes that already carry a request.
      await app.prisma.leavePlan.update({
        where: { id: planId },
        data: { status: "OPEN", takenOverAt: null, takenOverByUserId: null },
      });
      const again = await run(planId);
      expect(again.created).toEqual([]);
      expect(again.pending).toEqual([]);
      expect(again.refused).toEqual([]);
      expect(
        await app.prisma.leaveRequest.count({ where: { employee: { tenantId: one.tenant.id } } }),
      ).toBe(before);
      expect(await auditRowsFor(app, "LeavePlan", planId, "LEAVE_PLAN_TAKEN_OVER")).toHaveLength(2);
    });
  });

  describe("createdAt in start order", () => {
    it("the requests of one person carry strictly increasing createdAt in start-date order", async () => {
      const h = await rawPerson("h-order");
      await approvable(h.employeeId);
      const planId = await freshPlan();
      const ranges = [week(5, 1), week(5, 2), week(5, 3), week(5, 4)];
      // Entered out of order on purpose: the takeover orders by start date, not by entry.
      for (const index of [2, 0, 3, 1]) await addWish(planId, h.employeeId, ranges[index]!);

      const body = await run(planId);
      expect(body.created).toHaveLength(4);
      const rows = await app.prisma.leaveRequest.findMany({
        where: { employeeId: h.employeeId },
        orderBy: { startDate: "asc" },
        select: { startDate: true, createdAt: true },
      });
      expect(rows.map((r) => iso(r.startDate))).toEqual(ranges.map((r) => r.startDate));
      for (let i = 1; i < rows.length; i += 1) {
        expect(rows[i]!.createdAt.getTime()).toBeGreaterThan(rows[i - 1]!.createdAt.getTime());
      }
    });
  });

  // ── #836 limits: pre-check and per-wish exception ─────────────────────────────────────────────

  describe("limit pre-check and exception", () => {
    let planId: string;
    let a: Person;
    let wishA: string;
    let wishT: string;
    let ruleId: string;

    it("a wish the taker would approve over a limit is refused with LEAVE_LIMIT_EXCEPTION_REQUIRED; a wish that stays PENDING is not pre-checked", async () => {
      a = await rawPerson("a-limit");
      await approvable(a.employeeId);
      planId = await freshPlan();
      const range = week(6, 1);
      wishA = await addWish(planId, a.employeeId, range);
      wishT = await addWish(planId, taker.employeeId, range);
      const rule = await app.prisma.leaveLimitRule.create({
        data: {
          tenantId: one.tenant.id,
          salonId: one.salonId,
          groupKind: "ALL",
          maxPersons: 0,
          name: "Fixture blackout",
          validFrom: new Date(`${range.startDate}T00:00:00Z`),
          validUntil: new Date(`${range.endDate}T00:00:00Z`),
        },
      });
      ruleId = rule.id;

      const body = await run(planId);
      expect(body.created).toEqual([]);
      expect(body.refused).toHaveLength(1);
      expect(body.refused[0]).toMatchObject({
        wishId: wishA,
        employeeId: a.employeeId,
        code: "LEAVE_LIMIT_EXCEPTION_REQUIRED",
      });
      expect(body.refused[0]!.error).toContain("Ausnahme");
      expect(body.pending.map((p) => [p.wishId, p.reason])).toEqual([[wishT, "OWN_WISH"]]);
      expect(body.planStatus).toBe("OPEN");

      expect(await app.prisma.leaveRequest.count({ where: { employeeId: a.employeeId } })).toBe(0);
      const stored = await app.prisma.leavePlanWish.findUniqueOrThrow({ where: { id: wishA } });
      expect(stored).toMatchObject({
        leaveRequestId: null,
        refusalCode: "LEAVE_LIMIT_EXCEPTION_REQUIRED",
      });
      expect(stored.refusalMessage).toContain("Ausnahme");
    });

    it("an exception reason of 5 characters is a 400 and changes nothing", async () => {
      const res = await takeOver(planId, { limitExceptions: [{ wishId: wishA, reason: "kurz!" }] });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.body).toContain("Die Begründung der Ausnahme muss 10 bis 500 Zeichen lang sein.");
      expect(await app.prisma.leaveRequest.count({ where: { employeeId: a.employeeId } })).toBe(0);
      const stored = await app.prisma.leavePlanWish.findUniqueOrThrow({ where: { id: wishA } });
      expect(stored.refusalCode).toBe("LEAVE_LIMIT_EXCEPTION_REQUIRED");
    });

    it("an exception for a wish of another plan is ignored; the right reason approves with the audited exception", async () => {
      const ignored = await run(planId, {
        limitExceptions: [{ wishId: crypto.randomUUID(), reason: REASON }],
      });
      expect(ignored.created).toEqual([]);
      expect(ignored.refused.map((r) => r.code)).toEqual(["LEAVE_LIMIT_EXCEPTION_REQUIRED"]);

      const body = await run(planId, {
        limitExceptions: [{ wishId: wishA, reason: `  ${REASON} ` }],
      });
      expect(body.refused).toEqual([]);
      expect(body.created.map((c) => c.wishId)).toEqual([wishA]);
      expect(body.planStatus).toBe("TAKEN_OVER");

      const requestId = body.created[0]!.leaveRequestId;
      const request = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(request.status).toBe("APPROVED");
      const approve = await soleAuditRow(app.prisma, {
        where: { entity: "LeaveRequest", entityId: requestId, action: "APPROVE" },
      });
      const exception = (approve.newValue as Record<string, unknown>).leaveLimitException as {
        reason: string;
        rules: Array<{ ruleId: string }>;
      };
      expect(exception.reason).toBe(REASON);
      expect(exception.rules.map((r) => r.ruleId)).toEqual([ruleId]);

      const stored = await app.prisma.leavePlanWish.findUniqueOrThrow({ where: { id: wishA } });
      expect(stored).toMatchObject({
        leaveRequestId: requestId,
        refusalCode: null,
        refusalMessage: null,
        refusedAt: null,
      });
      await app.prisma.leaveLimitRule.deleteMany({ where: { tenantId: one.tenant.id } });
    });
  });

  // ── Core refusals and re-checks ───────────────────────────────────────────────────────────────

  describe("refusals are stored on the wish and the wish stays", () => {
    it("a closed month and an exceeded entitlement are refused with the core's code; the plan stays OPEN and partially taken over", async () => {
      const closed = await rawPerson("closed");
      const small = await rawPerson("small", 1);
      const good = await rawPerson("good");
      await approvable(closed.employeeId, small.employeeId, good.employeeId);
      await closeMonth(closed.employeeId, 8);
      const planId = await freshPlan();
      const wishClosed = await addWish(planId, closed.employeeId, week(8, 1));
      const wishSmall = await addWish(planId, small.employeeId, week(9, 1));
      const wishGood = await addWish(planId, good.employeeId, week(10, 1));

      const body = await run(planId);
      expect(body.created.map((c) => c.wishId)).toEqual([wishGood]);
      expect(body.refused.map((r) => [r.wishId, r.code]).sort()).toEqual(
        [
          [wishClosed, "CLOSED_MONTH"],
          [wishSmall, "INSUFFICIENT_DAYS_YEAR_1"],
        ].sort(),
      );
      for (const refusal of body.refused) expect(refusal.error.length).toBeGreaterThan(10);
      expect(body.planStatus).toBe("OPEN");

      for (const wishId of [wishClosed, wishSmall]) {
        const stored = await app.prisma.leavePlanWish.findUniqueOrThrow({ where: { id: wishId } });
        expect(stored.leaveRequestId).toBeNull();
        expect(stored.deletedAt).toBeNull();
        expect(stored.refusalCode).not.toBeNull();
        expect(stored.refusalMessage).not.toBeNull();
      }
      expect(
        await app.prisma.leaveRequest.count({ where: { employeeId: closed.employeeId } }),
      ).toBe(0);

      const read = await app.inject({
        method: "GET",
        url: `/api/v1/leave/plans/${planId}`,
        headers: authed(takerToken),
      });
      expect(read.statusCode, read.body).toBe(200);
      expect(
        (read.json() as { plan: { partiallyTakenOver: boolean } }).plan.partiallyTakenOver,
      ).toBe(true);
    });

    it("a person who left before the wish since it was entered is refused LEAVE_PLAN_WISH_NOT_EMPLOYED; the terminal refusal does not keep the plan open (D-835-38)", async () => {
      const g = await rawPerson("g-exit");
      await approvable(g.employeeId);
      const planId = await freshPlan();
      const range = week(7, 2);
      const wishId = await addWish(planId, g.employeeId, range);
      await app.prisma.employee.update({
        where: { id: g.employeeId },
        data: { exitDate: new Date(Date.UTC(YEAR, 5, 1)) },
      });

      const body = await run(planId);
      expect(body.created).toEqual([]);
      expect(body.refused).toMatchObject([{ wishId, code: "LEAVE_PLAN_WISH_NOT_EMPLOYED" }]);
      // D-835-38: no run and no manager can turn this wish into a request of the plan, so it stays as
      // a record with its refusal and the plan closes.
      expect(body.planStatus).toBe("TAKEN_OVER");
      expect(await app.prisma.leaveRequest.count({ where: { employeeId: g.employeeId } })).toBe(0);
      const stored = await app.prisma.leavePlanWish.findUniqueOrThrow({ where: { id: wishId } });
      expect(stored).toMatchObject({
        deletedAt: null,
        leaveRequestId: null,
        refusalCode: "LEAVE_PLAN_WISH_NOT_EMPLOYED",
      });
    });

    it("a person homed elsewhere on every wish day is refused LEAVE_PLAN_WISH_NOT_IN_SALON and still shows in the other salon's plan", async () => {
      const b = await rawPerson("b-moved");
      await approvable(b.employeeId);
      const planS = await freshPlan();
      const range = week(11, 1);
      const wishId = await addWish(planS, b.employeeId, range);
      // A wish the create core refuses (an overlap with a request filed after it) keeps plan S OPEN,
      // so B's wish is still a wish of an open plan when S2's planner is read below (D-835-38: B's
      // own terminal refusal alone would close the plan).
      const h = await rawPerson("h-overlap");
      const hRange = week(11, 3);
      await addWish(planS, h.employeeId, hRange);
      await app.prisma.leaveRequest.create({
        data: {
          employeeId: h.employeeId,
          leaveTypeId: one.vacationType.id,
          startDate: new Date(`${hRange.startDate}T00:00:00Z`),
          endDate: new Date(`${hRange.endDate}T00:00:00Z`),
          days: 5,
          status: "APPROVED",
        },
      });

      // B moves from S to S2 on the first wish day (gapless HOME periods).
      const previousDay = new Date(new Date(`${range.startDate}T00:00:00Z`).getTime() - DAY_MS);
      await app.prisma.employeeSalonAssignment.updateMany({
        where: { employeeId: b.employeeId, kind: "HOME", validUntil: null },
        data: { validUntil: previousDay },
      });
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId: one.tenant.id,
          employeeId: b.employeeId,
          salonId: salonS2,
          kind: "HOME",
          validFrom: new Date(`${range.startDate}T00:00:00Z`),
          validUntil: null,
          weekdays: [],
        },
      });

      const body = await run(planS);
      expect(body.created).toEqual([]);
      const salonRefusals = body.refused.filter((r) => r.wishId === wishId);
      expect(salonRefusals).toHaveLength(1);
      expect(salonRefusals[0]).toMatchObject({ wishId, code: "LEAVE_PLAN_WISH_NOT_IN_SALON" });
      expect(salonRefusals[0]!.error).toContain("Salon");
      expect(body.refused.filter((r) => r.wishId !== wishId).map((r) => r.code)).toEqual([
        "OVERLAP",
      ]);
      expect(body.planStatus).toBe("OPEN");
      expect(await app.prisma.leaveRequest.count({ where: { employeeId: b.employeeId } })).toBe(0);
      const stored = await app.prisma.leavePlanWish.findUniqueOrThrow({ where: { id: wishId } });
      expect(stored).toMatchObject({
        deletedAt: null,
        leaveRequestId: null,
        refusalCode: "LEAVE_PLAN_WISH_NOT_IN_SALON",
      });

      const planS2 = await freshPlan(salonS2);
      const read = await app.inject({
        method: "GET",
        url: `/api/v1/leave/plans/${planS2}`,
        headers: authed(takerToken),
      });
      expect(read.statusCode, read.body).toBe(200);
      const dto = read.json() as {
        persons: Array<{
          employeeId: string;
          wishes: Array<{ id: string; foreignPlan: boolean; editable: boolean }>;
        }>;
      };
      const person = dto.persons.find((p) => p.employeeId === b.employeeId);
      expect(person?.wishes.map((w) => [w.id, w.foreignPlan, w.editable])).toEqual([
        [wishId, true, false],
      ]);
    });
  });

  // ── Wall time of a large plan (P-3) ───────────────────────────────────────────────────────────

  it("a plan of 40 wishes (40 persons, one wish each) is taken over within the reported wall time", async () => {
    const bulk = await actor("bulk", [MANAGE, APPROVE, READ, CREATE_OTHERS]);
    const planId = await freshPlan();
    const people: Person[] = [];
    for (let i = 0; i < 40; i += 1) people.push(await rawPerson(`bulk${i}`));
    const range = week(2, 1);
    for (const person of people) {
      await app.prisma.leavePlanWish.create({
        data: {
          tenantId: one.tenant.id,
          planId,
          employeeId: person.employeeId,
          startDate: new Date(`${range.startDate}T00:00:00Z`),
          endDate: new Date(`${range.endDate}T00:00:00Z`),
          createdByUserId: bulk.userId,
        },
      });
    }
    const started = Date.now();
    const body = await run(planId, {}, bulk.token);
    const seconds = (Date.now() - started) / 1000;
    console.warn(`[835-07] takeover of 40 wishes: ${seconds.toFixed(1)} s`);
    expect(body.created).toHaveLength(40);
    expect(body.refused).toEqual([]);
    expect(body.planStatus).toBe("TAKEN_OVER");
    expect(seconds).toBeLessThan(60);
  }, 240_000);
});
