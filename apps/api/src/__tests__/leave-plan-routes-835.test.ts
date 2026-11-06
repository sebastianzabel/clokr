/**
 * Issue #835 (AC-9, AC-12, AC-13; D-835-07/08/22) — the plan lifecycle routes around the tracer:
 * `GET /leave/plans?salonId&year` (the list and its reader admission), `PATCH /leave/plans/:id` (the
 * deadline), the `deadlinePassed` hint of `GET /leave/plans/:id`, the absence of a delete route and
 * the wish-overlap answer of the database exclusion constraint.
 *
 * Fixture (fake clock 2026-11-10, installed BEFORE the app boots): tenant one with salons S (the
 * default), S2 and an inactive S3, tenant two with its own salon. Callers are built from custom
 * roles, never from what the seeded admin holds: M_S (leave-plan:manage + read, SALONS scope [S],
 * homed in S), M_S2 (the same for S2), P_S (create-own only, homed in S: a plan reader by own
 * Stammsalon), P_S2 (create-own only, homed in S2), R_ALL (read, TENANT scope, homed in S2). No
 * person names.
 *
 * Mutation proof (Phase 835-04, 2026-11-06) — recorded here, not re-run by CI; each change reverted
 * with cp afterwards:
 * M1 api/leave-plans.ts: the `manageCovers` check of PATCH removed -> red: "a manage holder of S2
 *    gets the one PLAN_NOT_FOUND body ..." (1 failed | 13 passed).
 * M2 leave-plan/admission.ts `readablePlanYears`: the own-Stammsalon branch removed -> red: the
 *    list case with the person homed in S and the own-Stammsalon case (2 failed).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  soleAuditRow,
  auditRowsFor,
} from "./setup";
import { roleNameKey, normalizeRolePermissions } from "../contexts/platform/access-role";

const MANAGE = "leave-plan:manage:ZUGEWIESEN";
const READ = "leave-request:read:ZUGEWIESEN";
const CREATE_OWN = "leave-request:create:EIGENE";
const SALON_NOT_FOUND = '{"error":"Salon nicht gefunden"}';
const PLAN_NOT_FOUND = '{"error":"Urlaubsplanung nicht gefunden"}';
const YEAR = 2027;

describe("Issue #835 - leave plan list, deadline and reader admission", () => {
  let app: FastifyInstance;
  let one: Awaited<ReturnType<typeof seedTestData>>;
  let two: Awaited<ReturnType<typeof seedTestData>>;
  let salonS2: { id: string };
  let salonS3: { id: string };
  let tokens: Record<string, string> = {};
  let planS: string;
  let planS2: string;

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

  /** A user with exactly the given permissions in the given scope, an employee homed in `home`. */
  async function actor(
    label: string,
    permissions: string[],
    scope: { type: "TENANT" } | { type: "SALONS"; salonIds: string[] },
    home: string,
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
        firstName: label,
        lastName: "PlanRoutes835",
        hireDate: new Date("2024-01-01"),
      },
    });
    const name = `PlanRoutes835 ${crypto.randomBytes(3).toString("hex")}`;
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
        scopeType: scope.type,
        salonIds: scope.type === "SALONS" ? scope.salonIds : [],
        employeeIds: [],
      },
    });
    await homeIn(one.tenant.id, employee.id, home);
    return { user, employee, token: await tokenWithoutSignIn(app, email) };
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T10:00:00.000Z"));
    app = await getTestApp();
    one = await seedTestData(app, "lr835a");
    two = await seedTestData(app, "lr835b");
    salonS2 = await createTestSalon(app.prisma, one.tenant.id, { name: "Plan835 S2" });
    salonS3 = await createTestSalon(app.prisma, one.tenant.id, {
      name: "Plan835 S3",
      isActive: false,
    });

    const mS = await actor(
      "ms",
      [MANAGE, READ],
      { type: "SALONS", salonIds: [one.salonId] },
      one.salonId,
    );
    const mS2 = await actor(
      "ms2",
      [MANAGE, READ],
      { type: "SALONS", salonIds: [salonS2.id] },
      salonS2.id,
    );
    const pS = await actor("ps", [CREATE_OWN], { type: "TENANT" }, one.salonId);
    const pS2 = await actor("ps2", [CREATE_OWN], { type: "TENANT" }, salonS2.id);
    const rAll = await actor("rall", [READ], { type: "TENANT" }, salonS2.id);
    tokens = {
      mS: mS.token,
      mS2: mS2.token,
      pS: pS.token,
      pS2: pS2.token,
      rAll: rAll.token,
      other: two.adminToken,
    };

    const planA = await app.prisma.leavePlan.create({
      data: {
        tenantId: one.tenant.id,
        salonId: one.salonId,
        year: YEAR,
        openedByUserId: mS.user.id,
      },
    });
    planS = planA.id;
    planS2 = (
      await app.prisma.leavePlan.create({
        data: {
          tenantId: one.tenant.id,
          salonId: salonS2.id,
          year: YEAR,
          openedByUserId: mS2.user.id,
        },
      })
    ).id;
    // A plan of the inactive salon exists too; nobody may list it.
    await app.prisma.leavePlan.create({
      data: {
        tenantId: one.tenant.id,
        salonId: salonS3.id,
        year: YEAR,
        openedByUserId: mS.user.id,
      },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: one.tenant.id } });
      await cleanupTestData(app, one.tenant.id);
      await cleanupTestData(app, two.tenant.id);
    } catch (err) {
      console.error("leave-plan-routes-835 cleanup failed:", err);
    }
    await closeTestApp();
  });

  function list(token: string, query: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/leave/plans?${query}`,
      headers: authed(token),
    });
  }

  it("lists the plan of S for a Salonmanager of S, a whole-tenant reader and a person homed in S", async () => {
    for (const who of ["mS", "rAll", "pS"]) {
      const res = await list(tokens[who], `salonId=${one.salonId}&year=${YEAR}`);
      expect(res.statusCode, who).toBe(200);
      const { plans } = res.json() as { plans: Array<{ id: string; salonId: string }> };
      expect(
        plans.map((p) => p.id),
        who,
      ).toEqual([planS]);
      expect(plans[0].salonId).toBe(one.salonId);
    }
  });

  it("answers the one SALON_NOT_FOUND body for every cause that is not an admission", async () => {
    const causes: Array<[string, string, string]> = [
      ["a Salonmanager of S2", tokens.mS2, one.salonId],
      ["a person homed in S2", tokens.pS2, one.salonId],
      ["an unknown salon id", tokens.mS, crypto.randomUUID()],
      ["another tenant's salon", tokens.mS, two.salonId],
      ["an inactive salon (reader with reach)", tokens.rAll, salonS3.id],
      ["the caller of another tenant", tokens.other, one.salonId],
    ];
    const bodies = new Set<string>();
    for (const [label, token, salonId] of causes) {
      const res = await list(token, `salonId=${salonId}&year=${YEAR}`);
      expect(res.statusCode, label).toBe(404);
      expect(res.body, label).toBe(SALON_NOT_FOUND);
      bodies.add(res.body);
    }
    expect(bodies.size).toBe(1);
    // Without a year the same causes answer the same body.
    const noYear = await list(tokens.mS2, `salonId=${one.salonId}`);
    expect(noYear.statusCode).toBe(404);
    expect(noYear.body).toBe(SALON_NOT_FOUND);
  });

  it("a person is admitted by their own Stammsalon only for the salon they are homed in", async () => {
    const own = await list(tokens.pS2, `salonId=${salonS2.id}&year=${YEAR}`);
    expect(own.statusCode).toBe(200);
    expect((own.json() as { plans: Array<{ id: string }> }).plans.map((p) => p.id)).toEqual([
      planS2,
    ]);
    // Without a year the person's own salon is admitted through the salon's plan years.
    const noYear = await list(tokens.pS, `salonId=${one.salonId}`);
    expect(noYear.statusCode).toBe(200);
    expect((noYear.json() as { plans: Array<{ id: string }> }).plans.map((p) => p.id)).toEqual([
      planS,
    ]);
  });

  it("holds only the salon's plans, filtered by year, newest first; a taken-over and a later open plan of one year both appear (AC-12)", async () => {
    const earlier = await app.prisma.leavePlan.create({
      data: {
        tenantId: one.tenant.id,
        salonId: one.salonId,
        year: YEAR,
        status: "TAKEN_OVER",
        openedByUserId: one.adminUser.id,
        openedAt: new Date("2026-10-01T08:00:00Z"),
        takenOverAt: new Date("2026-10-15T08:00:00Z"),
        takenOverByUserId: one.adminUser.id,
      },
    });
    const next = await app.prisma.leavePlan.create({
      data: {
        tenantId: one.tenant.id,
        salonId: one.salonId,
        year: 2028,
        openedByUserId: one.adminUser.id,
      },
    });

    const all = await list(tokens.rAll, `salonId=${one.salonId}`);
    expect(all.statusCode).toBe(200);
    const { plans } = all.json() as {
      plans: Array<{ id: string; year: number; status: string; takenOverAt: string | null }>;
    };
    // year desc, then openedAt desc: 2028, the open 2027 plan (opened later), the taken-over 2027 plan.
    expect(plans.map((p) => p.id)).toEqual([next.id, planS, earlier.id]);
    expect(plans.map((p) => p.status)).toEqual(["OPEN", "OPEN", "TAKEN_OVER"]);
    expect(plans[2].takenOverAt).toBe("2026-10-15T08:00:00.000Z");
    expect(plans.some((p) => p.id === planS2)).toBe(false);

    const onlyYear = await list(tokens.rAll, `salonId=${one.salonId}&year=${YEAR}`);
    expect((onlyYear.json() as { plans: Array<{ id: string }> }).plans.map((p) => p.id)).toEqual([
      planS,
      earlier.id,
    ]);

    const wire = plans[0] as Record<string, unknown>;
    expect(Object.keys(wire).sort()).toEqual([
      "deadline",
      "id",
      "openedAt",
      "salonId",
      "status",
      "takenOverAt",
      "year",
    ]);
  });

  it("rejects a malformed query with 400 before any read", async () => {
    expect((await list(tokens.mS, "year=2027")).statusCode).toBe(400);
    expect((await list(tokens.mS, "salonId=not-a-uuid")).statusCode).toBe(400);
    expect((await list(tokens.mS, `salonId=${one.salonId}&year=1999`)).statusCode).toBe(400);
  });

  it("PATCH sets the deadline (one UPDATE audit with old and new), a second value replaces it, null clears it", async () => {
    const set = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/plans/${planS}`,
      headers: authed(tokens.mS),
      payload: { deadline: "2027-01-31" },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect((set.json() as { plan: { deadline: string | null; id: string } }).plan).toMatchObject({
      id: planS,
      deadline: "2027-01-31",
    });
    const audit = await soleAuditRow(app.prisma, {
      where: { entity: "LeavePlan", entityId: planS, action: "UPDATE" },
    });
    expect(audit.oldValue).toEqual({ deadline: null });
    expect(audit.newValue).toEqual({ deadline: "2027-01-31" });

    const clear = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/plans/${planS}`,
      headers: authed(tokens.mS),
      payload: { deadline: null },
    });
    expect(clear.statusCode).toBe(200);
    expect((clear.json() as { plan: { deadline: string | null } }).plan.deadline).toBeNull();
    const rows = await auditRowsFor(app, "LeavePlan", planS, "UPDATE");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.newValue)).toContainEqual({ deadline: null });
    expect(rows.map((r) => r.oldValue)).toContainEqual({ deadline: "2027-01-31" });
  });

  it("PATCH with the stored value answers 200 and writes no audit row", async () => {
    const before = (await auditRowsFor(app, "LeavePlan", planS, "UPDATE")).length;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/plans/${planS}`,
      headers: authed(tokens.mS),
      payload: { deadline: null },
    });
    expect(res.statusCode).toBe(200);
    expect((await auditRowsFor(app, "LeavePlan", planS, "UPDATE")).length).toBe(before);
  });

  it("PATCH of a taken-over plan is 409 LEAVE_PLAN_CLOSED and changes nothing", async () => {
    const closed = await app.prisma.leavePlan.findFirstOrThrow({
      where: { tenantId: one.tenant.id, salonId: one.salonId, status: "TAKEN_OVER" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/plans/${closed.id}`,
      headers: authed(tokens.mS),
      payload: { deadline: "2027-02-01" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "LEAVE_PLAN_CLOSED" });
    expect(
      (await app.prisma.leavePlan.findUniqueOrThrow({ where: { id: closed.id } })).deadline,
    ).toBeNull();
  });

  it("a manage holder of S2 gets the one PLAN_NOT_FOUND body, identical to an unknown id; a caller without the key is 403", async () => {
    const foreignPlan = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/plans/${planS}`,
      headers: authed(tokens.mS2),
      payload: { deadline: "2027-02-01" },
    });
    const unknown = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/plans/${crypto.randomUUID()}`,
      headers: authed(tokens.mS2),
      payload: { deadline: "2027-02-01" },
    });
    const otherTenant = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/plans/${planS}`,
      headers: authed(tokens.other),
      payload: { deadline: "2027-02-01" },
    });
    for (const res of [foreignPlan, unknown]) {
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(PLAN_NOT_FOUND);
    }
    // The seeded admin of another tenant holds the key, but the plan is not in that tenant.
    expect(otherTenant.statusCode).toBe(404);
    expect(otherTenant.body).toBe(PLAN_NOT_FOUND);
    expect(
      (await app.prisma.leavePlan.findUniqueOrThrow({ where: { id: planS } })).deadline,
    ).toBeNull();

    const noKey = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/plans/${planS}`,
      headers: authed(tokens.pS),
      payload: { deadline: "2027-02-01" },
    });
    expect(noKey.statusCode).toBe(403);
  });

  it("PATCH rejects a malformed deadline with 400", async () => {
    for (const payload of [{ deadline: "31.01.2027" }, { deadline: "2027-13-45" }, {}]) {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/plans/${planS}`,
        headers: authed(tokens.mS),
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("GET /plans/:id reports deadlinePassed once the tenant-local day is past the deadline (the hint, D-835-07)", async () => {
    async function deadlinePassedFor(deadline: string) {
      const set = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/plans/${planS}`,
        headers: authed(tokens.mS),
        payload: { deadline },
      });
      expect(set.statusCode, set.body).toBe(200);
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/leave/plans/${planS}`,
        headers: authed(tokens.mS),
      });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as { plan: { deadlinePassed: boolean; deadline: string } }).plan;
    }
    // The fake clock stands at 2026-11-10: yesterday has passed, today and tomorrow have not.
    expect(await deadlinePassedFor("2026-11-09")).toMatchObject({ deadlinePassed: true });
    expect(await deadlinePassedFor("2026-11-10")).toMatchObject({ deadlinePassed: false });
    expect(await deadlinePassedFor("2026-11-11")).toMatchObject({ deadlinePassed: false });
  });

  it("there is no delete route: DELETE /plans/:id is 404 and the surface lists none", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/leave/plans/${planS}`,
      headers: authed(tokens.mS),
    });
    expect(res.statusCode).toBe(404);
    expect(await app.prisma.leavePlan.count({ where: { id: planS } })).toBe(1);
    const surface = readFileSync(
      join(__dirname, "..", "..", "baselines", "route-surface.txt"),
      "utf8",
    );
    const planLines = surface.split("\n").filter((line) => line.includes("/api/v1/leave/plans"));
    expect(planLines.length, "the plan path is on the surface").toBeGreaterThan(0);
    expect(planLines.join("\n")).not.toMatch(/DELETE/);
  });

  it("a second wish that overlaps an active wish of the same person is refused (409 LEAVE_PLAN_WISH_OVERLAP, the database exclusion)", async () => {
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planS}/wishes`,
      headers: authed(tokens.pS),
      payload: { startDate: "2027-05-03", endDate: "2027-05-07" },
    });
    expect(first.statusCode, first.body).toBe(201);
    const overlapping = await app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planS}/wishes`,
      headers: authed(tokens.pS),
      payload: { startDate: "2027-05-07", endDate: "2027-05-10" },
    });
    expect(overlapping.statusCode).toBe(409);
    expect(overlapping.json()).toEqual({
      error: "Überschneidung mit einem anderen Urlaubswunsch",
      code: "LEAVE_PLAN_WISH_OVERLAP",
    });
    const next = await app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planS}/wishes`,
      headers: authed(tokens.pS),
      payload: { startDate: "2027-05-08", endDate: "2027-05-10" },
    });
    expect(next.statusCode, next.body).toBe(201);
    expect(await app.prisma.leavePlanWish.count({ where: { planId: planS } })).toBe(2);
  });

  it("a racing opener that slips past the application check answers the same 409 (the unique index error is mapped)", async () => {
    // A real Prisma error object of the second OPEN plan, produced by the database itself.
    let realError: unknown = null;
    try {
      await app.prisma.leavePlan.create({
        data: {
          tenantId: one.tenant.id,
          salonId: one.salonId,
          year: YEAR,
          openedByUserId: one.adminUser.id,
        },
      });
    } catch (err) {
      realError = err;
    }
    expect(realError, "the database refused the second OPEN plan").not.toBeNull();

    const spy = vi.spyOn(app.prisma, "$transaction").mockRejectedValueOnce(realError as Error);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leave/plans",
        headers: authed(tokens.mS),
        payload: { salonId: one.salonId, year: 2031 },
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ code: "LEAVE_PLAN_ALREADY_OPEN" });
    } finally {
      spy.mockRestore();
    }
    // An unrelated error is not swallowed.
    const boom = vi.spyOn(app.prisma, "$transaction").mockRejectedValueOnce(new Error("boom"));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/leave/plans",
        headers: authed(tokens.mS),
        payload: { salonId: one.salonId, year: 2032 },
      });
      expect(res.statusCode).toBe(500);
    } finally {
      boom.mockRestore();
    }
  });
});
