/**
 * Issue #647 — the week view's coverage uses the rules of the salon in view plus the tenant-wide
 * ones (tracer). A coverage rule written for salon A acts in `GET /shifts/week?salonId=A` only:
 * salon B and the unfiltered view of a multi-salon tenant keep the tenant-wide minimum, and a
 * foreign, unknown or inactive salon is rejected on write with the one 404.
 *
 * Fixture (fake clock 2026-06-15T10:00Z installed BEFORE the app boots; week `date=2026-06-17` is
 * Mon 06-15 … Sun 06-21): tenant T (default salon, plus salons A and B), person pA (HOME A) with one
 * shift pA@A on Tue 2026-06-16 (09:00-15:00, created directly) and a tenant-wide rule (all
 * templates, all days, minStaff 3) created directly. Synthetic names only.
 *
 * Further describes: D-03 (a single-salon tenant, own tenants) and AC 1–3 (a multi-salon tenant with
 * salon rules A all-days 1, B Thursday 4, an inactive salon I all-days 9 and tenant-wide all-days 3 /
 * Friday 5; every precedence edge as one seven-value list).
 *
 * Mutation proof (Phase 647, 2026-11-05) — recorded here, not re-run by CI; each change was made on
 * `contexts/scheduling/coverage-rule.ts` after a `cp` backup and restored by `cp` (`git diff --quiet`
 * clean afterwards); this file and `coverage-rule.test.ts` were run together:
 * M1 the candidate filter removed (every rule of the tenant is a candidate) → red (13 cases), among
 *    them "AC 2: unfiltered, only the tenant-wide rules decide (no salon rule acts)" and
 *    "AC 1/3: salon B — B's Thursday rule applies and the shortfall is measured against it".
 * M2 within-rung preference inverted (tenant-wide before salon) → red (10 cases), among them
 *    "AC 1/3: salon A — A beats tenant-wide within the all-days rung, the Friday tenant-wide rung
 *    beats A, B's rule never acts".
 * M3 a salon rule searched over the whole ladder before any tenant-wide rule → red (3 cases):
 *    the same "AC 1/3: salon A …" case (Friday becomes 1), "a salon manager's filtered view is the
 *    admin's view …" and the pure "a tenant-wide rule on a more specific rung beats a salon rule …".
 * M4 `coverageSalonInView` returns the filter only (no single-salon fallback) → red (2 cases):
 *    "the unfiltered week uses the only active salon's rule; a rule of an inactive salon never acts"
 *    and the pure "without a filter the tenant's only active salon is in view …".
 * M5 the D-03a reach branch disabled → red (3 cases): "D-03a: a salon manager who reaches only
 *    salon A has A in view without any filter", "a salon manager's filtered view is the admin's view
 *    …" (its unfiltered manager line) and the pure "D-03a: a person-free reach of exactly one active
 *    salon puts that salon in view".
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";

const WEEK = "date=2026-06-17";
const TUESDAY = "2026-06-16";
const NOT_FOUND = '{"error":"Salon nicht gefunden"}';
const PASSWORD = "test1234";

type WeekBody = {
  coverage: { date: string; minStaff: number; coverageStatus: string }[];
};

// ── shared fixture helpers ───────────────────────────────────────────────────────────────────────
function uniqueSuffix(label: string): string {
  return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function makePerson(
  app: FastifyInstance,
  tenantId: string,
  label: string,
  salonId: string | null,
) {
  const s = uniqueSuffix(label);
  const user = await app.prisma.user.create({
    data: {
      email: `${s}@example.invalid`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      isActive: true,
    },
  });
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: s.toUpperCase().slice(0, 20),
      firstName: label,
      lastName: "Cov647",
      hireDate: new Date("2024-01-01"),
    },
  });
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
  if (salonId) {
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId: employee.id,
        salonId,
        kind: "HOME",
        validFrom: new Date("2024-01-01T00:00:00Z"),
        validUntil: null,
      },
    });
  }
  return { user, employee };
}

function shiftOn(app: FastifyInstance, employeeId: string, salonId: string, date: string) {
  return app.prisma.shift.create({
    data: {
      employeeId,
      salonId,
      date: new Date(`${date}T00:00:00Z`),
      startTime: "09:00",
      endTime: "15:00",
    },
  });
}

function ruleRow(
  app: FastifyInstance,
  tenantId: string,
  minStaff: number,
  opts: { salonId?: string | null; dayOfWeek?: number } = {},
) {
  return app.prisma.coverageRule.create({
    data: {
      tenantId,
      salonId: opts.salonId ?? null,
      templateId: null,
      dayOfWeek: opts.dayOfWeek ?? -1,
      minStaff,
      requiresNonSupervised: false,
    },
  });
}

async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  return (JSON.parse(res.body) as { accessToken: string }).accessToken;
}

async function weekAs(app: FastifyInstance, token: string, salonId?: string): Promise<WeekBody> {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/shifts/week?${WEEK}${salonId !== undefined ? `&salonId=${salonId}` : ""}`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode, res.body).toBe(200);
  return JSON.parse(res.body) as WeekBody;
}

function minStaffByDay(body: WeekBody): number[] {
  return [...body.coverage].sort((a, b) => a.date.localeCompare(b.date)).map((c) => c.minStaff);
}

function statusOn(body: WeekBody, day: string): string | undefined {
  return body.coverage.find((c) => c.date.startsWith(day))?.coverageStatus;
}

describe("Issue #647 — a coverage rule may name a salon (tracer)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let managerToken: string;

  function week(salonId?: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?${WEEK}${salonId !== undefined ? `&salonId=${salonId}` : ""}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
  }

  async function weekBody(salonId?: string): Promise<WeekBody> {
    const res = await week(salonId);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as WeekBody;
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "cov647");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Nord" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Ost" });

    const suffix = `pa-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `${suffix}@example.invalid`,
        passwordHash: await bcrypt.hash("test1234", 10),
        isActive: true,
      },
    });
    const pA = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: suffix.toUpperCase().slice(0, 20),
        firstName: "pA",
        lastName: "Cov647",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: pA.id,
        type: "SHIFT_BASED",
        weeklyHours: 32,
        contractWorkDaysPerWeek: 5,
        usualWorkDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2025-01-01"),
      },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: pA.id,
        salonId: salonA.id,
        kind: "HOME",
        validFrom: new Date("2024-01-01T00:00:00Z"),
        validUntil: null,
      },
    });
    await app.prisma.shift.create({
      data: {
        employeeId: pA.id,
        salonId: salonA.id,
        date: new Date(`${TUESDAY}T00:00:00Z`),
        startTime: "09:00",
        endTime: "15:00",
      },
    });
    await app.prisma.coverageRule.create({
      data: {
        tenantId: data.tenant.id,
        templateId: null,
        dayOfWeek: -1,
        minStaff: 3,
        requiresNonSupervised: false,
      },
    });
    // Salon manager reaching salon A only (person-free SALONS assignment), Stammsalon A (D-03a)
    const m = await makePerson(app, data.tenant.id, "manager", salonA.id);
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
    managerToken = await loginAs(app, m.user.email);
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data.tenant.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("coverage-rule-salon-647 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("the salon rule is written through the API and acts only in its own filtered view", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/shifts/coverage-rules",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        templateId: null,
        dayOfWeek: -1,
        minStaff: 1,
        requiresNonSupervised: false,
        salonId: salonA.id,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect((JSON.parse(created.body) as { salonId: string }).salonId).toBe(salonA.id);

    const forA = await weekBody(salonA.id);
    expect(forA.coverage).toHaveLength(7);
    expect(forA.coverage.every((c) => c.minStaff === 1)).toBe(true);
    expect(forA.coverage.find((c) => c.date.startsWith(TUESDAY))?.coverageStatus).toBe("ok");

    // Salon B never sees A's rule (AC 1)
    const forB = await weekBody(salonB.id);
    expect(forB.coverage.every((c) => c.minStaff === 3)).toBe(true);

    // The unfiltered view of a three-salon tenant has no salon in view: tenant-wide rules only
    const unfiltered = await weekBody();
    expect(unfiltered.coverage.every((c) => c.minStaff === 3)).toBe(true);
    expect(unfiltered.coverage.find((c) => c.date.startsWith(TUESDAY))?.coverageStatus).toBe(
      "under",
    );
  });

  it("a salon rule for an unknown salon answers the one 404 and writes nothing", async () => {
    const before = await app.prisma.coverageRule.count({ where: { tenantId: data.tenant.id } });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/shifts/coverage-rules",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        templateId: null,
        dayOfWeek: -1,
        minStaff: 1,
        requiresNonSupervised: false,
        salonId: randomUUID(),
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(NOT_FOUND);
    expect(await app.prisma.coverageRule.count({ where: { tenantId: data.tenant.id } })).toBe(
      before,
    );
  });

  it("D-03a: a salon manager who reaches only salon A has A in view without any filter", async () => {
    // A's rule (minStaff 1) was written by the first case; the admin's unfiltered view stays tenant-wide
    expect(minStaffByDay(await weekAs(app, data.adminToken))).toEqual([3, 3, 3, 3, 3, 3, 3]);
    const managerView = await weekAs(app, managerToken);
    expect(minStaffByDay(managerView)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(statusOn(managerView, TUESDAY)).toBe("ok");
    // an explicit filter of the same salon is the same view
    expect(minStaffByDay(await weekAs(app, managerToken, salonA.id))).toEqual([
      1, 1, 1, 1, 1, 1, 1,
    ]);
  });
});

describe("Issue #647 D-03 — a single-salon tenant", () => {
  let app: FastifyInstance;
  let s1: Awaited<ReturnType<typeof seedTestData>>;
  let s2: Awaited<ReturnType<typeof seedTestData>>;
  const ALL = (n: number) => [n, n, n, n, n, n, n];

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
    app = await getTestApp();
    s1 = await seedTestData(app, "cov647s");
    s2 = await seedTestData(app, "cov647t");
    await createTestSalon(app.prisma, s1.tenant.id, { name: "Salon Alt", isActive: false });
    const inactive = await app.prisma.salon.findFirstOrThrow({
      where: { tenantId: s1.tenant.id, isActive: false },
    });
    const pS = await makePerson(app, s1.tenant.id, "pS", s1.salonId);
    await shiftOn(app, pS.employee.id, s1.salonId, TUESDAY);
    await ruleRow(app, s1.tenant.id, 1, { salonId: s1.salonId });
    await ruleRow(app, s1.tenant.id, 3);
    await ruleRow(app, s1.tenant.id, 7, { salonId: inactive.id });
    await ruleRow(app, s2.tenant.id, 3);
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, s1.tenant.id);
      await cleanupTestData(app, s2.tenant.id);
    } catch (err) {
      console.error("coverage-rule-salon-647 (D-03) cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("the unfiltered week uses the only active salon's rule; a rule of an inactive salon never acts", async () => {
    const body = await weekAs(app, s1.adminToken);
    expect(minStaffByDay(body)).toEqual(ALL(1));
    expect(statusOn(body, TUESDAY)).toBe("ok");
  });

  it("the filter naming that same salon gives the same seven values", async () => {
    expect(minStaffByDay(await weekAs(app, s1.adminToken, s1.salonId))).toEqual(ALL(1));
  });

  it("a single-salon tenant without a salon rule keeps its tenant-wide minimum", async () => {
    expect(minStaffByDay(await weekAs(app, s2.adminToken))).toEqual(ALL(3));
  });
});

describe("Issue #647 AC 1–3 — the week view of a multi-salon tenant", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let salonI: { id: string };
  let managerToken: string;
  let ruleA: { id: string };

  const UNFILTERED_KEYS = [
    "absenceMinutesByEmp",
    "availability",
    "contractSollMinutesByEmp",
    "coverage",
    "employees",
    "leaveMinutesByEmp",
    "salonOpeningHours",
    "schoolHoliday",
    "shiftBreakMinutesByEmp",
    "shifts",
    "vocationalSchoolMinutesByEmp",
    "weekDays",
  ];
  const COVERAGE_KEYS = [
    "coverageStatus",
    "date",
    "effectiveStaff",
    "hasSupervisor",
    "minStaff",
    "unsupervisedAzubis",
  ];

  function statuses(body: WeekBody): string[] {
    return [...body.coverage]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((c) => c.coverageStatus);
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "cov647m");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Nord" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Ost" });
    salonI = await createTestSalon(app.prisma, data.tenant.id, {
      name: "Salon Alt",
      isActive: false,
    });

    const pA = await makePerson(app, data.tenant.id, "pA", salonA.id);
    const pB = await makePerson(app, data.tenant.id, "pB", salonB.id);
    await shiftOn(app, pA.employee.id, salonA.id, TUESDAY);
    await shiftOn(app, pB.employee.id, salonB.id, "2026-06-18");

    const m = await makePerson(app, data.tenant.id, "manager", salonA.id);
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
    managerToken = await loginAs(app, m.user.email);

    await ruleRow(app, data.tenant.id, 3); // RT: tenant-wide, all days
    await ruleRow(app, data.tenant.id, 5, { dayOfWeek: 4 }); // RTF: tenant-wide, Friday
    ruleA = await ruleRow(app, data.tenant.id, 1, { salonId: salonA.id }); // RA
    await ruleRow(app, data.tenant.id, 4, { salonId: salonB.id, dayOfWeek: 3 }); // RB: Thursday
    await ruleRow(app, data.tenant.id, 9, { salonId: salonI.id }); // RI: inactive salon
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data.tenant.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("coverage-rule-salon-647 (AC 1-3) cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("AC 2: unfiltered, only the tenant-wide rules decide (no salon rule acts)", async () => {
    const body = await weekAs(app, data.adminToken);
    expect(minStaffByDay(body)).toEqual([3, 3, 3, 3, 5, 3, 3]);
    expect(statusOn(body, TUESDAY)).toBe("under");
  });

  it("AC 1/3: salon A — A beats tenant-wide within the all-days rung, the Friday tenant-wide rung beats A, B's rule never acts", async () => {
    const body = await weekAs(app, data.adminToken, salonA.id);
    expect(minStaffByDay(body)).toEqual([1, 1, 1, 1, 5, 1, 1]);
    expect(statusOn(body, TUESDAY)).toBe("ok");
  });

  it("AC 1/3: salon B — B's Thursday rule applies and the shortfall is measured against it", async () => {
    const body = await weekAs(app, data.adminToken, salonB.id);
    expect(minStaffByDay(body)).toEqual([3, 3, 3, 4, 5, 3, 3]);
    expect(statusOn(body, "2026-06-18")).toBe("under");
  });

  it("a salon manager's filtered view is the admin's view of that salon, values and statuses", async () => {
    const admin = await weekAs(app, data.adminToken, salonA.id);
    const manager = await weekAs(app, managerToken, salonA.id);
    expect(minStaffByDay(manager)).toEqual(minStaffByDay(admin));
    expect(statuses(manager)).toEqual(statuses(admin));
    // D-03a: without a filter the manager's only reach salon is in view
    expect(minStaffByDay(await weekAs(app, managerToken))).toEqual([1, 1, 1, 1, 5, 1, 1]);
  });

  it("an inactive salon is the identical 404 and its rule never acts anywhere", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/shifts/week?${WEEK}&salonId=${salonI.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(NOT_FOUND);
    for (const view of [
      await weekAs(app, data.adminToken),
      await weekAs(app, data.adminToken, salonA.id),
      await weekAs(app, data.adminToken, salonB.id),
    ]) {
      expect(minStaffByDay(view)).not.toContain(9);
    }
  });

  it("the response keeps its shape: 12 keys unfiltered, 13 with a filter, six keys per coverage entry", async () => {
    const raw = async (salonId?: string) => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/shifts/week?${WEEK}${salonId !== undefined ? `&salonId=${salonId}` : ""}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      return JSON.parse(res.body) as { coverage: Record<string, unknown>[] } & Record<
        string,
        unknown
      >;
    };
    const unfiltered = await raw();
    expect(Object.keys(unfiltered).sort()).toEqual(UNFILTERED_KEYS);
    const filtered = await raw(salonA.id);
    expect(Object.keys(filtered).sort()).toEqual(
      [...UNFILTERED_KEYS, "sollUnavailableReason"].sort(),
    );
    for (const body of [unfiltered, filtered]) {
      expect(body.coverage).toHaveLength(7);
      for (const entry of body.coverage) {
        expect(Object.keys(entry).sort()).toEqual(COVERAGE_KEYS);
      }
    }
  });

  // Last case of the describe: it changes the fixture (the salon-A rule is removed).
  it("AC 2 'for every salon': without a salon rule the tenant-wide rules are the fallback", async () => {
    await app.prisma.coverageRule.delete({ where: { id: ruleA.id } });
    const body = await weekAs(app, data.adminToken, salonA.id);
    expect(minStaffByDay(body)).toEqual([3, 3, 3, 3, 5, 3, 3]);
  });
});

describe("Issue #647 IN-02 — duplicate rules of one rung give a deterministic pick", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const ALL = (n: number) => [n, n, n, n, n, n, n];

  function duplicate(minStaff: number, createdAt: Date, id?: string) {
    return app.prisma.coverageRule.create({
      data: {
        ...(id ? { id } : {}),
        tenantId: data.tenant.id,
        salonId: null,
        templateId: null,
        dayOfWeek: -1,
        minStaff,
        requiresNonSupervised: false,
        createdAt,
      },
    });
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "cov647d");
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("coverage-rule-salon-647 (IN-02) cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("the first-created of two duplicate rules wins, whatever order the database yields", async () => {
    // The LATER rule is inserted first, so an unordered read yields it first.
    await duplicate(5, new Date("2026-06-02T10:00:00.000Z"));
    await duplicate(2, new Date("2026-06-01T10:00:00.000Z"));
    expect(minStaffByDay(await weekAs(app, data.adminToken))).toEqual(ALL(2));
  });

  it("two duplicates with the same createdAt: the smaller id wins", async () => {
    await app.prisma.coverageRule.deleteMany({ where: { tenantId: data.tenant.id } });
    const same = new Date("2026-06-03T10:00:00.000Z");
    const ids = ["00000000-0000-4000-8000-000000000b02", "00000000-0000-4000-8000-000000000a01"];
    // inserted in descending id order, so an unordered read yields the larger id first
    await duplicate(6, same, ids[0]);
    await duplicate(4, same, ids[1]);
    expect(minStaffByDay(await weekAs(app, data.adminToken))).toEqual(ALL(4));
  });
});
