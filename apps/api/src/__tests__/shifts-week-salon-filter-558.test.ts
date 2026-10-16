/**
 * Issue #558 (D-01, D-02, D-12, D-13) — the shift planner's week view filtered by a salon. The
 * filter is the endpoint's OWN resolvers evaluated for a salon-only reach (`salonOnlyReach`),
 * intersected with the caller's real `shift:read` reach, so it can only narrow; the contract Soll is
 * a person figure and is never split by salon (the response withholds it with a reason CODE); one
 * validator (`resolveSalonInReach`) and one 404 body for every rejected salon.
 *
 * Fixture (fake clock 2026-06-15T10:00Z installed BEFORE the app boots; week `date=2026-06-17` is
 * Mon 06-15 … Sun 06-21): tenant T with salons A, B and an inactive salon I; a foreign tenant's
 * salon F; manager M (SALONS [A], Stammsalon A); SHIFT_BASED pA (Stammsalon A), springer S
 * (Stammsalon B + DEPLOYMENT in A over June), pB (Stammsalon B). Shifts are created directly:
 * pA@A Tue, S@A Wed, S@B Thu, pB@B Thu.
 *
 * Mutation proof (Phase 558, 2026-10-16) — recorded here, not re-run by CI; each change was
 * reverted after confirming the observed failures:
 * M1 the validator's early return removed (`if (!weekSalon.ok) return …` commented out) → red:
 *    "an out-of-reach, foreign, unknown and inactive salon answer the identical 404 (T-100-09)".
 * M2 the `AND: [shiftScopeWhere(salonOnlyReach(chosen))]` filter dropped from the shift query → red:
 *    "admin with salonId=A sees only the shifts whose OWN salon is A and only A's plannable people",
 *    "coverage is computed from the filtered shifts (Thursday carries only B shifts)" and
 *    "manager with salonId=A sees exactly the admin's shifts for A".
 * M3 `sollUnavailableReason` also sent without a filter → red: "without salonId the week is
 *    unchanged: all shifts, every person, a Soll object, no reason key" and "a single-salon
 *    tenant's unfiltered week is unchanged (no reason key)".
 *
 * Synthetic names only (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";

const PASSWORD = "test1234";
const WEEK = "date=2026-06-17";
const NOT_FOUND = '{"error":"Salon nicht gefunden"}';

type WeekBody = {
  employees: { id: string }[];
  shifts: { id: string; employeeId: string; salonId: string }[];
  coverage: { date: string; effectiveStaff: number }[];
  contractSollMinutesByEmp: Record<string, number> | null;
  sollUnavailableReason?: string;
  salonOpeningHours: unknown;
};

describe("Issue #558 — GET /shifts/week?salonId", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let single: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let salonI: { id: string };
  let salonF: { id: string };
  let manager: { id: string };
  let pA: { id: string };
  let springer: { id: string };
  let pB: { id: string };
  let managerToken: string;
  const shiftIds: Record<string, string> = {};

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createEmployee(label: string, tenantId: string, shiftBased: boolean) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await app.prisma.user.create({
      data: { email: `${s}@example.invalid`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "Wk558",
        hireDate: new Date("2024-01-01"),
      },
    });
    if (shiftBased) {
      await app.prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
          type: "SHIFT_BASED",
          weeklyHours: 32,
          contractWorkDaysPerWeek: 5,
          usualWorkDays: [1, 2, 3, 4, 5],
          validFrom: new Date("2025-01-01"),
        },
      });
    }
    return { user, employee };
  }

  function assign(
    tenantId: string,
    employeeId: string,
    salonId: string,
    kind: "HOME" | "DEPLOYMENT",
    validUntil: string | null,
  ) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId,
        salonId,
        kind,
        validFrom: new Date("2024-01-01T00:00:00Z"),
        validUntil: validUntil ? new Date(`${validUntil}T00:00:00Z`) : null,
      },
    });
  }

  async function shift(key: string, employeeId: string, salonId: string, date: string) {
    const row = await app.prisma.shift.create({
      data: {
        employeeId,
        salonId,
        date: new Date(`${date}T00:00:00Z`),
        startTime: "09:00",
        endTime: "15:00",
      },
    });
    shiftIds[key] = row.id;
  }

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  function get(token: string, url: string) {
    return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  }

  function week(token: string, salonId?: string) {
    return get(
      token,
      `/api/v1/shifts/week?${WEEK}${salonId !== undefined ? `&salonId=${salonId}` : ""}`,
    );
  }

  async function weekBody(token: string, salonId?: string): Promise<WeekBody> {
    const res = await week(token, salonId);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as WeekBody;
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "wk558");
    single = await seedTestData(app, "wk558s");
    foreign = await seedTestData(app, "wk558f");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Nord" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Ost" });
    salonI = await createTestSalon(app.prisma, data.tenant.id, {
      name: "Salon Alt",
      isActive: false,
    });
    salonF = await createTestSalon(app.prisma, foreign.tenant.id, { name: "Salon Fremd" });

    const m = await createEmployee("manager", data.tenant.id, false);
    manager = m.employee;
    await assign(data.tenant.id, manager.id, salonA.id, "HOME", null);
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: m.user.id,
        accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
        scopeType: "SALONS",
        salonIds: [salonA.id],
        employeeIds: [],
      },
    });
    managerToken = await login(m.user.email);

    pA = (await createEmployee("pA", data.tenant.id, true)).employee;
    await assign(data.tenant.id, pA.id, salonA.id, "HOME", null);
    springer = (await createEmployee("springer", data.tenant.id, true)).employee;
    await assign(data.tenant.id, springer.id, salonB.id, "HOME", null);
    await assign(data.tenant.id, springer.id, salonA.id, "DEPLOYMENT", "2026-06-30");
    pB = (await createEmployee("pB", data.tenant.id, true)).employee;
    await assign(data.tenant.id, pB.id, salonB.id, "HOME", null);

    await shift("pA@A", pA.id, salonA.id, "2026-06-16");
    await shift("S@A", springer.id, salonA.id, "2026-06-17");
    await shift("S@B", springer.id, salonB.id, "2026-06-18");
    await shift("pB@B", pB.id, salonB.id, "2026-06-18");
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data.tenant.id } });
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, single.tenant.id);
      await cleanupTestData(app, foreign.tenant.id);
    } catch (err) {
      console.error("shifts-week-salon-filter-558 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("admin with salonId=A sees only the shifts whose OWN salon is A and only A's plannable people", async () => {
    const body = await weekBody(data.adminToken, salonA.id);
    expect(body.shifts.map((s) => s.id).sort((a, b) => a.localeCompare(b))).toEqual(
      [shiftIds["pA@A"], shiftIds["S@A"]].sort((a, b) => a.localeCompare(b)),
    );
    const ids = body.employees.map((e) => e.id);
    for (const id of [pA.id, springer.id, manager.id]) expect(ids).toContain(id);
    expect(ids).not.toContain(pB.id);
  });

  it("coverage is computed from the filtered shifts (Thursday carries only B shifts)", async () => {
    const unfiltered = await weekBody(data.adminToken);
    const filtered = await weekBody(data.adminToken, salonA.id);
    const thursday = (b: WeekBody) => b.coverage.find((c) => c.date === "2026-06-18");
    expect(thursday(unfiltered)?.effectiveStaff).toBeGreaterThan(0);
    expect(thursday(filtered)?.effectiveStaff).toBe(0);
    const wednesday = (b: WeekBody) => b.coverage.find((c) => c.date === "2026-06-17");
    expect(wednesday(filtered)?.effectiveStaff).toBe(wednesday(unfiltered)?.effectiveStaff);
  });

  it("the contract Soll is withheld by a reason code under a filter and the opening hours stay", async () => {
    const unfiltered = await weekBody(data.adminToken);
    const filtered = await weekBody(data.adminToken, salonA.id);
    expect(filtered.contractSollMinutesByEmp).toBeNull();
    expect(filtered.sollUnavailableReason).toBe("SALON_FILTER");
    expect(filtered.salonOpeningHours).toEqual(unfiltered.salonOpeningHours);
  });

  it("without salonId the week is unchanged: all shifts, every person, a Soll object, no reason key", async () => {
    const body = await weekBody(data.adminToken);
    expect(body.shifts.map((s) => s.id)).toEqual(
      expect.arrayContaining([
        shiftIds["pA@A"],
        shiftIds["S@A"],
        shiftIds["S@B"],
        shiftIds["pB@B"],
      ]),
    );
    expect(body.employees.map((e) => e.id)).toContain(pB.id);
    expect(body.contractSollMinutesByEmp).not.toBeNull();
    expect(typeof body.contractSollMinutesByEmp).toBe("object");
    expect("sollUnavailableReason" in body).toBe(false);
  });

  it("manager with salonId=A sees exactly the admin's shifts for A", async () => {
    const admin = await weekBody(data.adminToken, salonA.id);
    const mgr = await weekBody(managerToken, salonA.id);
    const ids = (b: WeekBody) => b.shifts.map((s) => s.id).sort((a, b2) => a.localeCompare(b2));
    expect(ids(mgr)).toEqual(ids(admin));
    expect(mgr.employees.map((e) => e.id)).not.toContain(pB.id);
  });

  it("an out-of-reach, foreign, unknown and inactive salon answer the identical 404 (T-100-09)", async () => {
    const unknown = randomUUID();
    const reference = await week(managerToken, unknown);
    expect(reference.statusCode).toBe(404);
    expect(reference.body).toBe(NOT_FOUND);
    const cases: [string, string][] = [
      ["manager", salonB.id],
      ["manager", salonF.id],
      ["manager", salonI.id],
      ["admin", salonF.id],
      ["admin", salonI.id],
      ["admin", unknown],
    ];
    for (const [who, id] of cases) {
      const res = await week(who === "admin" ? data.adminToken : managerToken, id);
      expect(res.statusCode, `${who} ${id}`).toBe(404);
      expect(res.body, `${who} ${id}`).toBe(reference.body);
    }
  });

  it("the shift:read guard and the uuid format still answer first", async () => {
    const guarded = await week(data.empToken, salonA.id);
    expect(guarded.statusCode).toBe(403);
    const malformed = await week(data.adminToken, "bad");
    expect(malformed.statusCode).toBe(400);
  });

  it("POST /shifts with an explicit salonId creates the shift in that salon although the Stammsalon differs", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: springer.id,
        date: "2026-06-19",
        startTime: "09:00",
        endTime: "15:00",
        salonId: salonA.id,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const created = JSON.parse(res.body) as { id: string };
    const row = await app.prisma.shift.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.salonId).toBe(salonA.id);
    expect(row.salonId).not.toBe(salonB.id);
  });

  it("a single-salon tenant's unfiltered week is unchanged (no reason key)", async () => {
    const body = await weekBody(single.adminToken);
    expect("sollUnavailableReason" in body).toBe(false);
    expect(body.contractSollMinutesByEmp).not.toBeNull();
  });
});
