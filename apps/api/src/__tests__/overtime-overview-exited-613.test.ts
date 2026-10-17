/**
 * Issue #613 (Phase 613, plan 04), AC-613-2 / AC-613-5 - `GET /dashboard/overtime-overview` keeps
 * the final saldo of an exited person visible until the exit month is closed, lists a
 * login-deactivated person who has not left, never lists an anonymised person, bounds the exited
 * section to the newest 50 exits with a total count, and judges the caller's reach at the exit day.
 *
 * Tenant time zone Europe/Berlin, clock faked to 2026-11-18T10:00:00Z (only `Date`). Persons
 * (hire 2025-01-01 unless noted):
 *   X1  exit 2026-10-15, no closed month                      -> listed, open
 *   X2  exit 2026-09-30, legacy September snapshot            -> not listed (closed)
 *   X3  exit 2026-08-31, TZ-converted August snapshot         -> not listed (closed)
 *   X4  exit 2026-08-31, only July closed                     -> listed, open
 *   F   exit 2026-12-31 (still employed)                      -> listed, not marked
 *   D   login deactivated, no exit                            -> listed (AC-613-2)
 *   A   anonymised sentinel, no exit / with exit              -> never listed
 * No person names, no real e-mails (synthetic fixture).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  reissueTokenNow,
} from "./setup";
import { createPopulationPerson, type PopulationPerson } from "./population-fixtures-613";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";
import { computeOvertimeBalanceBreakdown } from "../contexts/working-time-account";
import { EXITED_OPEN_SECTION_LIMIT } from "../composition/dashboard";

// The wrapper keeps the real implementation; it only lets the test see for whom the per-person
// saldo computation ran.
vi.mock("../contexts/working-time-account", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../contexts/working-time-account")>();
  return {
    ...actual,
    computeOvertimeBalanceBreakdown: vi.fn(actual.computeOvertimeBalanceBreakdown),
  };
});

const FAKE_NOW = new Date("2026-11-18T10:00:00Z");
const PASSWORD = "test1234";

interface OverviewRow {
  id: string;
  exitDate: string | null;
  exitedWithOpenFinalSaldo: boolean;
  balanceHours: number;
  confirmedMinutes: number;
  openMonthMinutes: number | null;
}
interface Overview {
  employees: OverviewRow[];
  exitedOpenFinalSaldoCount: number;
}

describe("Issue #613 - overtime overview: exited persons with an open final saldo", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;
  let salon2: { id: string };
  let p: Record<"X1" | "X2" | "X3" | "X4" | "F" | "D" | "A" | "AE" | "X5" | "Y", PopulationPerson>;
  let manager: PopulationPerson;

  async function withClock<T>(token: string, fn: (token: string) => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FAKE_NOW);
    try {
      return await fn(reissueTokenNow(app, token));
    } finally {
      vi.useRealTimers();
    }
  }

  async function overview(token: string): Promise<Overview> {
    return withClock(token, async (t) => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/overtime-overview",
        headers: { authorization: `Bearer ${t}` },
      });
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body) as Overview;
    });
  }

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  async function snapshot(
    employeeId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<void> {
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: new Date(`${periodStart}T00:00:00.000Z`),
        periodEnd: new Date(`${periodEnd}T00:00:00.000Z`),
        workedMinutes: 9600,
        expectedMinutes: 9600,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date("2026-11-01T06:00:00Z"),
        superseded: false,
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "ov613");
    salon2 = await createTestSalon(app.prisma, d.tenant.id, { name: "OV613 Salon 2" });
    const base = { tenantId: d.tenant.id, salonId: d.salonId };
    const hire = new Date("2025-01-01T00:00:00.000Z");
    const exit = (day: string) => new Date(`${day}T00:00:00.000Z`);
    p = {
      X1: await createPopulationPerson(app, {
        ...base,
        tag: "x1",
        hireDate: hire,
        exitDate: exit("2026-10-15"),
      }),
      X2: await createPopulationPerson(app, {
        ...base,
        tag: "x2",
        hireDate: hire,
        exitDate: exit("2026-09-30"),
      }),
      X3: await createPopulationPerson(app, {
        ...base,
        tag: "x3",
        hireDate: hire,
        exitDate: exit("2026-08-31"),
      }),
      X4: await createPopulationPerson(app, {
        ...base,
        tag: "x4",
        hireDate: hire,
        exitDate: exit("2026-08-31"),
      }),
      F: await createPopulationPerson(app, {
        ...base,
        tag: "f",
        hireDate: hire,
        exitDate: exit("2026-12-31"),
      }),
      D: await createPopulationPerson(app, {
        ...base,
        tag: "d",
        hireDate: hire,
        loginActive: false,
      }),
      A: await createPopulationPerson(app, { ...base, tag: "a", hireDate: hire, anonymized: true }),
      AE: await createPopulationPerson(app, {
        ...base,
        tag: "ae",
        hireDate: hire,
        anonymized: true,
        exitDate: exit("2026-10-15"),
      }),
      // Stammsalon 2 for the whole time, open exit month.
      X5: await createPopulationPerson(app, {
        ...base,
        salonId: salon2.id,
        tag: "x5",
        hireDate: hire,
        exitDate: exit("2026-10-15"),
      }),
      // Salon 1 until after the exit day, salon 2 from 1 November: its reach is judged at the exit day.
      Y: await createPopulationPerson(app, {
        ...base,
        tag: "y",
        hireDate: hire,
        exitDate: exit("2026-10-15"),
      }),
    };
    // Legacy convention: periodStart = 1st, periodEnd = last day.
    await snapshot(p.X2.employeeId, "2026-09-01", "2026-09-30");
    await snapshot(p.X4.employeeId, "2026-07-01", "2026-07-31");
    // TZ-converted convention (Berlin): the instants of the local month stored as dates.
    await snapshot(p.X3.employeeId, "2026-07-31", "2026-08-31");

    await app.prisma.employeeSalonAssignment.updateMany({
      where: { employeeId: p.Y.employeeId, kind: "HOME" },
      data: { validUntil: new Date("2026-10-31T00:00:00.000Z") },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: d.tenant.id,
        employeeId: p.Y.employeeId,
        salonId: salon2.id,
        kind: "HOME",
        validFrom: new Date("2026-11-01T00:00:00.000Z"),
        validUntil: null,
        weekdays: [],
      },
    });

    // A manager of salon 1 holding both permissions the route requires.
    manager = await createPopulationPerson(app, {
      ...base,
      tag: "m",
      hireDate: hire,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
    });
    const name = `OV613 ${randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: d.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions([
          "team-overview:read:ZUGEWIESEN",
          "overtime:read:ZUGEWIESEN",
        ]),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: d.tenant.id,
        userId: manager.userId,
        accessRoleId: role.id,
        scopeType: "SALONS",
        salonIds: [d.salonId],
        employeeIds: [],
      },
    });
  }, 180_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, d.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("whole-tenant caller", () => {
    it("lists open exit months (both snapshot conventions), the still-employed leaver and the deactivated login, never an anonymised person", async () => {
      const body = await overview(d.adminToken);
      const byId = new Map(body.employees.map((r) => [r.id, r]));
      const open = (id: string) => byId.get(id)?.exitedWithOpenFinalSaldo;

      expect(open(p.X1.employeeId)).toBe(true);
      expect(byId.get(p.X1.employeeId)?.exitDate).toBe("2026-10-15");
      expect(open(p.X4.employeeId)).toBe(true);
      expect(byId.has(p.X2.employeeId)).toBe(false);
      expect(byId.has(p.X3.employeeId)).toBe(false);

      expect(open(p.F.employeeId)).toBe(false);
      expect(byId.get(p.F.employeeId)?.exitDate).toBe("2026-12-31");
      expect(open(p.D.employeeId)).toBe(false);
      expect(byId.get(p.D.employeeId)?.exitDate).toBeNull();

      expect(byId.has(p.A.employeeId)).toBe(false);
      expect(byId.has(p.AE.employeeId)).toBe(false);
    });

    it("counts every in-reach exited person with an open exit month", async () => {
      const body = await overview(d.adminToken);
      // X1, X4, X5, Y
      expect(body.exitedOpenFinalSaldoCount).toBe(4);
      expect(body.employees.filter((r) => r.exitedWithOpenFinalSaldo)).toHaveLength(4);
    });

    it("shows the same figures as the person's own saldo (GET /overtime/:employeeId)", async () => {
      const body = await overview(d.adminToken);
      const row = body.employees.find((r) => r.id === p.X1.employeeId);
      expect(row).toBeDefined();
      const own = await withClock(d.adminToken, async (t) => {
        const res = await app.inject({
          method: "GET",
          url: `/api/v1/overtime/${p.X1.employeeId}`,
          headers: { authorization: `Bearer ${t}` },
        });
        expect(res.statusCode).toBe(200);
        return JSON.parse(res.body) as {
          balanceHours: number;
          confirmedMinutes: number;
          openMonthMinutes: number | null;
        };
      });
      expect(row?.balanceHours).toBe(own.balanceHours);
      expect(row?.confirmedMinutes).toBe(own.confirmedMinutes);
      expect(row?.openMonthMinutes).toBe(own.openMonthMinutes);
    });
  });

  describe("scoped caller (reach judged at the exit day)", () => {
    it("lists and counts X1 and Y (salon 1 on their exit day), neither lists nor counts X5 (salon 2)", async () => {
      const token = await login(manager.email);
      const findMany = vi.spyOn(app.prisma.employeeSalonAssignment, "findMany");
      const body = await overview(token);
      // Measured: one resolution per reach for today, one per reach and distinct exit day.
      // A scope resolution is the HOME lookup by salon list with a Stichtag window.
      const scopeReads = findMany.mock.calls.filter((c) => {
        const where = (c[0] as { where?: Record<string, unknown> } | undefined)?.where;
        return (
          where?.kind === "HOME" && where.salonId !== undefined && where.validFrom !== undefined
        );
      }).length;
      findMany.mockRestore();
      const ids = new Set(body.employees.map((r) => r.id));
      expect(ids.has(p.X1.employeeId)).toBe(true);
      expect(ids.has(p.Y.employeeId)).toBe(true);
      expect(ids.has(p.X4.employeeId)).toBe(true);
      expect(ids.has(p.X5.employeeId)).toBe(false);
      // X1, X4, Y - not X5
      expect(body.exitedOpenFinalSaldoCount).toBe(3);
      // Two distinct exit days (2026-08-31, 2026-10-15) x two reaches + two reaches for today.
      expect(scopeReads).toBe(6);
    });
  });

  describe("bound of the exited section", () => {
    let d2: Awaited<ReturnType<typeof seedTestData>>;
    const exitedIds: string[] = [];
    const exitByPerson = new Map<string, string>();

    beforeAll(async () => {
      d2 = await seedTestData(app, "ov613b");
      const hire = new Date("2025-01-01T00:00:00.000Z");
      for (let i = 0; i < EXITED_OPEN_SECTION_LIMIT + 2; i++) {
        const day = new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10);
        const person = await createPopulationPerson(app, {
          tenantId: d2.tenant.id,
          salonId: d2.salonId,
          tag: `b${i}`,
          hireDate: hire,
          exitDate: new Date(`${day}T00:00:00.000Z`),
        });
        exitedIds.push(person.employeeId);
        exitByPerson.set(person.employeeId, day);
      }
    }, 180_000);

    afterAll(async () => {
      try {
        await cleanupTestData(app, d2.tenant.id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    });

    it("lists the newest 50 exits, reports the total, and runs the saldo computation for at most 50 exited persons", async () => {
      const spy = vi.mocked(computeOvertimeBalanceBreakdown);
      spy.mockClear();
      const snapshotReads = vi.spyOn(app.prisma.saldoSnapshot, "findMany");
      const accountReads = vi.spyOn(app.prisma.overtimeAccount, "findMany");
      const body = await overview(d2.adminToken);
      // The exited section adds no read of its own: the sparkline read and the one bulk read of the
      // latest closed month are the only snapshot lists, W9 the only account list.
      expect(snapshotReads.mock.calls).toHaveLength(2);
      expect(accountReads.mock.calls).toHaveLength(1);
      snapshotReads.mockRestore();
      accountReads.mockRestore();

      expect(body.exitedOpenFinalSaldoCount).toBe(EXITED_OPEN_SECTION_LIMIT + 2);
      const exitedRows = body.employees.filter((r) => r.exitedWithOpenFinalSaldo);
      expect(exitedRows).toHaveLength(EXITED_OPEN_SECTION_LIMIT);

      // The two oldest exits are the ones left out; the rest is ordered by exit date, newest first.
      const dates = exitedRows.map((r) => r.exitDate as string);
      expect(dates).toEqual([...dates].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)));
      const oldestTwo = exitedIds.slice(0, 2);
      for (const id of oldestTwo) {
        expect(exitedRows.some((r) => r.id === id)).toBe(false);
      }

      const exitedSet = new Set(exitedIds);
      const exitedCalls = spy.mock.calls.filter((c) => exitedSet.has(c[1] as string));
      expect(exitedCalls.length).toBeLessThanOrEqual(EXITED_OPEN_SECTION_LIMIT);
      expect(exitedCalls.length).toBe(EXITED_OPEN_SECTION_LIMIT);
    }, 120_000);
  });
});
