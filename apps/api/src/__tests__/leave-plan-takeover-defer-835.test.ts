/**
 * Issue #835 (plan 835-11, D-835-37) — the takeover defers the live-saldo recompute of its approvals
 * and refreshes the stored overtime balance once per person afterwards.
 *
 * Fixture (REAL clock): tenant with one salon; the taker holds `leave-plan:manage` and the approve
 * permission tenant-wide. Persons are raw employees hired 2024-01-01, Mo-Fr contract, no closed
 * month. A "past" week is the Mo-Fr week that ends before tenant-local today (two weeks back); a
 * "future" week lies in the plan year (next calendar year). No person names.
 *
 * Proofs:
 *   1. the decision core with `deferOvertimeRecompute` leaves every row of an approval equal to the
 *      approval without it - status, days, entitlement use and the audit trail - except the stored
 *      balance, which only the undeferred approval writes;
 *   2. a takeover with a past-start wish leaves the stored balance equal to the live saldo (the
 *      refresh ran), once per person even with two past wishes of that person;
 *   3. a takeover whose wishes all start in the future recomputes and writes nothing;
 *   4. a refresh that fails is logged and the takeover still answers 200 with the wish created.
 *
 * Mutation proof (Phase 835-11, 2026-11-07) — recorded here, not re-run by CI; reverted with cp:
 * M1 takeover.ts: the refresh loop removed -> red: the past-start / once-per-person case (stored
 *    balance stays absent) and the failing-refresh case (nothing is logged); 2 failed | 2 passed.
 * M2 leave-decision.ts: `deferOvertimeRecompute` ignored (always recomputes) -> red: the core case
 *    (the deferred person has a stored balance), the future-only case (a balance row appears for a
 *    future leave) and the failing-refresh case (the stored balance is no longer absent);
 *    3 failed | 1 passed.
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
  auditRowsFor,
} from "./setup";
import { roleNameKey, normalizeRolePermissions } from "../contexts/platform/access-role";
import {
  computeOvertimeBalanceHours,
  getTenantTimezone,
  todayInTz,
} from "../contexts/working-time-account";
import { createLeaveRequestCore } from "../contexts/absence/leave-request-create";
import {
  approveLeaveRequestCore,
  loadLeaveRequestForReview,
} from "../contexts/absence/leave-decision";

// The wrapper keeps the real behaviour; a case replaces it once to make the refresh fail or to count.
vi.mock("../contexts/working-time-account", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../contexts/working-time-account")>();
  return { ...actual, updateOvertimeAccount: vi.fn(actual.updateOvertimeAccount) };
});

const MANAGE = "leave-plan:manage:ZUGEWIESEN";
/** D-835-45: the takeover files requests, so a taker needs the create reach over each person. */
const CREATE_OTHERS = "leave-request:create:ZUGEWIESEN";
const APPROVE = "leave-request:approve:ZUGEWIESEN";
const READ = "leave-request:read:ZUGEWIESEN";
const YEAR = new Date().getFullYear() + 1;
const DAY_MS = 24 * 60 * 60 * 1000;

type Person = { userId: string; employeeId: string };

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe("Issue #835 - deferred live-saldo recompute of the takeover (plan 835-11)", () => {
  let app: FastifyInstance;
  let one: Awaited<ReturnType<typeof seedTestData>>;
  let takerToken: string;
  let taker: Person;
  let pastWeek: { startDate: string; endDate: string };
  let pastTuesday: string;
  let futureWeek: { startDate: string; endDate: string };
  let updateSpy: ReturnType<typeof vi.fn>;

  function authed(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async function rawPerson(label: string): Promise<Person> {
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
        lastName: "Defer835",
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
    const thisYear = new Date().getFullYear();
    await seedEntitlementYears(app, {
      employeeId: employee.id,
      leaveTypeId: one.vacationType.id,
      years: [thisYear - 1, thisYear, YEAR],
      totalDays: 30,
    });
    return { userId: user.id, employeeId: employee.id };
  }

  async function actor(label: string, permissions: string[]) {
    const person = await rawPerson(label);
    const name = `Defer835 ${crypto.randomBytes(3).toString("hex")}`;
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
    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: person.userId } });
    return { ...person, token: await tokenWithoutSignIn(app, user.email) };
  }

  async function freshPlan(): Promise<string> {
    await app.prisma.leavePlan.updateMany({
      where: { tenantId: one.tenant.id, salonId: one.salonId, year: YEAR, status: "OPEN" },
      data: { status: "TAKEN_OVER", takenOverAt: new Date(), takenOverByUserId: taker.userId },
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

  async function addWish(
    planId: string,
    employeeId: string,
    range: { startDate: string; endDate: string },
  ): Promise<string> {
    const wish = await app.prisma.leavePlanWish.create({
      data: {
        tenantId: one.tenant.id,
        planId,
        employeeId,
        startDate: new Date(`${range.startDate}T00:00:00Z`),
        endDate: new Date(`${range.endDate}T00:00:00Z`),
        createdByUserId: taker.userId,
      },
    });
    return wish.id;
  }

  async function takeOver(planId: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planId}/takeover`,
      headers: authed(takerToken),
      payload: {},
    });
  }

  type TakeoverBody = {
    created: Array<{ wishId: string; employeeId: string; leaveRequestId: string }>;
    pending: unknown[];
    refused: unknown[];
    planStatus: string;
  };

  async function storedBalance(employeeId: string): Promise<number | null> {
    const account = await app.prisma.overtimeAccount.findUnique({ where: { employeeId } });
    return account ? Number(account.balanceHours) : null;
  }

  /** A PENDING request of the person for the past week, created through the real create core. */
  async function pendingPastRequest(employeeId: string): Promise<string> {
    const created = await createLeaveRequestCore(app, {
      tenantId: one.tenant.id,
      employeeId,
      actorUserId: taker.userId,
      body: { type: "VACATION", ...pastWeek, halfDay: false },
      isOnBehalfOf: true,
      notifyApprovers: false,
    });
    if (!created.ok) throw new Error(`create refused: ${created.reason}`);
    return created.request.id;
  }

  beforeAll(async () => {
    app = await getTestApp();
    one = await seedTestData(app, "tkdef835");
    const t = await actor("taker", [MANAGE, APPROVE, READ, CREATE_OTHERS]);
    taker = { userId: t.userId, employeeId: t.employeeId };
    takerToken = t.token;

    const tz = await getTenantTimezone(app.prisma, one.tenant.id);
    const back = new Date(todayInTz(tz).getTime() - 14 * DAY_MS);
    const monday = new Date(back.getTime() - ((back.getUTCDay() + 6) % 7) * DAY_MS);
    pastWeek = {
      startDate: iso(monday),
      endDate: iso(new Date(monday.getTime() + 4 * DAY_MS)),
    };
    pastTuesday = iso(new Date(monday.getTime() + DAY_MS));
    const first = new Date(Date.UTC(YEAR, 1, 1));
    const futureMonday = new Date(first.getTime() + ((8 - first.getUTCDay()) % 7) * DAY_MS);
    futureWeek = {
      startDate: iso(futureMonday),
      endDate: iso(new Date(futureMonday.getTime() + 4 * DAY_MS)),
    };

    const mod = await import("../contexts/working-time-account");
    updateSpy = mod.updateOvertimeAccount as unknown as ReturnType<typeof vi.fn>;
  });

  afterAll(async () => {
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: one.tenant.id } });
      await cleanupTestData(app, one.tenant.id);
    } catch (err) {
      console.error("leave-plan-takeover-defer-835 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("the decision core with deferOvertimeRecompute changes nothing but the stored balance", async () => {
    const plain = await rawPerson("core-plain");
    const deferred = await rawPerson("core-deferred");
    const plainId = await pendingPastRequest(plain.employeeId);
    const deferredId = await pendingPastRequest(deferred.employeeId);

    for (const [id, defer] of [
      [plainId, false],
      [deferredId, true],
    ] as const) {
      const existing = await loadLeaveRequestForReview(app, id);
      expect(existing).not.toBeNull();
      const decided = await approveLeaveRequestCore(app, {
        existing: existing!,
        reviewerUserId: taker.userId,
        ...(defer ? { deferOvertimeRecompute: true } : {}),
        request: { ip: "127.0.0.1", headers: {} },
      });
      expect(decided.ok).toBe(true);
    }

    const rowOf = async (id: string, employeeId: string) => {
      const row = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id } });
      const entitlement = await app.prisma.leaveEntitlement.findMany({
        where: { employeeId, year: Number(pastWeek.startDate.slice(0, 4)) },
        select: { usedDays: true, totalDays: true, carriedOverDays: true },
      });
      const audits = await auditRowsFor(app, "LeaveRequest", id);
      return {
        row: {
          status: row.status,
          days: Number(row.days),
          daysProvisional: row.daysProvisional,
          halfDay: row.halfDay,
          reviewedBy: row.reviewedBy,
          overtimeCompMinutes: row.overtimeCompMinutes,
          startDate: iso(row.startDate),
          endDate: iso(row.endDate),
        },
        entitlement: entitlement.map((e) => ({
          usedDays: Number(e.usedDays),
          totalDays: Number(e.totalDays),
          carriedOverDays: Number(e.carriedOverDays),
        })),
        audits: audits.map((a) => a.action).sort(),
      };
    };
    const plainState = await rowOf(plainId, plain.employeeId);
    const deferredState = await rowOf(deferredId, deferred.employeeId);
    expect(deferredState).toEqual(plainState);
    expect(plainState.row.status).toBe("APPROVED");
    expect(plainState.entitlement[0]?.usedDays).toBeGreaterThan(0);
    expect(plainState.audits).toContain("APPROVE");

    // The one difference: the undeferred approval persisted the live saldo, the deferred did not.
    const live = await computeOvertimeBalanceHours(app, plain.employeeId);
    expect(live).not.toBeNull();
    expect(await storedBalance(plain.employeeId)).toBe(live);
    expect(await storedBalance(deferred.employeeId)).toBeNull();
  });

  it("a past-start wish: the stored balance equals the live saldo, refreshed once per person", async () => {
    const solo = await rawPerson("past-solo");
    const twice = await rawPerson("past-twice");
    const planId = await freshPlan();
    await addWish(planId, solo.employeeId, pastWeek);
    // Two past wishes of one person: a Tuesday and the Thursday after it.
    const thursday = iso(new Date(new Date(`${pastTuesday}T00:00:00Z`).getTime() + 2 * DAY_MS));
    await addWish(planId, twice.employeeId, { startDate: pastTuesday, endDate: pastTuesday });
    await addWish(planId, twice.employeeId, { startDate: thursday, endDate: thursday });
    expect(await storedBalance(solo.employeeId)).toBeNull();

    updateSpy.mockClear();
    const res = await takeOver(planId);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as TakeoverBody;
    expect(body.refused).toEqual([]);
    expect(body.created).toHaveLength(3);

    for (const person of [solo, twice]) {
      const live = await computeOvertimeBalanceHours(app, person.employeeId);
      expect(live).not.toBeNull();
      expect(await storedBalance(person.employeeId)).toBe(live);
    }
    const refreshed = updateSpy.mock.calls.map((call) => call[1]);
    expect(refreshed.filter((id) => id === twice.employeeId)).toHaveLength(1);
    expect(refreshed.filter((id) => id === solo.employeeId)).toHaveLength(1);
  });

  it("wishes that all start in the future recompute and write nothing", async () => {
    const people = [await rawPerson("future-a"), await rawPerson("future-b")];
    const planId = await freshPlan();
    for (const person of people) await addWish(planId, person.employeeId, futureWeek);

    updateSpy.mockClear();
    const res = await takeOver(planId);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as TakeoverBody).created).toHaveLength(2);
    expect(updateSpy).not.toHaveBeenCalled();
    for (const person of people) expect(await storedBalance(person.employeeId)).toBeNull();
  });

  it("a failing refresh is logged and the takeover still answers 200", async () => {
    const person = await rawPerson("refresh-fails");
    const planId = await freshPlan();
    const wishId = await addWish(planId, person.employeeId, pastWeek);

    updateSpy.mockClear();
    updateSpy.mockRejectedValueOnce(new Error("refresh down"));
    const warn = vi.spyOn(app.log, "warn");
    const res = await takeOver(planId);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as TakeoverBody;
    expect(body.created.map((c) => c.wishId)).toEqual([wishId]);
    expect(body.planStatus).toBe("TAKEN_OVER");
    expect(
      warn.mock.calls.some((call) =>
        JSON.stringify(call[1] ?? call[0]).includes("overtime balance"),
      ),
    ).toBe(true);
    warn.mockRestore();
    // The approval itself stands; only the stored balance is stale (absent).
    const request = await app.prisma.leaveRequest.findUniqueOrThrow({
      where: { id: body.created[0].leaveRequestId },
    });
    expect(request.status).toBe("APPROVED");
    expect(await storedBalance(person.employeeId)).toBeNull();
  });
});
