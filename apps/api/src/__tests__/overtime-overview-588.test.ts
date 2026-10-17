/**
 * Issue #588 (Phase 588, plan 01) - `GET /dashboard/overtime-overview` carries three ADDITIVE
 * facts per row for the team saldo figures of the web (`lib/reports/team-saldo.ts`):
 *   - `hasRecordedTime`   at least one closed, valid, non-deleted WORK entry on or after the hire
 *                         day (one bulk Zeiterfassung facade read per request),
 *   - `trackOnly`         the #494 rule as the breakdown already evaluates it (today's contract),
 *   - `unconfirmedMonths` tenant-local calendar months from the first open day of the live saldo
 *                         window through the current month, inclusive.
 * The saldo itself is untouched; the "saldo unchanged" describe proves the row equals the
 * personal endpoint.
 *
 * Tenant time zone Europe/Berlin, `Date` faked to 2026-07-15T10:00:00Z (the n1 precedent, in the
 * past of any real run). No person names, no real e-mails (synthetic fixture).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
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

const FAKE_NOW = new Date("2026-07-15T10:00:00Z");

interface OverviewRow {
  id: string;
  name: string;
  employeeNumber: string;
  exitDate: string | null;
  exitedWithOpenFinalSaldo: boolean;
  balanceHours: number;
  status: string;
  confirmedMinutes: number;
  openMonthMinutes: number | null;
  hasClosedMonth: boolean;
  snapshots: unknown[];
  hasRecordedTime?: boolean;
  trackOnly?: boolean | null;
  unconfirmedMonths?: number | null;
}
interface Overview {
  employees: OverviewRow[];
  exitedOpenFinalSaldoCount: number;
}

describe("Issue #588 - overtime overview: facts for the team saldo figures", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;

  async function withClock<T>(
    token: string,
    fn: (token: string) => Promise<T>,
    now: Date = FAKE_NOW,
  ): Promise<T> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      return await fn(reissueTokenNow(app, token));
    } finally {
      vi.useRealTimers();
    }
  }

  async function overview(token: string, query = "", now: Date = FAKE_NOW): Promise<Overview> {
    return withClock(
      token,
      async (t) => {
        const res = await app.inject({
          method: "GET",
          url: `/api/v1/dashboard/overtime-overview${query}`,
          headers: { authorization: `Bearer ${t}` },
        });
        expect(res.statusCode).toBe(200);
        return JSON.parse(res.body) as Overview;
      },
      now,
    );
  }

  function person(tag: string, hire = "2025-01-01"): Promise<PopulationPerson> {
    return createPopulationPerson(app, {
      tenantId: d.tenant.id,
      salonId: d.salonId,
      tag,
      hireDate: new Date(`${hire}T00:00:00.000Z`),
    });
  }

  async function workEntry(
    employeeId: string,
    day: string,
    overrides: Record<string, unknown> = {},
  ): Promise<void> {
    const date = new Date(`${day}T00:00:00.000Z`);
    await app.prisma.timeEntry.create({
      data: {
        employeeId,
        date,
        startTime: new Date(date.getTime() + 8 * 3_600_000),
        endTime: new Date(date.getTime() + 16 * 3_600_000),
        breakMinutes: 30,
        type: "WORK",
        salonId: d.salonId,
        ...overrides,
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "ov588");
  }, 180_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, d.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

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
        closedAt: new Date("2026-07-01T06:00:00Z"),
        superseded: false,
      },
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("tracer", () => {
    let r1: PopulationPerson;
    let n1: PopulationPerson;

    beforeAll(async () => {
      r1 = await person("r1");
      n1 = await person("n1");
      await workEntry(r1.employeeId, "2026-07-01");
    }, 120_000);

    it("marks a person with a closed valid WORK entry since hire and one without", async () => {
      const body = await overview(d.adminToken);
      const byId = new Map(body.employees.map((r) => [r.id, r]));
      expect(byId.get(r1.employeeId)?.hasRecordedTime).toBe(true);
      expect(byId.get(n1.employeeId)?.hasRecordedTime).toBe(false);
    });

    it("keeps every pre-existing key of the row with its type", async () => {
      const body = await overview(d.adminToken);
      const row = body.employees.find((r) => r.id === r1.employeeId) as OverviewRow;
      expect(typeof row.name).toBe("string");
      expect(typeof row.employeeNumber).toBe("string");
      expect(row.exitDate).toBeNull();
      expect(row.exitedWithOpenFinalSaldo).toBe(false);
      expect(typeof row.balanceHours).toBe("number");
      expect(typeof row.status).toBe("string");
      expect(typeof row.confirmedMinutes).toBe("number");
      expect(typeof row.openMonthMinutes).toBe("number");
      expect(typeof row.hasClosedMonth).toBe("boolean");
      expect(Array.isArray(row.snapshots)).toBe(true);
      expect(typeof body.exitedOpenFinalSaldoCount).toBe("number");
    });
  });
  describe("unclosed months", () => {
    let c: Record<"C1" | "C2" | "C3" | "C4" | "C5" | "EX", PopulationPerson>;

    beforeAll(async () => {
      c = {
        C1: await person("c1"),
        C2: await person("c2"),
        C3: await person("c3"),
        C4: await person("c4", "2026-07-01"),
        C5: await person("c5", "2026-03-15"),
        EX: await person("ex"),
      };
      // June closed, TZ-converted convention (Berlin: the instants of the local month as dates).
      await snapshot(c.C1.employeeId, "2026-05-31", "2026-06-30");
      // June closed, legacy convention (1st .. last day).
      await snapshot(c.C2.employeeId, "2026-06-01", "2026-06-30");
      // Only April closed, TZ-converted.
      await snapshot(c.C3.employeeId, "2026-03-31", "2026-04-30");
      await app.prisma.employee.update({
        where: { id: c.EX.employeeId },
        data: { isTimeTrackingExempt: true },
      });
    }, 120_000);

    it("counts the calendar months from the first open day through the current month", async () => {
      const body = await overview(d.adminToken);
      const months = (id: string) => body.employees.find((r) => r.id === id)?.unconfirmedMonths;
      expect(months(c.C1.employeeId)).toBe(1);
      expect(months(c.C2.employeeId)).toBe(1);
      expect(months(c.C3.employeeId)).toBe(3);
      expect(months(c.C4.employeeId)).toBe(1);
      expect(months(c.C5.employeeId)).toBe(5);
    });

    it("counts the finished but still unclosed month and the new month on the first of a month", async () => {
      // 1 August: the live window still ends on 31 July, but July is unclosed and August has begun.
      const body = await overview(d.adminToken, "", new Date("2026-08-01T10:00:00Z"));
      const months = (id: string) => body.employees.find((r) => r.id === id)?.unconfirmedMonths;
      expect(months(c.C1.employeeId)).toBe(2);
      expect(months(c.C4.employeeId)).toBe(2);
      expect(months(c.C3.employeeId)).toBe(4);
    });

    it("reports null for both breakdown facts of a person without a live saldo", async () => {
      const body = await overview(d.adminToken);
      const row = body.employees.find((r) => r.id === c.EX.employeeId) as OverviewRow;
      expect(row.openMonthMinutes).toBeNull();
      expect(row.unconfirmedMonths).toBeNull();
      expect(row.trackOnly).toBeNull();
    });
  });

  describe("track-only", () => {
    async function withContract(
      tag: string,
      data: Record<string, unknown>,
    ): Promise<PopulationPerson> {
      const p = await person(tag);
      await app.prisma.workSchedule.updateMany({ where: { employeeId: p.employeeId }, data });
      return p;
    }

    it("reports the #494 rule of today's contract", async () => {
      const noHours = await withContract("t1", { type: "MONTHLY_HOURS", monthlyHours: null });
      const hours = await withContract("t2", { type: "MONTHLY_HOURS", monthlyHours: 80 });
      const mode = await withContract("t3", {
        type: "MONTHLY_HOURS",
        monthlyHours: 80,
        overtimeMode: "TRACK_ONLY",
      });
      const fixed = await person("t4");
      const shift = await withContract("t5", { type: "SHIFT_BASED", contractWorkDaysPerWeek: 5 });
      const body = await overview(d.adminToken);
      const trackOnly = (id: string) => body.employees.find((r) => r.id === id)?.trackOnly;
      expect(trackOnly(noHours.employeeId)).toBe(true);
      expect(trackOnly(hours.employeeId)).toBe(false);
      expect(trackOnly(mode.employeeId)).toBe(true);
      expect(trackOnly(fixed.employeeId)).toBe(false);
      expect(trackOnly(shift.employeeId)).toBe(false);
    });
  });

  describe("reach (D-588-3)", () => {
    const PASSWORD = "test1234";
    let salonB: { id: string };
    let inA: PopulationPerson[];
    let inB: PopulationPerson[];
    let manager: PopulationPerson;

    beforeAll(async () => {
      salonB = await createTestSalon(app.prisma, d.tenant.id, { name: "OV588 Salon B" });
      inA = [await person("ra1"), await person("ra2")];
      inB = [
        await createPopulationPerson(app, {
          tenantId: d.tenant.id,
          salonId: salonB.id,
          tag: "rb1",
          hireDate: new Date("2025-01-01T00:00:00.000Z"),
        }),
        await createPopulationPerson(app, {
          tenantId: d.tenant.id,
          salonId: salonB.id,
          tag: "rb2",
          hireDate: new Date("2025-01-01T00:00:00.000Z"),
        }),
      ];
      await workEntry(inA[0].employeeId, "2026-07-02");
      await workEntry(inB[0].employeeId, "2026-07-02");
      manager = await createPopulationPerson(app, {
        tenantId: d.tenant.id,
        salonId: d.salonId,
        tag: "rm",
        hireDate: new Date("2025-01-01T00:00:00.000Z"),
        passwordHash: await bcrypt.hash(PASSWORD, 10),
      });
      // Two custom roles, one permission each, both on SALONS [A]: reach is the intersection.
      for (const key of ["team-overview:read:ZUGEWIESEN", "overtime:read:ZUGEWIESEN"]) {
        const name = `OV588 ${randomBytes(3).toString("hex")}`;
        const role = await app.prisma.accessRole.create({
          data: {
            tenantId: d.tenant.id,
            name,
            nameKey: roleNameKey(name),
            permissions: normalizeRolePermissions([key]),
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
      }
    }, 120_000);

    async function managerToken(): Promise<string> {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: manager.email, password: PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      return (JSON.parse(res.body) as { accessToken: string }).accessToken;
    }

    const byIdOrder = (a: OverviewRow, b: OverviewRow) => a.id.localeCompare(b.id);

    it("lists only the persons of the manager's salon, each with the three new keys", async () => {
      const mgrBody = await overview(await managerToken());
      const adminA = await overview(d.adminToken, `?salonId=${d.salonId}`);
      const ids = mgrBody.employees.map((r) => r.id);
      for (const p of inA) expect(ids).toContain(p.employeeId);
      for (const p of inB) expect(ids).not.toContain(p.employeeId);
      expect([...ids].sort((a, b) => a.localeCompare(b))).toEqual(
        adminA.employees.map((r) => r.id).sort((a, b) => a.localeCompare(b)),
      );
      for (const row of mgrBody.employees) {
        expect(typeof row.hasRecordedTime).toBe("boolean");
        expect(row).toHaveProperty("trackOnly");
        expect(row).toHaveProperty("unconfirmedMonths");
      }
      expect([...mgrBody.employees].sort(byIdOrder)).toEqual([...adminA.employees].sort(byIdOrder));
    });

    it("gives a whole-tenant caller under a salon filter the unfiltered rows of the same persons, new keys included", async () => {
      const all = await overview(d.adminToken);
      const filtered = await overview(d.adminToken, `?salonId=${d.salonId}`);
      expect(filtered.employees.length).toBeGreaterThan(0);
      expect(all.employees.length).toBeGreaterThan(filtered.employees.length);
      const unfilteredById = new Map(all.employees.map((r) => [r.id, r]));
      for (const row of filtered.employees) expect(row).toEqual(unfilteredById.get(row.id));
    });
  });

  describe("one read", () => {
    it("reads the recorded-time fact in exactly one groupBy per request, whatever the headcount", async () => {
      const body0 = await overview(d.adminToken);
      expect(body0.employees.length).toBeGreaterThanOrEqual(6);
      const spy = vi.spyOn(app.prisma.timeEntry, "groupBy");
      await overview(d.adminToken);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe("saldo unchanged", () => {
    it("shows, per person, the figures the personal endpoint shows", async () => {
      const body = await overview(d.adminToken);
      expect(body.employees.length).toBeGreaterThanOrEqual(6);
      for (const row of body.employees) {
        const personal = await withClock(d.adminToken, async (t) => {
          const res = await app.inject({
            method: "GET",
            url: `/api/v1/overtime/${row.id}`,
            headers: { authorization: `Bearer ${t}` },
          });
          expect(res.statusCode).toBe(200);
          return JSON.parse(res.body) as {
            balanceHours: number;
            confirmedMinutes: number;
            openMonthMinutes: number | null;
            hasClosedMonth: boolean;
          };
        });
        expect(row.balanceHours).toBe(personal.balanceHours);
        expect(row.confirmedMinutes).toBe(personal.confirmedMinutes);
        expect(row.openMonthMinutes).toBe(personal.openMonthMinutes);
        expect(row.hasClosedMonth).toBe(personal.hasClosedMonth);
        if (row.openMonthMinutes !== null) {
          expect(
            Math.abs(
              row.confirmedMinutes + row.openMonthMinutes - Math.round(row.balanceHours * 60),
            ),
          ).toBeLessThanOrEqual(1);
        }
      }
    });
  });
});
