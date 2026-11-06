/**
 * Issue #835 (AC-5, AC-11; D-04, D-835-06/24) — the validity of a leave plan wish, its edit and soft
 * removal, and the manager path with its identical 404, against the real database and the routes.
 *
 * Fixture (fake clock 2026-11-10, installed BEFORE the app boots; plan year 2027): tenant one with
 * salons S (the default) and S2, tenant two with its own salon. Open plans: P_S (S, no deadline) and
 * P_S2 (S2). Callers are built from custom roles, never from what the seeded admin holds: the seeded
 * employee EMP (system role EMPLOYEE, homed in S), a second plain employee PEER (create-own, homed
 * in S), M_S (manage + read + create-own, SALONS scope [S], homed in S), M_S2 (manage + read, SALONS
 * scope [S2]; cannot even read the plan of S), M_S2R (manage over S2 plus read + create-own over the
 * tenant), Q (homed in S2 only) and X (homed in S until 2027-06-30, in S2 from 2027-07-01). Persons
 * that only appear as the target of a manager write (exit, hire, anonymised) carry a user and no
 * role. No person names.
 *
 * Mutation proof (Phase 835-05, 2026-11-06) — recorded here, not re-run by CI; each change was
 * reverted with cp afterwards (diff against the backup empty):
 * M1 wish-write.ts `validateWishRules`: the blocking request overlap removed -> red: the PENDING,
 *    APPROVED, CANCELLATION_REQUESTED and SICK cases (4 failed | 16 passed).
 * M2 wish-write.ts `validateWishRules`: the other-wish check removed -> STAYS GREEN (20 passed):
 *    the database exclusion `LeavePlanWish_no_overlap_active` answers the same 409 with the same
 *    text through `isWishOverlapExclusion`, so the application check is defence in depth that no
 *    observable behaviour separates from the constraint. Not provable here, by design.
 * M3 api/leave-plans.ts `admitWishWrite`: the `if (!covers)` refusal removed -> red: the identical
 *    404 case (1 failed | 19 passed).
 * M4 wish-write.ts `employedOnEveryWishDay`: the last-day check removed -> red: the exit-date case
 *    (1 failed | 19 passed).
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
  tokenWithoutSignIn,
  auditRowsFor,
} from "./setup";
import { roleNameKey, normalizeRolePermissions } from "../contexts/platform/access-role";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import { LEAVE_OVERLAP_ERROR } from "../contexts/absence/leave-overlap";

const MANAGE = "leave-plan:manage:ZUGEWIESEN";
const READ = "leave-request:read:ZUGEWIESEN";
const CREATE_OWN = "leave-request:create:EIGENE";
const WISH_NOT_FOUND = '{"error":"Wunsch nicht gefunden"}';
const PLAN_NOT_FOUND = '{"error":"Urlaubsplanung nicht gefunden"}';
const PERSON_NOT_FOUND = '{"error":"Mitarbeiter nicht gefunden"}';
const YEAR = 2027;
const UNKNOWN_UUID = "00000000-0000-4000-8000-000000000835";

type Scope = { type: "TENANT" } | { type: "SALONS"; salonIds: string[] };
type Grant = { permissions: string[]; scope: Scope };

describe("Issue #835 - leave plan wishes (validity, edit, removal, manager path)", () => {
  let app: FastifyInstance;
  let one: Awaited<ReturnType<typeof seedTestData>>;
  let two: Awaited<ReturnType<typeof seedTestData>>;
  let salonS2: { id: string };
  let planS: string;
  let planS2: string;
  let sickTypeId: string;
  const tokens: Record<string, string> = {};
  const ids: Record<string, { userId: string; employeeId: string }> = {};
  const created: string[] = [];

  function authed(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async function homeIn(
    employeeId: string,
    salonId: string,
    validFrom: string,
    validUntil: string | null = null,
  ) {
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: one.tenant.id,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date(`${validFrom}T00:00:00Z`),
        validUntil: validUntil ? new Date(`${validUntil}T00:00:00Z`) : null,
        weekdays: [],
      },
    });
  }

  /** A user and an employee, optionally with role grants; homed by the caller. */
  async function person(
    label: string,
    grants: Grant[],
    employee: Partial<{
      hireDate: Date;
      exitDate: Date | null;
      firstName: string;
      lastName: string;
    }> = {},
  ) {
    const email = `${label}-${crypto.randomBytes(3).toString("hex")}@example.invalid`;
    const user = await app.prisma.user.create({
      data: { email, passwordHash: await bcrypt.hash("test1234", 4), isActive: true },
    });
    const row = await app.prisma.employee.create({
      data: {
        tenantId: one.tenant.id,
        userId: user.id,
        employeeNumber: `P${crypto.randomBytes(4).toString("hex")}`,
        firstName: employee.firstName ?? label,
        lastName: employee.lastName ?? "Wish835",
        hireDate: employee.hireDate ?? new Date("2024-01-01"),
        exitDate: employee.exitDate ?? null,
      },
    });
    for (const grant of grants) {
      const name = `Wish835 ${crypto.randomBytes(3).toString("hex")}`;
      const role = await app.prisma.accessRole.create({
        data: {
          tenantId: one.tenant.id,
          name,
          nameKey: roleNameKey(name),
          permissions: normalizeRolePermissions(grant.permissions),
        },
      });
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: one.tenant.id,
          userId: user.id,
          accessRoleId: role.id,
          scopeType: grant.scope.type,
          salonIds: grant.scope.type === "SALONS" ? grant.scope.salonIds : [],
          employeeIds: [],
        },
      });
    }
    const token = grants.length > 0 ? await tokenWithoutSignIn(app, email) : "";
    return { userId: user.id, employeeId: row.id, token };
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T10:00:00.000Z"));
    app = await getTestApp();
    one = await seedTestData(app, "lw835a");
    two = await seedTestData(app, "lw835b");
    salonS2 = await createTestSalon(app.prisma, one.tenant.id, { name: "Wish835 S2" });
    const S = one.salonId;

    sickTypeId = (
      await app.prisma.leaveType.create({
        data: { tenantId: one.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
      })
    ).id;

    // EMP is the seeded employee (system role EMPLOYEE), homed in S.
    await homeIn(one.employee.id, S, "2024-01-01");
    ids.emp = { userId: one.empUser.id, employeeId: one.employee.id };
    tokens.emp = one.empToken;

    const all = (permissions: string[]): Grant => ({ permissions, scope: { type: "TENANT" } });
    const salons = (permissions: string[], salonIds: string[]): Grant => ({
      permissions,
      scope: { type: "SALONS", salonIds },
    });

    const roster: Array<[string, Grant[], string, Parameters<typeof person>[2]?]> = [
      ["peer", [all([CREATE_OWN])], S],
      ["mS", [salons([MANAGE, READ, CREATE_OWN], [S])], S],
      ["mS2", [salons([MANAGE, READ], [salonS2.id])], salonS2.id],
      ["mS2r", [salons([MANAGE], [salonS2.id]), all([READ, CREATE_OWN])], salonS2.id],
      ["q", [all([CREATE_OWN])], salonS2.id],
    ];
    for (const [label, grants, home, extra] of roster) {
      const p = await person(label, grants, extra ?? {});
      await homeIn(p.employeeId, home, "2024-01-01");
      ids[label] = { userId: p.userId, employeeId: p.employeeId };
      tokens[label] = p.token;
    }

    // X changes salon in the middle of 2027: S until 30 June, S2 from 1 July.
    const x = await person("x", [all([CREATE_OWN])]);
    await homeIn(x.employeeId, S, "2024-01-01", "2027-06-30");
    await homeIn(x.employeeId, salonS2.id, "2027-07-01");
    ids.x = { userId: x.userId, employeeId: x.employeeId };
    tokens.x = x.token;

    // Targets of manager writes only: no role, homed in S.
    const targets: Array<[string, Parameters<typeof person>[2]]> = [
      ["exit", { exitDate: new Date("2027-02-10T22:59:59Z") }],
      ["hire", { hireDate: new Date("2027-05-01T00:00:00Z") }],
      ["anon", { firstName: "Gelöscht", lastName: "GELÖSCHT-835" }],
    ];
    for (const [label, extra] of targets) {
      const p = await person(label, [], extra);
      await homeIn(p.employeeId, S, "2024-01-01");
      ids[label] = { userId: p.userId, employeeId: p.employeeId };
    }

    planS = (
      await app.prisma.leavePlan.create({
        data: { tenantId: one.tenant.id, salonId: S, year: YEAR, openedByUserId: ids.mS.userId },
      })
    ).id;
    planS2 = (
      await app.prisma.leavePlan.create({
        data: {
          tenantId: one.tenant.id,
          salonId: salonS2.id,
          year: YEAR,
          openedByUserId: ids.mS2.userId,
        },
      })
    ).id;
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: one.tenant.id } });
      await cleanupTestData(app, one.tenant.id);
      await cleanupTestData(app, two.tenant.id);
    } catch (err) {
      console.error("leave-plan-wishes-835 cleanup failed:", err);
    }
    await closeTestApp();
  });

  function post(token: string, planId: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planId}/wishes`,
      headers: authed(token),
      payload,
    });
  }
  function patch(token: string, planId: string, wishId: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/leave/plans/${planId}/wishes/${wishId}`,
      headers: authed(token),
      payload,
    });
  }
  function del(token: string, planId: string, wishId: string) {
    return app.inject({
      method: "DELETE",
      url: `/api/v1/leave/plans/${planId}/wishes/${wishId}`,
      headers: authed(token),
    });
  }

  /** Posts a wish that must succeed and returns its id; remembered for the final cleanup check. */
  async function wishOk(token: string, planId: string, payload: Record<string, unknown>) {
    const res = await post(token, planId, payload);
    expect(res.statusCode, res.body).toBe(201);
    const id = (res.json() as { wish: { id: string } }).wish.id;
    created.push(id);
    return id;
  }

  async function dropWish(id: string) {
    await app.prisma.leavePlanWish.deleteMany({ where: { id } });
  }

  async function request(
    employeeId: string,
    status: "PENDING" | "APPROVED" | "CANCELLATION_REQUESTED" | "REJECTED" | "CANCELLED",
    startDate: string,
    endDate: string,
    leaveTypeId: string = one.vacationType.id,
  ) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId,
        startDate: new Date(`${startDate}T00:00:00Z`),
        endDate: new Date(`${endDate}T00:00:00Z`),
        days: 3,
        status,
      },
    });
  }

  describe("overlap with a request or another wish", () => {
    it.each([
      ["PENDING", "2027-02-01", "2027-02-03", "2027-02-02", "2027-02-04"],
      ["APPROVED", "2027-02-08", "2027-02-10", "2027-02-10", "2027-02-12"],
      ["CANCELLATION_REQUESTED", "2027-02-15", "2027-02-17", "2027-02-14", "2027-02-15"],
    ] as const)(
      "a wish over a %s request of the same person is 409 LEAVE_PLAN_WISH_OVERLAP with the request text",
      async (status, from, to, wishFrom, wishTo) => {
        await request(ids.emp.employeeId, status, from, to);
        const res = await post(tokens.emp, planS, { startDate: wishFrom, endDate: wishTo });
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json()).toEqual({ error: LEAVE_OVERLAP_ERROR, code: "LEAVE_PLAN_WISH_OVERLAP" });
      },
    );

    it("a wish over an APPROVED SICK row is refused too (the same blocking set as a request)", async () => {
      await request(ids.emp.employeeId, "APPROVED", "2027-02-22", "2027-02-24", sickTypeId);
      const res = await post(tokens.emp, planS, { startDate: "2027-02-23", endDate: "2027-02-23" });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ code: "LEAVE_PLAN_WISH_OVERLAP" });
    });

    it.each(["REJECTED", "CANCELLED"] as const)(
      "a wish over a %s request is accepted (201)",
      async (status) => {
        const from = status === "REJECTED" ? "2027-03-01" : "2027-03-08";
        const to = status === "REJECTED" ? "2027-03-03" : "2027-03-10";
        await request(ids.emp.employeeId, status, from, to);
        const id = await wishOk(tokens.emp, planS, { startDate: from, endDate: to });
        await dropWish(id);
      },
    );

    it("a Berufsschule Absence, a Betriebsurlaub and a public holiday on the days do not refuse a wish", async () => {
      await app.prisma.absence.create({
        data: {
          employeeId: ids.emp.employeeId,
          type: "VOCATIONAL_SCHOOL",
          startDate: new Date("2027-03-15T00:00:00Z"),
          endDate: new Date("2027-03-16T00:00:00Z"),
          days: 2,
          createdBy: ids.mS.userId,
        },
      });
      await app.prisma.companyShutdown.create({
        data: {
          tenantId: one.tenant.id,
          name: "Wish835 shutdown",
          startDate: new Date("2027-03-17T00:00:00Z"),
          endDate: new Date("2027-03-18T00:00:00Z"),
        },
      });
      await app.prisma.publicHoliday.create({
        data: {
          tenantId: one.tenant.id,
          salonId: one.salonId,
          date: new Date("2027-03-19T00:00:00Z"),
          name: "Wish835 holiday",
          federalState: "BAYERN",
          year: YEAR,
        },
      });
      const id = await wishOk(tokens.emp, planS, {
        startDate: "2027-03-15",
        endDate: "2027-03-19",
      });
      await dropWish(id);
    });

    it("a wish overlapping an active wish of the same person in the OPEN plan of another salon is refused until that wish is removed", async () => {
      // X is homed in S until 30 June and in S2 from 1 July: wish A (S) ends in July, wish B (S2) starts on 1 July.
      const a = await wishOk(tokens.x, planS, { startDate: "2027-06-28", endDate: "2027-07-02" });
      const refusedRes = await post(tokens.x, planS2, {
        startDate: "2027-07-01",
        endDate: "2027-07-05",
      });
      expect(refusedRes.statusCode, refusedRes.body).toBe(409);
      expect(refusedRes.json()).toEqual({
        error: "Überschneidung mit einem anderen Urlaubswunsch",
        code: "LEAVE_PLAN_WISH_OVERLAP",
      });

      const removed = await del(tokens.x, planS, a);
      expect(removed.statusCode, removed.body).toBe(204);
      const b = await wishOk(tokens.x, planS2, { startDate: "2027-07-01", endDate: "2027-07-05" });
      await dropWish(b);
    });

    it("an own wish may not be moved onto another own wish; moving off it works", async () => {
      const first = await wishOk(tokens.peer, planS, {
        startDate: "2027-08-02",
        endDate: "2027-08-04",
      });
      const second = await wishOk(tokens.peer, planS, {
        startDate: "2027-08-09",
        endDate: "2027-08-11",
      });
      const onto = await patch(tokens.peer, planS, second, { startDate: "2027-08-03" });
      expect(onto.statusCode, onto.body).toBe(409);
      expect(onto.json()).toMatchObject({ code: "LEAVE_PLAN_WISH_OVERLAP" });
      // Resizing a wish within its own days never collides with itself.
      const within = await patch(tokens.peer, planS, second, { endDate: "2027-08-12" });
      expect(within.statusCode, within.body).toBe(200);
      await dropWish(first);
      await dropWish(second);
    });
  });

  describe("shape and person rules", () => {
    it("a wish outside the plan year is 400 LEAVE_PLAN_WISH_OUTSIDE_YEAR", async () => {
      for (const body of [
        { startDate: "2026-12-30", endDate: "2027-01-02" },
        { startDate: "2027-12-30", endDate: "2028-01-02" },
      ]) {
        const res = await post(tokens.emp, planS, body);
        expect(res.statusCode, res.body).toBe(400);
        expect(res.json()).toMatchObject({ code: "LEAVE_PLAN_WISH_OUTSIDE_YEAR" });
      }
    });

    it("a half day over two days is 400 LEAVE_PLAN_WISH_HALF_DAY_RANGE", async () => {
      const res = await post(tokens.emp, planS, {
        startDate: "2027-09-01",
        endDate: "2027-09-02",
        halfDay: true,
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json()).toMatchObject({ code: "LEAVE_PLAN_WISH_HALF_DAY_RANGE" });
    });

    it("a person homed only in S2 is 400 LEAVE_PLAN_WISH_NOT_HOMED in the plan of S", async () => {
      // M_S2R reads every plan of the tenant but is homed in S2 on every day of the wish.
      const res = await post(tokens.mS2r, planS, {
        startDate: "2027-09-06",
        endDate: "2027-09-07",
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json()).toMatchObject({ code: "LEAVE_PLAN_WISH_NOT_HOMED" });
    });

    it("an exit date before the wish end, a hire date after the wish start and an anonymised person are 400 LEAVE_PLAN_WISH_NOT_EMPLOYED", async () => {
      const cases: Array<[string, string, string]> = [
        ["exit", "2027-02-08", "2027-02-12"],
        ["hire", "2027-04-28", "2027-05-04"],
        ["anon", "2027-09-13", "2027-09-14"],
      ];
      for (const [label, startDate, endDate] of cases) {
        const res = await post(tokens.mS, planS, {
          employeeId: ids[label].employeeId,
          startDate,
          endDate,
        });
        expect(res.statusCode, `${label}: ${res.body}`).toBe(400);
        expect(res.json()).toMatchObject({ code: "LEAVE_PLAN_WISH_NOT_EMPLOYED" });
      }
      // The same persons inside their employment are accepted (except the anonymised one).
      const exitOk = await wishOk(tokens.mS, planS, {
        employeeId: ids.exit.employeeId,
        startDate: "2027-02-08",
        endDate: "2027-02-10",
      });
      const hireOk = await wishOk(tokens.mS, planS, {
        employeeId: ids.hire.employeeId,
        startDate: "2027-05-03",
        endDate: "2027-05-04",
      });
      await dropWish(exitOk);
      await dropWish(hireOk);
    });
  });

  describe("own edit and soft removal", () => {
    it("PATCH moves an own wish (200, UPDATE audit with old and new dates) and DELETE removes it softly", async () => {
      const id = await wishOk(tokens.emp, planS, {
        startDate: "2027-10-04",
        endDate: "2027-10-06",
      });

      const moved = await patch(tokens.emp, planS, id, {
        startDate: "2027-10-05",
        endDate: "2027-10-08",
      });
      expect(moved.statusCode, moved.body).toBe(200);
      expect((moved.json() as { wish: Record<string, unknown> }).wish).toMatchObject({
        id,
        planId: planS,
        startDate: "2027-10-05",
        endDate: "2027-10-08",
        halfDay: false,
        editable: true,
      });
      const updates = await auditRowsFor(app, "LeavePlanWish", id, "UPDATE");
      expect(updates).toHaveLength(1);
      expect(updates[0].userId).toBe(ids.emp.userId);
      expect(updates[0].oldValue).toEqual({
        planId: planS,
        employeeId: ids.emp.employeeId,
        startDate: "2027-10-04",
        endDate: "2027-10-06",
        halfDay: false,
      });
      expect(updates[0].newValue).toEqual({
        planId: planS,
        employeeId: ids.emp.employeeId,
        startDate: "2027-10-05",
        endDate: "2027-10-08",
        halfDay: false,
      });

      // An unchanged body writes nothing.
      const same = await patch(tokens.emp, planS, id, { startDate: "2027-10-05" });
      expect(same.statusCode, same.body).toBe(200);
      expect(await auditRowsFor(app, "LeavePlanWish", id, "UPDATE")).toHaveLength(1);

      const removed = await del(tokens.emp, planS, id);
      expect(removed.statusCode, removed.body).toBe(204);
      const row = await app.prisma.leavePlanWish.findUniqueOrThrow({ where: { id } });
      expect(row.deletedAt).not.toBeNull();
      expect(row.deletedByUserId).toBe(ids.emp.userId);
      const deletes = await auditRowsFor(app, "LeavePlanWish", id, "DELETE");
      expect(deletes).toHaveLength(1);
      expect(deletes[0].userId).toBe(ids.emp.userId);
      expect(deletes[0].oldValue).toMatchObject({
        employeeId: ids.emp.employeeId,
        startDate: "2027-10-05",
        endDate: "2027-10-08",
      });

      // A removed wish does not exist any more: not movable, not removable, not listed.
      expect((await patch(tokens.emp, planS, id, { endDate: "2027-10-09" })).body).toBe(
        WISH_NOT_FOUND,
      );
      const again = await del(tokens.emp, planS, id);
      expect(again.statusCode).toBe(404);
      expect(again.body).toBe(WISH_NOT_FOUND);
      const read = await app.inject({
        method: "GET",
        url: `/api/v1/leave/plans/${planS}`,
        headers: authed(tokens.emp),
      });
      const wishIds = (read.json() as { persons: Array<{ wishes: Array<{ id: string }> }> }).persons
        .flatMap((p) => p.wishes)
        .map((w) => w.id);
      expect(wishIds).not.toContain(id);
    });

    it("a PATCH body without any field is 400; a move with an inverted range is 400 LEAVE_PLAN_WISH_RANGE", async () => {
      const id = await wishOk(tokens.emp, planS, {
        startDate: "2027-10-11",
        endDate: "2027-10-13",
      });
      expect((await patch(tokens.emp, planS, id, {})).statusCode).toBe(400);
      const inverted = await patch(tokens.emp, planS, id, { startDate: "2027-10-20" });
      expect(inverted.statusCode, inverted.body).toBe(400);
      expect(inverted.json()).toMatchObject({ code: "LEAVE_PLAN_WISH_RANGE" });
      await dropWish(id);
    });

    it("a taken-over wish refuses a move with 409 LEAVE_PLAN_WISH_TAKEN_OVER (but may still be removed)", async () => {
      const linkedRequest = await request(
        ids.peer.employeeId,
        "PENDING",
        "2027-11-01",
        "2027-11-03",
      );
      const wish = await app.prisma.leavePlanWish.create({
        data: {
          tenantId: one.tenant.id,
          planId: planS,
          employeeId: ids.peer.employeeId,
          startDate: new Date("2027-11-01T00:00:00Z"),
          endDate: new Date("2027-11-03T00:00:00Z"),
          createdByUserId: ids.peer.userId,
          leaveRequestId: linkedRequest.id,
          takenOverAt: new Date(),
        },
      });
      const moved = await patch(tokens.peer, planS, wish.id, { endDate: "2027-11-04" });
      expect(moved.statusCode, moved.body).toBe(409);
      expect(moved.json()).toMatchObject({ code: "LEAVE_PLAN_WISH_TAKEN_OVER" });

      const removed = await del(tokens.peer, planS, wish.id);
      expect(removed.statusCode, removed.body).toBe(204);
      const stored = await app.prisma.leaveRequest.findUniqueOrThrow({
        where: { id: linkedRequest.id },
      });
      expect(stored.status).toBe("PENDING");
      expect(stored.deletedAt).toBeNull();
    });
  });

  describe("the manager path (D-04, AC-11)", () => {
    it("a Salonmanager of S creates, moves and removes a wish of a person homed in S; every audit names the manager and the person", async () => {
      const id = await wishOk(tokens.mS, planS, {
        employeeId: ids.peer.employeeId,
        startDate: "2027-12-06",
        endDate: "2027-12-08",
      });
      const row = await app.prisma.leavePlanWish.findUniqueOrThrow({ where: { id } });
      expect(row.employeeId).toBe(ids.peer.employeeId);
      expect(row.createdByUserId).toBe(ids.mS.userId);

      const moved = await patch(tokens.mS, planS, id, { endDate: "2027-12-09" });
      expect(moved.statusCode, moved.body).toBe(200);
      const removed = await del(tokens.mS, planS, id);
      expect(removed.statusCode, removed.body).toBe(204);

      const rows = await auditRowsFor(app, "LeavePlanWish", id);
      // The fake clock stamps all three rows with one instant, so the order is not asserted.
      expect(rows.map((r) => r.action).sort()).toEqual(["CREATE", "DELETE", "UPDATE"]);
      for (const audit of rows) {
        expect(audit.userId).toBe(ids.mS.userId);
        const values = (audit.newValue ?? audit.oldValue) as { employeeId: string };
        expect(values.employeeId).toBe(ids.peer.employeeId);
      }
      const update = rows.find((r) => r.action === "UPDATE");
      expect((update?.oldValue as { employeeId: string }).employeeId).toBe(ids.peer.employeeId);
      expect((update?.newValue as { employeeId: string }).employeeId).toBe(ids.peer.employeeId);
    });

    it("a Salonmanager of S2 (cannot read the plan) and a plain employee get the 404 body of an unknown wish", async () => {
      const id = await wishOk(tokens.peer, planS, {
        startDate: "2027-12-13",
        endDate: "2027-12-14",
      });
      for (const who of ["mS2", "mS2r", "emp", "q"]) {
        const real = await patch(tokens[who], planS, id, { endDate: "2027-12-15" });
        const unknown = await patch(tokens[who], planS, UNKNOWN_UUID, { endDate: "2027-12-15" });
        expect(real.statusCode, who).toBe(unknown.statusCode);
        expect(real.body, who).toBe(unknown.body);
        const realDel = await del(tokens[who], planS, id);
        const unknownDel = await del(tokens[who], planS, UNKNOWN_UUID);
        expect(realDel.statusCode, who).toBe(unknownDel.statusCode);
        expect(realDel.body, who).toBe(unknownDel.body);
      }
      // The two readers of the plan answer the WISH body (a plain employee homed in S, a manager
      // of S2 with tenant-wide read), the manager of S2 without read the PLAN body.
      expect((await patch(tokens.emp, planS, id, { endDate: "2027-12-15" })).body).toBe(
        WISH_NOT_FOUND,
      );
      expect((await patch(tokens.mS2r, planS, id, { endDate: "2027-12-15" })).body).toBe(
        WISH_NOT_FOUND,
      );
      expect((await patch(tokens.mS2, planS, id, { endDate: "2027-12-15" })).body).toBe(
        PLAN_NOT_FOUND,
      );
      // Nothing was changed by any of them.
      const row = await app.prisma.leavePlanWish.findUniqueOrThrow({ where: { id } });
      expect(row.deletedAt).toBeNull();
      expect(row.endDate.toISOString().slice(0, 10)).toBe("2027-12-14");
      await dropWish(id);
    });

    it("a wish for a person outside the reach, a foreign tenant's person and an unknown id answer the identical PERSON_NOT_FOUND", async () => {
      const foreign = await app.prisma.employee.findFirstOrThrow({
        where: { tenantId: two.tenant.id },
        select: { id: true },
      });
      const bodies: string[] = [];
      for (const [token, employeeId] of [
        [tokens.mS, ids.q.employeeId], // homed in S2 only: outside the reach of the S manager
        [tokens.mS, foreign.id],
        [tokens.mS, UNKNOWN_UUID],
        [tokens.mS2r, ids.peer.employeeId], // manage reach of S2, person homed in S
        [tokens.emp, ids.peer.employeeId], // a plain employee holds no manage reach at all
      ] as const) {
        const res = await post(token, planS, {
          employeeId,
          startDate: "2027-12-20",
          endDate: "2027-12-21",
        });
        expect(res.statusCode, res.body).toBe(404);
        bodies.push(res.body);
      }
      expect(new Set(bodies)).toEqual(new Set([PERSON_NOT_FOUND]));
      expect(
        await app.prisma.leavePlanWish.count({
          where: {
            employeeId: { in: [ids.q.employeeId, ids.peer.employeeId] },
            startDate: new Date("2027-12-20T00:00:00Z"),
          },
        }),
      ).toBe(0);
    });

    it("a manager reaching the person only through the wish days is admitted for a person who changes salon", async () => {
      // X is homed in S until 30 June: a wish ending in July still has a day in S, so M_S covers X
      // for it; a wish wholly in S2's time does not.
      const covered = await wishOk(tokens.mS, planS, {
        employeeId: ids.x.employeeId,
        startDate: "2027-06-29",
        endDate: "2027-07-01",
      });
      await dropWish(covered);
      const outside = await post(tokens.mS, planS, {
        employeeId: ids.x.employeeId,
        startDate: "2027-07-12",
        endDate: "2027-07-13",
      });
      expect(outside.statusCode, outside.body).toBe(404);
      expect(outside.body).toBe(PERSON_NOT_FOUND);
    });
  });
});
