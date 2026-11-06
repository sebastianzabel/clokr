/**
 * Issue #835 (AC-13; D-06, D-835-03/07) — the deadline of a leave plan is a hint, or by tenant choice a
 * lock on an employee's OWN wish changes; a holder of `leave-plan:manage` over the person is never
 * locked; "today" is the tenant-local day.
 *
 * Fixture: tenant one with its default salon S (time zone Europe/Berlin), an OPEN plan of S for 2027
 * with the deadline 2027-01-31, tenant two without a TenantConfig row. The fake clock is installed
 * BEFORE the app boots and moved per case; every caller token is minted AFTER the move because a
 * token expires against the (fake) clock. Callers are built from custom roles: EMP (the seeded
 * employee, system role EMPLOYEE, homed in S), PEER (create-own only) and MGR (manage + read +
 * create-own, SALONS scope [S], homed in S). No person names.
 *
 * Mutation proof (Phase 835-05, 2026-11-06) — recorded here, not re-run by CI; each change was
 * reverted with cp afterwards (diff against the backup empty):
 * M1 wish-write.ts `deadlineRefusal`: the manager exemption (`actorIsManager`) forced to false ->
 *    red: the Salonmanager case (1 failed | 6 passed).
 * M2 wish-rules.ts `deadlinePassed`: `>` changed to `>=` -> red: the deadline-day case, the day-after
 *    case, the manager case and the release case (4 failed | 3 passed).
 * M3 wish-write.ts `deadlineRefusal`: the tenant-local day replaced by the UTC day -> red: the
 *    midnight case (00:10 Europe/Berlin on 1 February is still 31 January in UTC), the manager case
 *    and the release case (3 failed | 4 passed).
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
  tokenWithoutSignIn,
  auditRowsFor,
} from "./setup";
import { roleNameKey, normalizeRolePermissions } from "../contexts/platform/access-role";

const MANAGE = "leave-plan:manage:ZUGEWIESEN";
const READ = "leave-request:read:ZUGEWIESEN";
const CREATE_OWN = "leave-request:create:EIGENE";
const DEADLINE = "2027-01-31";

describe("Issue #835 - leave plan deadline lock", () => {
  let app: FastifyInstance;
  let one: Awaited<ReturnType<typeof seedTestData>>;
  let two: Awaited<ReturnType<typeof seedTestData>>;
  let planId: string;
  const emails: Record<string, string> = {};
  const employeeIds: Record<string, string> = {};

  /** Moves the fake clock; tokens are minted per call afterwards by `as()`. */
  function clock(iso: string) {
    vi.setSystemTime(new Date(iso));
  }
  async function as(who: string) {
    return { authorization: `Bearer ${await tokenWithoutSignIn(app, emails[who])}` };
  }

  async function person(label: string, permissions: string[], salonIds: string[] | null) {
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
        lastName: "Deadline835",
        hireDate: new Date("2024-01-01"),
      },
    });
    const name = `Deadline835 ${crypto.randomBytes(3).toString("hex")}`;
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
        scopeType: salonIds ? "SALONS" : "TENANT",
        salonIds: salonIds ?? [],
        employeeIds: [],
      },
    });
    await homeInS(employee.id);
    emails[label] = email;
    employeeIds[label] = employee.id;
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
    clock("2026-11-10T10:00:00.000Z");
    app = await getTestApp();
    one = await seedTestData(app, "ld835a");
    two = await seedTestData(app, "ld835b");
    await app.prisma.tenantConfig.upsert({
      where: { tenantId: one.tenant.id },
      update: { timezone: "Europe/Berlin", leavePlanDeadlineLocksWishes: false },
      create: { tenantId: one.tenant.id, timezone: "Europe/Berlin" },
    });

    emails.emp = one.empUser.email;
    employeeIds.emp = one.employee.id;
    await homeInS(one.employee.id);
    await person("peer", [CREATE_OWN], null);
    await person("mgr", [MANAGE, READ, CREATE_OWN], [one.salonId]);

    planId = (
      await app.prisma.leavePlan.create({
        data: {
          tenantId: one.tenant.id,
          salonId: one.salonId,
          year: 2027,
          deadline: new Date(`${DEADLINE}T00:00:00Z`),
          openedByUserId: one.adminUser.id,
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
      console.error("leave-plan-deadline-835 cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function post(who: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planId}/wishes`,
      headers: await as(who),
      payload,
    });
  }
  async function patch(who: string, wishId: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/leave/plans/${planId}/wishes/${wishId}`,
      headers: await as(who),
      payload,
    });
  }
  async function del(who: string, wishId: string) {
    return app.inject({
      method: "DELETE",
      url: `/api/v1/leave/plans/${planId}/wishes/${wishId}`,
      headers: await as(who),
    });
  }
  async function read(who: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/plans/${planId}`,
      headers: await as(who),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as {
      plan: { deadlinePassed: boolean; deadlineLocksWishes: boolean };
      viewer: { ownEditLocked: boolean };
    };
  }
  async function setLocksWishes(value: boolean) {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/work",
      headers: await (async () => ({
        authorization: `Bearer ${await tokenWithoutSignIn(app, one.adminUser.email)}`,
      }))(),
      payload: { leavePlanDeadlineLocksWishes: value },
    });
    expect(res.statusCode, res.body).toBe(200);
  }
  async function wishId(res: Awaited<ReturnType<typeof post>>) {
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { wish: { id: string } }).wish.id;
  }

  it("with the setting off (the default) nothing is locked after the deadline, which the read reports as a hint only", async () => {
    clock("2027-02-05T10:00:00.000Z");
    const created = await wishId(
      await post("emp", { startDate: "2027-03-01", endDate: "2027-03-03" }),
    );
    const moved = await patch("emp", created, { endDate: "2027-03-04" });
    expect(moved.statusCode, moved.body).toBe(200);
    const removed = await del("emp", created);
    expect(removed.statusCode, removed.body).toBe(204);

    const view = await read("emp");
    expect(view.plan.deadlinePassed).toBe(true);
    expect(view.plan.deadlineLocksWishes).toBe(false);
    expect(view.viewer.ownEditLocked).toBe(false);
  });

  it("GET /settings/work answers false for a tenant without a config row", async () => {
    await app.prisma.tenantConfig.deleteMany({ where: { tenantId: two.tenant.id } });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${await tokenWithoutSignIn(app, two.adminUser.email)}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ leavePlanDeadlineLocksWishes: false });
  });

  it("PUT /settings/work persists the setting and its audit diff names the key with old false and new true", async () => {
    await setLocksWishes(true);
    const config = await app.prisma.tenantConfig.findUniqueOrThrow({
      where: { tenantId: one.tenant.id },
    });
    expect(config.leavePlanDeadlineLocksWishes).toBe(true);

    const rows = (await auditRowsFor(app, "TenantConfig", config.id, "UPDATE")).filter(
      (r) => (r.newValue as Record<string, unknown>)?.leavePlanDeadlineLocksWishes !== undefined,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].oldValue).toEqual({ leavePlanDeadlineLocksWishes: false });
    expect(rows[0].newValue).toMatchObject({ leavePlanDeadlineLocksWishes: true });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/settings/work",
      headers: { authorization: `Bearer ${await tokenWithoutSignIn(app, one.adminUser.email)}` },
    });
    expect(res.json()).toMatchObject({ leavePlanDeadlineLocksWishes: true });
  });

  let empWish: string;

  it("on the deadline day itself (tenant-local 23:30) an own create still works", async () => {
    // 2027-01-31T22:30Z is 23:30 on 31 January in Europe/Berlin.
    clock("2027-01-31T22:30:00.000Z");
    empWish = await wishId(await post("emp", { startDate: "2027-03-08", endDate: "2027-03-10" }));
    const view = await read("emp");
    expect(view.plan.deadlinePassed).toBe(false);
    expect(view.viewer.ownEditLocked).toBe(false);
  });

  it("the day after (tenant-local 00:10) own create, move and removal are 409 LEAVE_PLAN_DEADLINE_PASSED", async () => {
    // 2027-01-31T23:10Z is 00:10 on 1 February in Europe/Berlin - still 31 January in UTC.
    clock("2027-01-31T23:10:00.000Z");
    const create = await post("emp", { startDate: "2027-03-15", endDate: "2027-03-16" });
    const move = await patch("emp", empWish, { endDate: "2027-03-11" });
    const remove = await del("emp", empWish);
    for (const res of [create, move, remove]) {
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ code: "LEAVE_PLAN_DEADLINE_PASSED" });
    }
    const stored = await app.prisma.leavePlanWish.findUniqueOrThrow({ where: { id: empWish } });
    expect(stored.deletedAt).toBeNull();
    expect(stored.endDate.toISOString().slice(0, 10)).toBe("2027-03-10");

    const view = await read("emp");
    expect(view.plan.deadlinePassed).toBe(true);
    expect(view.plan.deadlineLocksWishes).toBe(true);
    expect(view.viewer.ownEditLocked).toBe(true);
    expect((await read("peer")).viewer.ownEditLocked).toBe(true);
  });

  it("a Salonmanager covering the person edits their wish after the deadline, and also their own wishes; a plain employee stays locked", async () => {
    clock("2027-02-02T10:00:00.000Z");
    expect((await read("mgr")).viewer.ownEditLocked).toBe(false);

    const moved = await patch("mgr", empWish, { endDate: "2027-03-11" });
    expect(moved.statusCode, moved.body).toBe(200);

    const own = await wishId(await post("mgr", { startDate: "2027-04-12", endDate: "2027-04-13" }));
    const ownMoved = await patch("mgr", own, { endDate: "2027-04-14" });
    expect(ownMoved.statusCode, ownMoved.body).toBe(200);
    const ownRemoved = await del("mgr", own);
    expect(ownRemoved.statusCode, ownRemoved.body).toBe(204);

    const forPeer = await wishId(
      await post("mgr", {
        employeeId: employeeIds.peer,
        startDate: "2027-05-03",
        endDate: "2027-05-04",
      }),
    );
    expect((await del("mgr", forPeer)).statusCode).toBe(204);

    const peer = await post("peer", { startDate: "2027-05-10", endDate: "2027-05-11" });
    expect(peer.statusCode, peer.body).toBe(409);
    expect(peer.json()).toMatchObject({ code: "LEAVE_PLAN_DEADLINE_PASSED" });
  });

  it("switching the setting off releases the lock again", async () => {
    clock("2027-02-03T10:00:00.000Z");
    await setLocksWishes(false);
    const res = await patch("emp", empWish, { endDate: "2027-03-12" });
    expect(res.statusCode, res.body).toBe(200);
    expect((await read("emp")).viewer.ownEditLocked).toBe(false);
  });
});
