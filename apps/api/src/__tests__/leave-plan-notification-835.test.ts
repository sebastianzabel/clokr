/**
 * Issue #835 (AC-N; D-835-18, D-835-32) — opening a leave plan tells every person of the plan
 * population, and the takeover that closes the plan takes the announcement away again.
 *
 * Fixture (fake clock 2026-11-03, installed BEFORE the app boots; plan year 2027): tenant one with
 * salons S (the default) and S2. The opener O (manage + approve + read + create-own, TENANT scope,
 * homed in S) opens the plans. Persons: A homed in S, J homed in S2 until 2027-06-30 and in S from
 * 2027-07-01, P homed in S2 only, X homed in S but exited on 2026-12-31 (not employed in 2027), Z
 * homed in S and anonymised. Expected recipients of the plan of S: A and J; of the plan of S2: J and
 * P — never O, X, Z. No person names (the anonymised sentinel is the one fixed string).
 *
 * Mutation proof (Phase 835-04, 2026-11-06) — recorded here, not re-run by CI; each change reverted
 * with cp afterwards:
 * M1 api/leave-plans.ts: the opener filter (`p.userId !== req.user.sub`) removed -> red: the
 *    recipients case and the dismissal case (the opener receives its own
 *    announcement; 2 failed | 4 passed).
 * M2 leave-plan/takeover.ts: the dismissal removed -> red: the dismissal case (1 failed | 5 passed).
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
} from "./setup";
import { roleNameKey, normalizeRolePermissions } from "../contexts/platform/access-role";
import { resolvePushPolicy, safePushUrl } from "../contexts/platform/notification-push-policy";
import { resolveEmailPolicy } from "../contexts/platform/notification-email-policy";

const MANAGE = "leave-plan:manage:ZUGEWIESEN";
/** D-835-45: the takeover files requests, so a taker needs the create reach over each person. */
const CREATE_OTHERS = "leave-request:create:ZUGEWIESEN";
const APPROVE = "leave-request:approve:ZUGEWIESEN";
const READ = "leave-request:read:ZUGEWIESEN";
const CREATE_OWN = "leave-request:create:EIGENE";
const YEAR = 2027;
const TYPE = "LEAVE_PLAN_OPENED";

describe("Issue #835 - LEAVE_PLAN_OPENED notification", () => {
  let app: FastifyInstance;
  let one: Awaited<ReturnType<typeof seedTestData>>;
  let salonS2: { id: string };
  let openerToken: string;
  let ids: Record<"o" | "a" | "j" | "p" | "x" | "z", { userId: string; employeeId: string }>;
  let planS: string;
  let planS2: string;

  function authed(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async function home(
    employeeId: string,
    salonId: string,
    validFrom: string,
    validUntil: string | null,
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

  async function person(
    label: string,
    names?: { firstName: string; lastName: string },
    extra: { exitDate?: Date } = {},
  ) {
    const email = `${label}-${crypto.randomBytes(3).toString("hex")}@example.invalid`;
    const user = await app.prisma.user.create({
      data: { email, passwordHash: await bcrypt.hash("test1234", 4), isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: one.tenant.id,
        userId: user.id,
        employeeNumber: `P${crypto.randomBytes(4).toString("hex")}`,
        firstName: names?.firstName ?? label,
        lastName: names?.lastName ?? "Notify835",
        hireDate: new Date("2024-01-01"),
        ...extra,
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
    return { user, employee, email };
  }

  async function notices(planId: string) {
    return app.prisma.notification.findMany({
      where: { type: TYPE, relatedType: "LeavePlan", relatedId: planId },
      orderBy: [{ userId: "asc" }, { id: "asc" }],
    });
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // A PAST date on purpose: audit rows written under a fake clock stay in the worker database, and a future stamp is
    // counted by usual-work-days-backfill-route-481 (it counts every leave audit with createdAt >= now).
    vi.setSystemTime(new Date("2026-11-03T10:00:00.000Z"));
    app = await getTestApp();
    one = await seedTestData(app, "ln835a");
    salonS2 = await createTestSalon(app.prisma, one.tenant.id, { name: "Notify835 S2" });

    const o = await person("opener");
    const name = `Notify835 ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: one.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions([MANAGE, APPROVE, READ, CREATE_OWN, CREATE_OTHERS]),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: one.tenant.id,
        userId: o.user.id,
        accessRoleId: role.id,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    await home(o.employee.id, one.salonId, "2024-01-01", null);
    openerToken = await tokenWithoutSignIn(app, o.email);

    const a = await person("a");
    await home(a.employee.id, one.salonId, "2024-01-01", null);
    const j = await person("j");
    await home(j.employee.id, salonS2.id, "2024-01-01", "2027-06-30");
    await home(j.employee.id, one.salonId, "2027-07-01", null);
    const p = await person("p");
    await home(p.employee.id, salonS2.id, "2024-01-01", null);
    const x = await person("x", undefined, { exitDate: new Date("2026-12-31T00:00:00Z") });
    await home(x.employee.id, one.salonId, "2024-01-01", null);
    const z = await person("z", { firstName: "Gelöscht", lastName: "GELÖSCHT-ln835" });
    await home(z.employee.id, one.salonId, "2024-01-01", null);

    const pick = (r: { user: { id: string }; employee: { id: string } }) => ({
      userId: r.user.id,
      employeeId: r.employee.id,
    });
    ids = { o: pick(o), a: pick(a), j: pick(j), p: pick(p), x: pick(x), z: pick(z) };

    for (const who of [a, j]) {
      await seedEntitlementYears(app, {
        employeeId: who.employee.id,
        leaveTypeId: one.vacationType.id,
        years: [YEAR],
      });
    }
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await app.settlePushDispatch();
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: one.tenant.id } });
      await cleanupTestData(app, one.tenant.id);
    } catch (err) {
      console.error("leave-plan-notification-835 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("opening the plan of S notifies exactly the persons of the plan with an account — not the opener, not S2 only, not an exited or anonymised person", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/plans",
      headers: authed(openerToken),
      payload: { salonId: one.salonId, year: YEAR, deadline: "2027-01-31" },
    });
    expect(res.statusCode, res.body).toBe(201);
    planS = (res.json() as { plan: { id: string } }).plan.id;

    const rows = await notices(planS);
    expect(rows.map((r) => r.userId).sort()).toEqual([ids.a.userId, ids.j.userId].sort());
    for (const excluded of [ids.o, ids.p, ids.x, ids.z]) {
      expect(rows.some((r) => r.userId === excluded.userId)).toBe(false);
    }
    expect(rows).toHaveLength(2);
  });

  it("each notice carries the plan as related entity, the deep link and the announcement text", async () => {
    const rows = await notices(planS);
    for (const row of rows) {
      expect(row.relatedType).toBe("LeavePlan");
      expect(row.relatedId).toBe(planS);
      expect(row.link).toBe(`/leave/planung?salonId=${one.salonId}&year=${YEAR}`);
      expect(safePushUrl(row.link), "the push layer accepts the link as it is").toBe(row.link);
      expect(row.title).toBe("Urlaubsplanung eröffnet");
      expect(row.message).toContain(`Urlaubsplanung ${YEAR}`);
      expect(row.message).toContain(one.tenant.name);
      expect(row.message).toContain("Frist: 31.01.2027.");
      expect(row.dismissedAt).toBeNull();
    }
  });

  it("a plan without a deadline names none; a person homed in S2 for part of the year is a recipient of S2 too", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/plans",
      headers: authed(openerToken),
      payload: { salonId: salonS2.id, year: YEAR },
    });
    expect(res.statusCode, res.body).toBe(201);
    planS2 = (res.json() as { plan: { id: string } }).plan.id;

    const rows = await notices(planS2);
    expect(rows.map((r) => r.userId).sort()).toEqual([ids.j.userId, ids.p.userId].sort());
    for (const row of rows) {
      expect(row.message).not.toContain("Frist");
      expect(row.message).toContain("Notify835 S2");
    }
  });

  it("a refused open (409) and a failed notification do not announce or fail the plan", async () => {
    const before = await app.prisma.notification.count({ where: { type: TYPE } });
    const dup = await app.inject({
      method: "POST",
      url: "/api/v1/leave/plans",
      headers: authed(openerToken),
      payload: { salonId: one.salonId, year: YEAR },
    });
    expect(dup.statusCode).toBe(409);
    expect(await app.prisma.notification.count({ where: { type: TYPE } })).toBe(before);

    // A notify failure is logged and never fails the 201: the plan exists either way.
    const spy = vi.spyOn(app, "notify").mockRejectedValue(new Error("mail down"));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leave/plans",
        headers: authed(openerToken),
        payload: { salonId: one.salonId, year: 2028 },
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("the mail policy is always and the push entry is the neutral registry text", () => {
    const mail = resolveEmailPolicy(TYPE);
    expect(mail).toMatchObject({ email: "always" });
    expect(mail && "reason" in mail ? mail.reason.length : 0).toBeGreaterThan(30);
    const push = resolvePushPolicy(TYPE);
    expect(push).toEqual({
      push: "send",
      body: "Die Urlaubsplanung ist eröffnet.",
      ttlSeconds: 3 * 24 * 60 * 60,
    });
  });

  it("the takeover that closes the plan dismisses its announcements; a run that leaves the plan OPEN dismisses none", async () => {
    // S2: P already has an approved request over the wish, so the create core refuses it and the
    // plan stays OPEN.
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: ids.p.employeeId,
        leaveTypeId: one.vacationType.id,
        startDate: new Date("2027-03-01T00:00:00Z"),
        endDate: new Date("2027-03-02T00:00:00Z"),
        days: 2,
        status: "APPROVED",
      },
    });
    const wishP = await app.prisma.leavePlanWish.create({
      data: {
        tenantId: one.tenant.id,
        planId: planS2,
        employeeId: ids.p.employeeId,
        startDate: new Date("2027-03-01T00:00:00Z"),
        endDate: new Date("2027-03-02T00:00:00Z"),
        createdByUserId: ids.p.userId,
      },
    });
    const stays = await app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planS2}/takeover`,
      headers: authed(openerToken),
      payload: {},
    });
    expect(stays.statusCode, stays.body).toBe(200);
    expect((stays.json() as { planStatus: string }).planStatus).toBe("OPEN");
    expect(
      (await app.prisma.leavePlanWish.findUniqueOrThrow({ where: { id: wishP.id } }))
        .leaveRequestId,
    ).toBeNull();
    for (const row of await notices(planS2)) expect(row.dismissedAt, row.userId).toBeNull();

    // S: A's wish becomes a request, nothing is left open, the plan closes.
    await app.prisma.leavePlanWish.create({
      data: {
        tenantId: one.tenant.id,
        planId: planS,
        employeeId: ids.a.employeeId,
        startDate: new Date("2027-03-01T00:00:00Z"),
        endDate: new Date("2027-03-05T00:00:00Z"),
        createdByUserId: ids.a.userId,
      },
    });
    const closes = await app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planS}/takeover`,
      headers: authed(openerToken),
      payload: {},
    });
    expect(closes.statusCode, closes.body).toBe(200);
    expect((closes.json() as { planStatus: string }).planStatus).toBe("TAKEN_OVER");
    const rows = await notices(planS);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.dismissedAt, row.userId).not.toBeNull();
    // The announcements of the other plan are untouched.
    for (const row of await notices(planS2)) expect(row.dismissedAt, row.userId).toBeNull();
  });
});
