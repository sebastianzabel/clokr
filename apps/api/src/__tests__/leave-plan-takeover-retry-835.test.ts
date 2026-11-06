/**
 * Issue #835 (AC-7; D-835-30) — the takeover retries the approval only. When the approval core
 * refuses a wish's request (here forced once with `MONTH_CLOSED`), the request stays PENDING, the
 * wish stores `APPROVAL_MONTH_CLOSED` and the plan stays OPEN; the next run approves the SAME
 * request (no second request), clears the refusal and closes the plan. A deliberately four-eyes
 * PENDING wish (the taker's own) is never approved by a later run, not even by a second taker who
 * may approve it.
 *
 * The approval core is wrapped with `vi.mock` of `contexts/absence/leave-decision` in THIS file only
 * (a hoisted counter makes it refuse once, otherwise it delegates to the real function), so no other
 * suite is affected.
 *
 * Fixture (real clock, plan year = next calendar year): tenant with its default salon S; the taker T
 * (manage + read + create-own, approve tenant-wide), a second taker T2 (manage + approve + read),
 * the person A homed in S. No person names.
 *
 * Mutation proof (Phase 835-07, 2026-11-06) — recorded here, not re-run by CI; reverted with cp:
 * M1 takeover.ts: the selection of linked wishes with an `APPROVAL_` refusal removed -> red: the
 *    retry case (the refused request is never approved again; 1 failed).
 * M2 takeover.ts: the selection widened to every linked wish -> red: the four-eyes case (T's own
 *    request is approved by T2).
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
} from "./setup";
import { roleNameKey, normalizeRolePermissions } from "../contexts/platform/access-role";

const mocks = vi.hoisted(() => ({ refuseOnce: false }));

vi.mock("../contexts/absence/leave-decision", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../contexts/absence/leave-decision")>();
  return {
    ...actual,
    approveLeaveRequestCore: async (
      ...args: Parameters<typeof actual.approveLeaveRequestCore>
    ): ReturnType<typeof actual.approveLeaveRequestCore> => {
      if (mocks.refuseOnce) {
        mocks.refuseOnce = false;
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
const YEAR = new Date().getFullYear() + 1;
const DAY_MS = 24 * 60 * 60 * 1000;

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Mo-Fr of the `nth` Monday of `month` of the plan year. */
function week(month: number, nth: number): { startDate: string; endDate: string } {
  const first = new Date(Date.UTC(YEAR, month - 1, 1));
  const start = new Date(
    first.getTime() + ((8 - first.getUTCDay()) % 7) * DAY_MS + 7 * (nth - 1) * DAY_MS,
  );
  return { startDate: iso(start), endDate: iso(new Date(start.getTime() + 4 * DAY_MS)) };
}

describe("Issue #835 - takeover retries the approval only", () => {
  let app: FastifyInstance;
  let one: Awaited<ReturnType<typeof seedTestData>>;
  let takerToken: string;
  let taker2Token: string;
  let takerEmployeeId: string;
  let taker2UserId: string;
  let aEmployeeId: string;

  function authed(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async function person(label: string, permissions: string[]) {
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
        lastName: "Retry835",
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
    if (permissions.length > 0) {
      const name = `Retry835 ${crypto.randomBytes(3).toString("hex")}`;
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
    }
    return { user, employee, token: await tokenWithoutSignIn(app, email) };
  }

  async function addWish(
    planId: string,
    employeeId: string,
    range: { startDate: string; endDate: string },
  ) {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planId}/wishes`,
      headers: authed(takerToken),
      payload: { employeeId, ...range },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { wish: { id: string } }).wish.id;
  }

  async function takeOver(planId: string, token: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planId}/takeover`,
      headers: authed(token),
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as {
      created: Array<{ wishId: string; leaveRequestId: string }>;
      pending: Array<{ wishId: string; leaveRequestId: string; reason: string }>;
      refused: unknown[];
      planStatus: string;
    };
  }

  beforeAll(async () => {
    app = await getTestApp();
    one = await seedTestData(app, "tr835");
    const t = await person("taker", [MANAGE, READ, CREATE_OWN, APPROVE]);
    takerToken = t.token;
    takerEmployeeId = t.employee.id;
    const t2 = await person("taker2", [MANAGE, READ, APPROVE]);
    taker2Token = t2.token;
    taker2UserId = t2.user.id;
    aEmployeeId = (await person("a", [])).employee.id;
  });

  afterAll(async () => {
    mocks.refuseOnce = false;
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: one.tenant.id } });
      await cleanupTestData(app, one.tenant.id);
    } catch (err) {
      console.error("leave-plan-takeover-retry-835 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("a refused approval leaves the request PENDING and stores APPROVAL_MONTH_CLOSED; the next run approves the SAME request", async () => {
    const opened = await app.inject({
      method: "POST",
      url: "/api/v1/leave/plans",
      headers: authed(takerToken),
      payload: { salonId: one.salonId, year: YEAR },
    });
    expect(opened.statusCode, opened.body).toBe(201);
    const planId = (opened.json() as { plan: { id: string } }).plan.id;
    const wishA = await addWish(planId, aEmployeeId, week(4, 1));
    const wishT = await addWish(planId, takerEmployeeId, week(4, 2));

    mocks.refuseOnce = true;
    const first = await takeOver(planId, takerToken);
    expect(mocks.refuseOnce).toBe(false);
    expect(first.created).toEqual([]);
    expect(first.refused).toEqual([]);
    expect(first.pending.map((p) => [p.wishId, p.reason]).sort()).toEqual(
      [
        [wishA, "APPROVAL_REFUSED"],
        [wishT, "OWN_WISH"],
      ].sort(),
    );
    expect(first.planStatus).toBe("OPEN");

    const requestId = first.pending.find((p) => p.wishId === wishA)!.leaveRequestId;
    const refused = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(refused.status).toBe("PENDING");
    const storedWish = await app.prisma.leavePlanWish.findUniqueOrThrow({ where: { id: wishA } });
    expect(storedWish).toMatchObject({
      leaveRequestId: requestId,
      refusalCode: "APPROVAL_MONTH_CLOSED",
      refusalMessage: "Der Monat ist bereits abgeschlossen",
    });
    expect(storedWish.refusedAt).not.toBeNull();

    // The next run is by the SECOND taker: it may approve everybody, T's own wish included.
    const second = await takeOver(planId, taker2Token);
    expect(second.created.map((c) => [c.wishId, c.leaveRequestId])).toEqual([[wishA, requestId]]);
    expect(second.pending).toEqual([]);
    expect(second.refused).toEqual([]);
    expect(second.planStatus).toBe("TAKEN_OVER");

    // The SAME request, approved by the second taker; no second request for A.
    const approved = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(approved).toMatchObject({ status: "APPROVED", reviewedBy: taker2UserId });
    expect(await app.prisma.leaveRequest.count({ where: { employeeId: aEmployeeId } })).toBe(1);
    const cleared = await app.prisma.leavePlanWish.findUniqueOrThrow({ where: { id: wishA } });
    expect(cleared).toMatchObject({ refusalCode: null, refusalMessage: null, refusedAt: null });
    const approveAudit = await soleAuditRow(app.prisma, {
      where: { entity: "LeaveRequest", entityId: requestId, action: "APPROVE" },
    });
    expect(approveAudit.userId).toBe(taker2UserId);

    // The deliberately four-eyes PENDING wish of the first taker is untouched by the second run.
    const tRequest = await app.prisma.leaveRequest.findFirstOrThrow({
      where: {
        employeeId: takerEmployeeId,
        startDate: new Date(`${week(4, 2).startDate}T00:00:00Z`),
      },
    });
    expect(tRequest.status).toBe("PENDING");
    expect(tRequest.reviewedBy).toBeNull();
    expect(await app.prisma.leaveRequest.count({ where: { employeeId: takerEmployeeId } })).toBe(1);
  });
});
