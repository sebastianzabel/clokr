/**
 * Issue #81 (AK-2, AK-6, D-13, D-14) — classifying time entries by activity kind changes no figure.
 *
 * Rüst-/Reinigungszeit is full working time (§ 2 Abs. 1 ArbZG; BAG 5 AZR 168/16): the activity kind
 * and its minute shares are an evaluation dimension only. This file proves it behaviourally, as an
 * A/B comparison inside ONE run — no pinned literals: every surface is captured twice before any
 * change (stability), the rows are then classified by plain Prisma, and every surface is captured
 * again and must be identical. A second block closes March for twin employees, one of them
 * classified, and compares the stored Monatsabschluss.
 *
 * Proof chain for AK-4/AK-6 (existing data gets a default and no saldo changes):
 *   1. the 81-01 migration test shows the migration rewrites no saldo input and leaves every existing
 *      row UNSPECIFIED without shares;
 *   2. this test shows that exactly that state and any classification produce identical figures on
 *      every saldo, report, dashboard, DATEV and day-kernel surface, and in the Monatsabschluss;
 *   3. `activity-kind-saldo-isolation-81.test.ts` shows no figure file can read the dimension.
 *
 * The fixture mirrors the eight rows of `saldo-neutrality-characterisation-79.test.ts` (cited, never
 * imported or edited — it is frozen and runs `describe` on import).
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import iconv from "iconv-lite";
import type { ActivityKind } from "@clokr/db";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  salonIdForEmployee,
  configureDatevKanzlei,
  grantSystemRole,
} from "./setup";
import * as pdfUtils from "../composition/pdf";
import { checkArbZG } from "../contexts/time-tracking/arbzg";
import { activityMinutes } from "../contexts/time-tracking";

// Wrap the REAL PDF generator so the test can read the data payload (same pattern as test 79).
vi.mock("../composition/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../composition/pdf")>();
  return {
    ...actual,
    generateMonthlyReportPdf: vi.fn(actual.generateMonthlyReportPdf),
  };
});

const CLOCK_SALDO = new Date("2026-04-15T10:00:00.000Z");
const CLOCK_LIVE = new Date("2026-03-31T10:00:00.000Z");
const CLOCK_DASHBOARD = new Date("2026-03-20T20:00:00.000Z");

async function loginAs(app: FastifyInstance, email: string, password = "test1234") {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
  const { accessToken } = JSON.parse(res.body) as { accessToken: string };
  return accessToken;
}

interface Emp {
  id: string;
  email: string;
}

async function createEmployee(
  app: FastifyInstance,
  tenantId: string,
  salonId: string,
  label: string,
  opts: { monthlyHours: boolean; hireDate: string },
): Promise<Emp> {
  const passwordHash = await bcrypt.hash("test1234", 10);
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const email = `${label}-${suffix}@test.de`;
  const user = await app.prisma.user.create({
    data: { email, passwordHash, role: "EMPLOYEE", isActive: true },
  });
  const hireDate = new Date(`${opts.hireDate}T00:00:00Z`);
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `${label}-${suffix}`,
      firstName: label,
      lastName: "Act81",
      hireDate,
    },
  });
  await grantSystemRole(app.prisma, { tenantId, userId: user.id, role: "EMPLOYEE" });
  await app.prisma.workSchedule.create({
    data: opts.monthlyHours
      ? {
          employeeId: employee.id,
          type: "MONTHLY_HOURS",
          monthlyHours: null,
          workDays: [1, 2, 3, 4, 5],
          overtimeMode: "TRACK_ONLY",
          validFrom: hireDate,
        }
      : {
          employeeId: employee.id,
          type: "FIXED_SCHEDULE",
          weeklyHours: 40,
          mondayHours: 8,
          tuesdayHours: 8,
          wednesdayHours: 8,
          thursdayHours: 8,
          fridayHours: 8,
          saturdayHours: 0,
          sundayHours: 0,
          workDays: [1, 2, 3, 4, 5],
          validFrom: hireDate,
        },
  });
  await app.prisma.employeeSalonAssignment.create({
    data: {
      tenantId,
      employeeId: employee.id,
      salonId,
      kind: "HOME",
      validFrom: hireDate,
      validUntil: null,
      weekdays: [],
    },
  });
  await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
  return { id: employee.id, email };
}

/** The eight row shapes of test 79; `clean` keeps only the closed, valid rows (for the close). */
async function seedEntries(
  app: FastifyInstance,
  employeeId: string,
  clean = false,
): Promise<Map<string, string>> {
  const salonId = await salonIdForEmployee(app.prisma, employeeId);
  const base = { employeeId, type: "WORK" as const, salonId };
  const ids = new Map<string, string>();
  const add = async (key: string, data: Record<string, unknown>) => {
    const row = await app.prisma.timeEntry.create({ data: { ...base, ...data } as never });
    ids.set(key, row.id);
    return row;
  };

  // breakMinutes only, no Break rows
  await add("2026-03-16", {
    date: new Date("2026-03-16T00:00:00Z"),
    startTime: new Date("2026-03-16T07:00:00.000Z"),
    endTime: new Date("2026-03-16T15:30:00.000Z"),
    breakMinutes: 30,
  });
  // Break rows (45 min)
  const row2 = await add("2026-03-17", {
    date: new Date("2026-03-17T00:00:00Z"),
    startTime: new Date("2026-03-17T07:00:00.000Z"),
    endTime: new Date("2026-03-17T16:00:00.000Z"),
    breakMinutes: 45,
  });
  await app.prisma.break.createMany({
    data: [
      {
        timeEntryId: row2.id,
        startTime: new Date("2026-03-17T11:00:00.000Z"),
        endTime: new Date("2026-03-17T11:30:00.000Z"),
      },
      {
        timeEntryId: row2.id,
        startTime: new Date("2026-03-17T14:00:00.000Z"),
        endTime: new Date("2026-03-17T14:15:00.000Z"),
      },
    ],
  });
  // stored auto-break
  await add("2026-03-18", {
    date: new Date("2026-03-18T00:00:00Z"),
    startTime: new Date("2026-03-18T07:00:00.000Z"),
    endTime: new Date("2026-03-18T14:00:00.000Z"),
    breakMinutes: 30,
    breakStatus: "AUTO",
  });
  // millisecond precision, no break although > 6 h
  await add("2026-03-19", {
    date: new Date("2026-03-19T00:00:00Z"),
    startTime: new Date("2026-03-19T06:58:17.123Z"),
    endTime: new Date("2026-03-19T15:31:44.987Z"),
    breakMinutes: 0,
  });
  if (!clean) {
    // invalid
    await add("2026-03-20", {
      date: new Date("2026-03-20T00:00:00Z"),
      startTime: new Date("2026-03-20T07:00:00.000Z"),
      endTime: new Date("2026-03-20T15:30:00.000Z"),
      breakMinutes: 30,
      isInvalid: true,
    });
    // open
    await add("2026-03-21", {
      date: new Date("2026-03-21T00:00:00Z"),
      startTime: new Date("2026-03-21T08:00:00.000Z"),
      endTime: null,
      breakMinutes: 0,
    });
  }
  // cross-midnight
  await add("2026-03-27", {
    date: new Date("2026-03-27T00:00:00Z"),
    startTime: new Date("2026-03-27T21:00:00.000Z"),
    endTime: new Date("2026-03-28T05:00:00.000Z"),
    breakMinutes: 30,
  });
  // DST switch
  await add("2026-03-29", {
    date: new Date("2026-03-29T00:00:00Z"),
    startTime: new Date("2026-03-28T23:30:00.000Z"),
    endTime: new Date("2026-03-29T06:30:00.000Z"),
    breakMinutes: 15,
  });
  return ids;
}

type Classification = {
  kind: ActivityKind;
  shares: { kind: ActivityKind; minutes: number }[];
};

/**
 * The classification step: a SETUP_CLEANING-only day, a day with one share, a day with two shares,
 * and (when present) the invalid and the open row — excluded rows must stay excluded.
 */
const CLASSIFICATION: Record<string, Classification> = {
  "2026-03-16": { kind: "SETUP_CLEANING", shares: [] },
  "2026-03-17": { kind: "PRODUCTIVE", shares: [{ kind: "SETUP_CLEANING", minutes: 60 }] },
  "2026-03-19": {
    kind: "UNSPECIFIED",
    shares: [
      { kind: "PRODUCTIVE", minutes: 120 },
      { kind: "SETUP_CLEANING", minutes: 30 },
    ],
  },
  "2026-03-20": { kind: "SETUP_CLEANING", shares: [] },
  "2026-03-21": { kind: "SETUP_CLEANING", shares: [] },
  "2026-03-29": { kind: "SETUP_CLEANING", shares: [] },
};

async function classify(app: FastifyInstance, ids: Map<string, string>): Promise<number> {
  let classified = 0;
  for (const [date, c] of Object.entries(CLASSIFICATION)) {
    const id = ids.get(date);
    if (!id) continue;
    await app.prisma.timeEntry.update({
      where: { id },
      data: { activityKind: c.kind, activityShares: { create: c.shares } },
    });
    classified++;
  }
  return classified;
}

describe("Issue #81 (AK-6, D-13) — classification leaves every figure surface unchanged", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminEmail: string;
  let a: Emp;
  let b: Emp;
  let idsA: Map<string, string>;
  let idsB: Map<string, string>;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(CLOCK_SALDO);
    app = await getTestApp();
    const seed = await seedTestData(app, "act81eq", { withDefaultSalon: false });
    tenantId = seed.tenant.id;
    adminEmail = seed.adminUser.email;
    const salon = await createTestSalon(app.prisma, tenantId, { federalState: "NIEDERSACHSEN" });
    a = await createEmployee(app, tenantId, salon.id, "act81-fixed", {
      monthlyHours: false,
      hireDate: "2026-01-01",
    });
    b = await createEmployee(app, tenantId, salon.id, "act81-monthly", {
      monthlyHours: true,
      hireDate: "2026-01-01",
    });
    idsA = await seedEntries(app, a.id);
    idsB = await seedEntries(app, b.id);
    await configureDatevKanzlei(app, tenantId);
    await app.prisma.employee.update({ where: { id: a.id }, data: { employeeNumber: "ACT81-A" } });
    await app.prisma.employee.update({ where: { id: b.id }, data: { employeeNumber: "ACT81-B" } });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("activity-kind-saldo-equality-81 cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function get(token: string, url: string): Promise<unknown> {
    const res = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, `${url} → ${res.body}`).toBe(200);
    return JSON.parse(res.body) as unknown;
  }

  /**
   * Team-week bodies list the members in an order the endpoint does not guarantee (it differed
   * between two identical calls in CI), so the comparison keys them by member id. Every value of
   * every member is still compared; only the position no longer matters.
   */
  function byMember(body: unknown): unknown {
    const b = body as { team?: Array<{ id: string }> } & Record<string, unknown>;
    if (!Array.isArray(b.team)) return body;
    return { ...b, team: [...b.team].sort((x, y) => x.id.localeCompare(y.id)) };
  }

  /** Every saldo / figure / day-kernel surface, each at the clock test 79 uses for it. */
  async function capture() {
    const out: Record<string, unknown> = {};

    vi.setSystemTime(CLOCK_SALDO);
    let admin = await loginAs(app, adminEmail);
    for (const e of [a, b]) {
      out[`monthSaldo:${e.id}`] = await get(
        admin,
        `/api/v1/overtime/month-saldo/${e.id}?year=2026&month=3`,
      );
      out[`reportMonthly:${e.id}`] = await get(
        admin,
        `/api/v1/reports/monthly?employeeId=${e.id}&year=2026&month=3`,
      );
    }
    const spy = vi.mocked(pdfUtils.generateMonthlyReportPdf);
    spy.mockClear();
    const pdf = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly/pdf?employeeId=${a.id}&year=2026&month=3`,
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(pdf.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    out.pdfPayload = JSON.parse(JSON.stringify(spy.mock.calls[0][0]));
    const datev = await app.inject({
      method: "GET",
      url: "/api/v1/reports/datev?year=2026&month=3",
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(datev.statusCode).toBe(200);
    // Only the movement data: the header carries a generation timestamp.
    out.datevMovements = iconv.decode(datev.rawPayload, "win1252").split("[Bewegungsdaten]")[1];
    for (const date of idsA.keys()) {
      out[`checkArbZG:${date}`] = await checkArbZG(app.prisma, a.id, new Date(`${date}T00:00:00Z`));
    }
    out.dayBreakChecks = await get(
      admin,
      `/api/v1/day-breaks/checks?employeeId=${a.id}&from=2026-03-01&to=2026-03-31`,
    );

    vi.setSystemTime(CLOCK_LIVE);
    admin = await loginAs(app, adminEmail);
    for (const e of [a, b]) {
      out[`balance:${e.id}`] = await get(admin, `/api/v1/overtime/${e.id}`);
    }
    out.teamWeek2303 = byMember(await get(admin, "/api/v1/dashboard/team-week?date=2026-03-25"));

    vi.setSystemTime(CLOCK_DASHBOARD);
    admin = await loginAs(app, adminEmail);
    const emp = await loginAs(app, a.email);
    out.dashboard = await get(emp, "/api/v1/dashboard");
    out.myWeek = await get(emp, "/api/v1/dashboard/my-week?date=2026-03-18");
    out.teamWeek1603 = byMember(await get(admin, "/api/v1/dashboard/team-week?date=2026-03-18"));

    vi.setSystemTime(CLOCK_SALDO);
    return out;
  }

  let before: Record<string, unknown>;

  it("stability: two captures of the unclassified (migrated) state are identical", async () => {
    before = await capture();
    const again = await capture();
    expect(again).toEqual(before);
    // Non-vacuity: the fixture really carries working time.
    const saldo = before[`monthSaldo:${a.id}`] as { workedMinutes: number };
    expect(saldo.workedMinutes).toBeGreaterThan(0);
  });

  it("the classification really happened (kinds and shares stored)", async () => {
    expect(await classify(app, idsA)).toBe(6);
    expect(await classify(app, idsB)).toBe(6);
    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: a.id, deletedAt: null },
      select: { date: true, activityKind: true, activityShares: { select: { minutes: true } } },
    });
    const setupOnly = rows.filter((r) => r.activityKind === "SETUP_CLEANING");
    expect(setupOnly.length).toBe(4);
    expect(rows.flatMap((r) => r.activityShares).length).toBe(3);
  });

  it("the classified minutes are real: per-kind sums equal the saldo's worked minutes", async () => {
    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: a.id, deletedAt: null, isInvalid: false, endTime: { not: null } },
      select: {
        startTime: true,
        endTime: true,
        breakMinutes: true,
        activityKind: true,
        activityShares: { select: { kind: true, minutes: true } },
      },
    });
    let total = 0;
    let setup = 0;
    for (const r of rows) {
      const m = activityMinutes(r, r.activityShares);
      total += m.UNSPECIFIED + m.PRODUCTIVE + m.SETUP_CLEANING;
      setup += m.SETUP_CLEANING;
    }
    const saldo = before[`monthSaldo:${a.id}`] as { workedMinutes: number };
    expect(Math.round(total)).toBe(saldo.workedMinutes);
    expect(setup).toBeGreaterThan(0);
  });

  it("every surface is identical after the classification", async () => {
    const after = await capture();
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const key of Object.keys(before)) {
      expect(after[key], `surface ${key} changed after the classification`).toEqual(before[key]);
    }
  });
});

describe("Issue #81 (AK-2, D-14) — Rüst-/Reinigungszeit counts fully in the Monatsabschluss", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminEmail: string;
  let t1: Emp;
  let t2: Emp;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(CLOCK_SALDO);
    app = await getTestApp();
    const seed = await seedTestData(app, "act81tw", { withDefaultSalon: false });
    tenantId = seed.tenant.id;
    adminEmail = seed.adminUser.email;
    const salon = await createTestSalon(app.prisma, tenantId, { federalState: "NIEDERSACHSEN" });
    // Hired on 1 March so March is the first month to close.
    t1 = await createEmployee(app, tenantId, salon.id, "act81-twin1", {
      monthlyHours: false,
      hireDate: "2026-03-01",
    });
    t2 = await createEmployee(app, tenantId, salon.id, "act81-twin2", {
      monthlyHours: false,
      hireDate: "2026-03-01",
    });
    await seedEntries(app, t1.id, true);
    const ids2 = await seedEntries(app, t2.id, true);
    expect(await classify(app, ids2)).toBe(4);
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("activity-kind-saldo-equality-81 twin cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("closing March stores identical snapshots for the unclassified and the classified twin", async () => {
    const admin = await loginAs(app, adminEmail);
    for (const e of [t1, t2]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/overtime/close-month",
        headers: { authorization: `Bearer ${admin}` },
        // Both twins have the same unrecorded workdays; confirming them is a shared precondition.
        payload: { employeeId: e.id, year: 2026, month: 3, confirmGaps: true },
      });
      expect(res.statusCode, res.body).toBe(201);
    }
    const snap = async (employeeId: string) =>
      app.prisma.saldoSnapshot.findFirstOrThrow({
        where: { employeeId, periodType: "MONTHLY", superseded: false },
        select: {
          workedMinutes: true,
          expectedMinutes: true,
          balanceMinutes: true,
          carryOver: true,
        },
      });
    const s1 = await snap(t1.id);
    const s2 = await snap(t2.id);
    expect(s1.workedMinutes).toBeGreaterThan(0);
    expect(s2).toEqual(s1);

    const balance = async (employeeId: string) => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/overtime/${employeeId}`,
        headers: { authorization: `Bearer ${admin}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      return { balanceHours: body.balanceHours, status: body.status };
    };
    expect(await balance(t2.id)).toEqual(await balance(t1.id));
  });
});
