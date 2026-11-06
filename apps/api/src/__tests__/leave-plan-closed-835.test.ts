/**
 * Issue #835 (AC-10; D-835-15, D-835-26, C-6) — a TAKEN_OVER plan is read-only, and retention deletion
 * of a person who planned leave still works (the person's wishes go first, the plan row stays).
 *
 * Fixture (fake clock 2026-11-10, installed BEFORE the app boots; plan year 2027): tenant one with its
 * default salon S. Callers are built from custom roles: the taker T (leave-plan:manage + approve +
 * read + create-own, TENANT scope, homed in S) and the seeded employee B (system role EMPLOYEE, homed
 * in S). The TAKEN_OVER plan is the result of a REAL takeover through the route, not a row written
 * by hand. The hard-delete fixture follows `employee-home-salon.test.ts` (anonymised person past the
 * 10-year retention, deleted by the seeded admin). No person names.
 *
 * Mutation proof (Phase 835-05, 2026-11-06) — recorded here, not re-run by CI; each change was
 * reverted with cp afterwards (diff against the backup empty):
 * M1 wish-write.ts `updateWish`: the `plan.status !== "OPEN"` refusal removed -> red: the closed PATCH
 *    case answers 409 LEAVE_PLAN_WISH_TAKEN_OVER instead of LEAVE_PLAN_CLOSED (1 failed).
 * M2 api/employees.ts hard-delete: the `hardDeleteLeavePlanWishesForEmployee` call removed -> red: the
 *    hard-delete case (the Restrict foreign key refuses the delete, 500 instead of 204).
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
} from "./setup";
import { roleNameKey, normalizeRolePermissions } from "../contexts/platform/access-role";

const MANAGE = "leave-plan:manage:ZUGEWIESEN";
const APPROVE = "leave-request:approve:ZUGEWIESEN";
const READ = "leave-request:read:ZUGEWIESEN";
const CREATE_OWN = "leave-request:create:EIGENE";
const YEAR = 2027;

describe("Issue #835 - closed plans and the hard-delete path", () => {
  let app: FastifyInstance;
  let one: Awaited<ReturnType<typeof seedTestData>>;
  let takerToken: string;
  let planId: string;
  let bWishId: string;

  function authed(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async function homeInS(employeeId: string) {
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: one.tenant.id,
        employeeId,
        salonId: one.salonId,
        kind: "HOME",
        validFrom: new Date("2024-01-01T00:00:00Z"),
        validUntil: null,
        weekdays: [],
      },
    });
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T10:00:00.000Z"));
    app = await getTestApp();
    one = await seedTestData(app, "lc835a");

    const email = `taker-${crypto.randomBytes(3).toString("hex")}@example.invalid`;
    const user = await app.prisma.user.create({
      data: { email, passwordHash: await bcrypt.hash("test1234", 4), isActive: true },
    });
    const taker = await app.prisma.employee.create({
      data: {
        tenantId: one.tenant.id,
        userId: user.id,
        employeeNumber: `P${crypto.randomBytes(4).toString("hex")}`,
        firstName: "taker",
        lastName: "Closed835",
        hireDate: new Date("2024-01-01"),
      },
    });
    const name = `Closed835 ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: one.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions([MANAGE, APPROVE, READ, CREATE_OWN]),
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
    await homeInS(taker.id);
    takerToken = await tokenWithoutSignIn(app, email);

    await homeInS(one.employee.id);
    await seedEntitlementYears(app, {
      employeeId: one.employee.id,
      leaveTypeId: one.vacationType.id,
      years: [YEAR],
    });

    const open = await app.inject({
      method: "POST",
      url: "/api/v1/leave/plans",
      headers: authed(takerToken),
      payload: { salonId: one.salonId, year: YEAR },
    });
    expect(open.statusCode, open.body).toBe(201);
    planId = (open.json() as { plan: { id: string } }).plan.id;

    const wish = await app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planId}/wishes`,
      headers: authed(one.empToken),
      payload: { startDate: "2027-03-01", endDate: "2027-03-05" },
    });
    expect(wish.statusCode, wish.body).toBe(201);
    bWishId = (wish.json() as { wish: { id: string } }).wish.id;

    const takeover = await app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planId}/takeover`,
      headers: authed(takerToken),
      payload: {},
    });
    expect(takeover.statusCode, takeover.body).toBe(200);
    expect(takeover.json()).toMatchObject({ planStatus: "TAKEN_OVER" });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: one.tenant.id } });
      await cleanupTestData(app, one.tenant.id);
    } catch (err) {
      console.error("leave-plan-closed-835 cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("a TAKEN_OVER plan is read-only", () => {
    const CLOSED = { code: "LEAVE_PLAN_CLOSED" };

    it("POST, PATCH and DELETE of a wish answer 409 LEAVE_PLAN_CLOSED (employee and manager)", async () => {
      const create = await app.inject({
        method: "POST",
        url: `/api/v1/leave/plans/${planId}/wishes`,
        headers: authed(one.empToken),
        payload: { startDate: "2027-05-03", endDate: "2027-05-04" },
      });
      expect(create.statusCode, create.body).toBe(409);
      expect(create.json()).toMatchObject(CLOSED);

      const forPerson = await app.inject({
        method: "POST",
        url: `/api/v1/leave/plans/${planId}/wishes`,
        headers: authed(takerToken),
        payload: { employeeId: one.employee.id, startDate: "2027-05-03", endDate: "2027-05-04" },
      });
      expect(forPerson.statusCode, forPerson.body).toBe(409);
      expect(forPerson.json()).toMatchObject(CLOSED);

      for (const token of [one.empToken, takerToken]) {
        const move = await app.inject({
          method: "PATCH",
          url: `/api/v1/leave/plans/${planId}/wishes/${bWishId}`,
          headers: authed(token),
          payload: { endDate: "2027-03-04" },
        });
        expect(move.statusCode, move.body).toBe(409);
        expect(move.json()).toMatchObject(CLOSED);

        const remove = await app.inject({
          method: "DELETE",
          url: `/api/v1/leave/plans/${planId}/wishes/${bWishId}`,
          headers: authed(token),
        });
        expect(remove.statusCode, remove.body).toBe(409);
        expect(remove.json()).toMatchObject(CLOSED);
      }
      const stored = await app.prisma.leavePlanWish.findUniqueOrThrow({ where: { id: bWishId } });
      expect(stored.deletedAt).toBeNull();
      expect(stored.leaveRequestId).not.toBeNull();
    });

    it("PATCH /plans/:id is 409 LEAVE_PLAN_CLOSED", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/plans/${planId}`,
        headers: authed(takerToken),
        payload: { deadline: "2027-02-01" },
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject(CLOSED);
    });

    it("the plan and its wishes remain readable", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/leave/plans/${planId}`,
        headers: authed(one.empToken),
      });
      expect(res.statusCode, res.body).toBe(200);
      const view = res.json() as {
        plan: { status: string };
        viewer: { canWishOwn: boolean };
        persons: Array<{ wishes: Array<{ id: string; editable: boolean }> }>;
      };
      expect(view.plan.status).toBe("TAKEN_OVER");
      expect(view.viewer.canWishOwn).toBe(false);
      const wishes = view.persons.flatMap((p) => p.wishes);
      expect(wishes.map((w) => w.id)).toEqual([bWishId]);
      expect(wishes[0].editable).toBe(false);
    });
  });

  describe("hard delete of a person who planned leave", () => {
    it("removes the person's wishes (active, linked and removed) before their requests; the plan row and other persons' wishes stay", async () => {
      const uid = `lc835-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const user = await app.prisma.user.create({
        data: {
          email: `deleted-${uid}@anonymized.local`,
          passwordHash: "ANONYMIZED",
          isActive: false,
        },
      });
      const exitDate = new Date();
      exitDate.setFullYear(exitDate.getFullYear() - 11); // past the 10-year retention and the 2-year floor
      const gone = await app.prisma.employee.create({
        data: {
          tenantId: one.tenant.id,
          userId: user.id,
          firstName: "Gelöscht",
          lastName: `GELÖSCHT-${uid}`,
          employeeNumber: `GELÖSCHT-${uid}`,
          hireDate: exitDate,
          exitDate,
        },
      });
      await app.prisma.overtimeAccount.create({ data: { employeeId: gone.id, balanceHours: 0 } });
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId: one.tenant.id,
          employeeId: gone.id,
          salonId: one.salonId,
          kind: "HOME",
          validFrom: exitDate,
          validUntil: null,
          weekdays: [],
        },
      });

      const openPlan = await app.prisma.leavePlan.create({
        data: {
          tenantId: one.tenant.id,
          salonId: one.salonId,
          year: 2028,
          openedByUserId: one.adminUser.id,
        },
      });
      const linkedRequest = await app.prisma.leaveRequest.create({
        data: {
          employeeId: gone.id,
          leaveTypeId: one.vacationType.id,
          startDate: new Date("2028-02-07T00:00:00Z"),
          endDate: new Date("2028-02-09T00:00:00Z"),
          days: 3,
          status: "PENDING",
        },
      });
      const wishBase = { tenantId: one.tenant.id, planId: openPlan.id, employeeId: gone.id };
      await app.prisma.leavePlanWish.createMany({
        data: [
          {
            ...wishBase,
            startDate: new Date("2028-02-07T00:00:00Z"),
            endDate: new Date("2028-02-09T00:00:00Z"),
            createdByUserId: user.id,
            leaveRequestId: linkedRequest.id,
            takenOverAt: new Date(),
          },
          {
            ...wishBase,
            startDate: new Date("2028-03-06T00:00:00Z"),
            endDate: new Date("2028-03-07T00:00:00Z"),
            createdByUserId: user.id,
          },
          {
            ...wishBase,
            startDate: new Date("2028-04-03T00:00:00Z"),
            endDate: new Date("2028-04-04T00:00:00Z"),
            createdByUserId: user.id,
            deletedAt: new Date(),
            deletedByUserId: user.id,
          },
        ],
      });
      expect(await app.prisma.leavePlanWish.count({ where: { employeeId: gone.id } })).toBe(3);

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${gone.id}/hard-delete`,
        headers: authed(await tokenWithoutSignIn(app, one.adminUser.email)),
      });
      expect(res.statusCode, res.body.slice(0, 400)).toBe(204);

      expect(await app.prisma.leavePlanWish.count({ where: { employeeId: gone.id } })).toBe(0);
      expect(await app.prisma.leaveRequest.count({ where: { employeeId: gone.id } })).toBe(0);
      expect(await app.prisma.employee.findUnique({ where: { id: gone.id } })).toBeNull();
      // The plan row stays, and so does a colleague's wish of the TAKEN_OVER plan.
      expect(await app.prisma.leavePlan.findUnique({ where: { id: openPlan.id } })).not.toBeNull();
      expect(await app.prisma.leavePlanWish.count({ where: { id: bWishId } })).toBe(1);
    });
  });
});
