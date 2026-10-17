/**
 * Issue #588 (Phase 588, plan 03, P-14) - the three endpoints the personal saldo views read
 * (`GET /dashboard` own `overtime` block, `GET /overtime/:employeeId`, `GET /leave/overtime-balance`)
 * carry `unconfirmedMonths` ADDITIVELY, from the breakdown each handler already calls. The web
 * words the forecast from it (`lib/saldo/forecast-label.ts`): "Laufender Monat" only for exactly
 * one unclosed month.
 *
 * - One rule, four readers: each person's value equals the row of `GET /dashboard/overtime-overview`
 *   at the same instant.
 * - Fallback branches (breakdown failed, or the person is exempt) answer `null`.
 * - The masked branch of `/leave/overtime-balance` never gains the key (key set pinned by
 *   `leave-overtime-balance-mask-85b.test.ts`; asserted here for the new key as well).
 * - Additive only: each answer's key set is its merge-base key set plus `unconfirmedMonths`.
 *
 * Tenant time zone Europe/Berlin, `Date` faked to 2026-07-15T10:00:00Z (in the past of any real
 * run). Synthetic fixture persons, no names.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  reissueTokenNow,
  tokenWithoutSignIn,
} from "./setup";
import { createPopulationPerson, type PopulationPerson } from "./population-fixtures-613";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";

const FAKE_NOW = new Date("2026-07-15T10:00:00Z");

type Json = Record<string, unknown>;

describe("Issue #588 - personal saldo endpoints say how many months are unclosed", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;
  let c: Record<"C1" | "C2" | "C3" | "EX", PopulationPerson>;

  async function withClock<T>(fn: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FAKE_NOW);
    try {
      return await fn();
    } finally {
      vi.useRealTimers();
    }
  }

  async function get(url: string, token: string): Promise<{ status: number; body: Json }> {
    return withClock(async () => {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${reissueTokenNow(app, token)}` },
      });
      return { status: res.statusCode, body: JSON.parse(res.body) as Json };
    });
  }

  async function ownToken(p: PopulationPerson): Promise<string> {
    return tokenWithoutSignIn(app, p.email);
  }

  /** The dashboard own `overtime` block, read as the person themself. */
  async function dashboardOf(p: PopulationPerson): Promise<Json> {
    const res = await get("/api/v1/dashboard", await ownToken(p));
    expect(res.status).toBe(200);
    return res.body.overtime as Json;
  }
  async function overtimeOf(p: PopulationPerson): Promise<Json> {
    const res = await get(`/api/v1/overtime/${p.employeeId}`, d.adminToken);
    expect(res.status).toBe(200);
    return res.body;
  }
  async function balanceOf(p: PopulationPerson): Promise<Json> {
    const res = await get(
      `/api/v1/leave/overtime-balance?employeeId=${p.employeeId}`,
      d.adminToken,
    );
    expect(res.status).toBe(200);
    return res.body;
  }
  async function overviewRow(p: PopulationPerson): Promise<Json> {
    const res = await get("/api/v1/dashboard/overtime-overview", d.adminToken);
    expect(res.status).toBe(200);
    const rows = res.body.employees as Json[];
    return rows.find((r) => r.id === p.employeeId) as Json;
  }

  function person(tag: string): Promise<PopulationPerson> {
    return createPopulationPerson(app, {
      tenantId: d.tenant.id,
      salonId: d.salonId,
      tag,
      hireDate: new Date("2025-01-01T00:00:00.000Z"),
    });
  }

  async function snapshot(employeeId: string, start: string, end: string): Promise<void> {
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: new Date(`${start}T00:00:00.000Z`),
        periodEnd: new Date(`${end}T00:00:00.000Z`),
        workedMinutes: 9600,
        expectedMinutes: 9600,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date("2026-07-01T06:00:00Z"),
        superseded: false,
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "pl588");
    c = {
      C1: await person("c1"),
      C2: await person("c2"),
      C3: await person("c3"),
      EX: await person("ex"),
    };
    // June closed, TZ-converted convention.
    await snapshot(c.C1.employeeId, "2026-05-31", "2026-06-30");
    // June closed, legacy convention.
    await snapshot(c.C2.employeeId, "2026-06-01", "2026-06-30");
    // Only April closed, TZ-converted.
    await snapshot(c.C3.employeeId, "2026-03-31", "2026-04-30");
    await app.prisma.employee.update({
      where: { id: c.EX.employeeId },
      data: { isTimeTrackingExempt: true },
    });
  }, 180_000);

  afterAll(async () => {
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: d.tenant.id } });
      await app.prisma.accessRole.deleteMany({ where: { tenantId: d.tenant.id } });
      await cleanupTestData(app, d.tenant.id);
    } catch (err) {
      console.error("personal-saldo-label-588 cleanup failed:", err);
    }
    await closeTestApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("the live branch", () => {
    const expected: Array<["C1" | "C2" | "C3", number]> = [
      ["C1", 1],
      ["C2", 1],
      ["C3", 3],
    ];

    it.each(expected)(
      "%s: all three answers carry %i, equal to the overview row",
      async (key, n) => {
        const p = c[key];
        expect((await dashboardOf(p)).unconfirmedMonths).toBe(n);
        expect((await overtimeOf(p)).unconfirmedMonths).toBe(n);
        expect((await balanceOf(p)).unconfirmedMonths).toBe(n);
        expect((await overviewRow(p)).unconfirmedMonths).toBe(n);
      },
    );
  });

  describe("the fallback branches", () => {
    it("a person without a live saldo (exempt) answers null on all three, other keys as before", async () => {
      const p = c.EX;
      const dash = await dashboardOf(p);
      const ot = await overtimeOf(p);
      const bal = await balanceOf(p);
      for (const body of [dash, ot, bal]) {
        expect("unconfirmedMonths" in body).toBe(true);
        expect(body.unconfirmedMonths).toBeNull();
        expect(body.openMonthMinutes).toBeNull();
      }
    });

    it("a failed breakdown answers null on all three, other keys as before", async () => {
      const p = c.C1;
      // Same idiom as leave-overtime-balance.test.ts: the breakdown's own snapshot read rejects once,
      // the independent confirmed-carry-over fallback read is a separate, un-mocked call.
      const fail = () =>
        vi
          .spyOn(app.prisma.saldoSnapshot, "findFirst")
          .mockRejectedValueOnce(new Error("simulated DB failure"));

      fail();
      const dash = await dashboardOf(p);
      fail();
      const ot = await overtimeOf(p);
      fail();
      const bal = await balanceOf(p);
      for (const body of [dash, ot, bal]) {
        expect(body.unconfirmedMonths).toBeNull();
        expect(body.openMonthMinutes).toBeNull();
        expect(typeof body.confirmedMinutes).toBe("number");
        expect(typeof body.hasClosedMonth).toBe("boolean");
      }
    });

    it("a caller without an employee profile gets the visible early answer with a null count", async () => {
      // An API-only account has no employee id: /leave/overtime-balance answers the constant body.
      const user = await app.prisma.user.create({
        data: {
          email: `588-noemp-${Date.now().toString(36)}@example.invalid`,
          passwordHash: "x",
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      const token = app.jwt.sign({ sub: user.id, tenantId: d.tenant.id } as never);
      const res = await get("/api/v1/leave/overtime-balance", token);
      expect(res.status).toBe(200);
      expect(res.body.balanceVisible).toBe(true);
      expect(res.body.unconfirmedMonths).toBeNull();
      await app.prisma.user.delete({ where: { id: user.id } });
    });
  });

  describe("the masked branch", () => {
    it("a Salonmanager without overtime:read gets the masked answer WITHOUT the new key", async () => {
      const salonA = await createTestSalon(app.prisma, d.tenant.id, { name: "PL588 Salon A" });
      const salonB = await createTestSalon(app.prisma, d.tenant.id, { name: "PL588 Salon B" });
      const target = await person("mt");
      await app.prisma.employeeSalonAssignment.updateMany({
        where: { employeeId: target.employeeId },
        data: { salonId: salonA.id },
      });
      const sm = await person("sm");
      await app.prisma.employeeSalonAssignment.updateMany({
        where: { employeeId: sm.employeeId },
        data: { salonId: salonB.id },
      });
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: d.tenant.id,
          userId: sm.userId,
          accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
          scopeType: "SALONS",
          salonIds: [salonA.id],
          employeeIds: [],
        },
      });
      const res = await get(
        `/api/v1/leave/overtime-balance?employeeId=${target.employeeId}`,
        await tokenWithoutSignIn(app, sm.email),
      );
      expect(res.status).toBe(200);
      expect(res.body.balanceVisible).toBe(false);
      expect("unconfirmedMonths" in res.body).toBe(false);
      expect(Object.keys(res.body).sort()).toEqual(
        [
          "balanceHours",
          "balanceVisible",
          "confirmedMinutes",
          "hasClosedMonth",
          "isNegativeLimitExceeded",
          "maxNegativeBalanceMinutes",
          "openMonthMinutes",
        ].sort(),
      );
    });
  });

  describe("additive only", () => {
    // Key lists measured on the merge base (59ef142e) for a FIXED_WEEKLY person with a closed month
    // (`transactions` comes from the spread account row, unchanged by this plan).
    const BASE_DASHBOARD = [
      "balanceHours",
      "confirmedMinutes",
      "hasClosedMonth",
      "openMonthMinutes",
    ];
    const BASE_OVERTIME = [
      "balanceHours",
      "confirmedMinutes",
      "employeeId",
      "hasClosedMonth",
      "id",
      "isNegativeLimitExceeded",
      "maxNegativeBalanceMinutes",
      "openMonthMinutes",
      "status",
      "threshold",
      "transactions",
      "updatedAt",
    ];
    const BASE_BALANCE = [
      "balanceHours",
      "balanceVisible",
      "confirmedMinutes",
      "hasClosedMonth",
      "isNegativeLimitExceeded",
      "maxNegativeBalanceMinutes",
      "openMonthMinutes",
    ];

    it("each answer is its merge-base key set plus exactly unconfirmedMonths", async () => {
      const p = c.C1;
      expect(Object.keys(await dashboardOf(p)).sort()).toEqual(
        [...BASE_DASHBOARD, "unconfirmedMonths"].sort(),
      );
      expect(Object.keys(await overtimeOf(p)).sort()).toEqual(
        [...BASE_OVERTIME, "unconfirmedMonths"].sort(),
      );
      expect(Object.keys(await balanceOf(p)).sort()).toEqual(
        [...BASE_BALANCE, "unconfirmedMonths"].sort(),
      );
    });
  });
});
