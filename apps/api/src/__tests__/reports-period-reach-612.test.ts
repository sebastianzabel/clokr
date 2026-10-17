/**
 * Issue #612 (AC-612-5, D-612-7, T-612-08) — `GET /api/v1/reports/period` shows a caller only the
 * persons of his reach, and a Soll or saldo value only where `overtime:read` covers the person.
 *
 * Fixture (tenant Europe/Berlin, `Date` faked to 2026-10-15T10:00Z, period August to September):
 *   RA1, RA2 homed in salon A; RB1, RB2 homed in salon B; every person records time in both months.
 * Callers (each an employee of its own without a Stammsalon):
 *   admin      - the seeded tenant admin (whole tenant, every permission)
 *   manager    - the MANAGER system role scoped to salon A
 *   partial    - a custom role: report:read TENANT + overtime:read SALONS[A]
 *   noOvertime - a custom role: report:read TENANT only
 * The matrix of caller x person -> saldo shown / withheld is printed once (`console.info`).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { randomBytes, randomUUID } from "crypto";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { createPopulationPerson } from "./population-fixtures-613";
import { normalizeRolePermissions, roleNameKey, SYSTEM_ROLE_IDS } from "../contexts/platform";

const PASSWORD = "test1234";
const FAKE_NOW = "2026-10-15T10:00:00.000Z";
const byText = (a: string, b: string): number => a.localeCompare(b);

type Row = {
  employeeId: string;
  workedMinutes: number;
  expectedMinutes: number | null;
  balanceMinutes: number | null;
  openingBalanceMinutes: number | null;
  closingBalanceMinutes: number | null;
  sollUnavailableReason?: string;
  months: Array<{
    expectedMinutes: number | null;
    balanceMinutes: number | null;
    closingBalanceMinutes: number | null;
  }>;
};
type Period = {
  kpis: {
    personCount: number;
    saldoPersonCount: number;
    workedMinutes: number;
    expectedMinutes: number | null;
    balanceMinutes: number | null;
    closingBalanceMinutes: number | null;
  };
  rows: Row[];
};

describe("Issue #612 — the period report's reach (AC-612-5)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: string;
  let salonB: string;
  const ids = {} as Record<"RA1" | "RA2" | "RB1" | "RB2", string>;
  let managerToken: string;
  let partialToken: string;
  let noOvertimeToken: string;
  let foreignPerson: string;

  function entry(employeeId: string, salonId: string, date: string) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: new Date(`${date}T00:00:00Z`),
        startTime: new Date(`${date}T08:00:00Z`),
        endTime: new Date(`${date}T16:00:00Z`),
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
      },
    });
  }
  function get(url: string, token = data.adminToken) {
    return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  }
  async function period(query: string, token = data.adminToken): Promise<Period> {
    const res = await get(`/api/v1/reports/period?${query}`, token);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Period;
  }
  const rowOf = (r: Period, id: string): Row => {
    const row = r.rows.find((x) => x.employeeId === id);
    if (!row) throw new Error(`row ${id} missing`);
    return row;
  };
  const ofFixture = (r: Period): Row[] =>
    r.rows.filter((x) => Object.values(ids).includes(x.employeeId));

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(FAKE_NOW));
    app = await getTestApp();
    data = await seedTestData(app, "rpr612");
    foreign = await seedTestData(app, "rpr612f");
    salonA = data.salonId;
    salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "Reach612 B" })).id;

    const hire = new Date("2025-01-01T00:00:00Z");
    const mk = async (tag: "RA1" | "RA2" | "RB1" | "RB2", salonId: string) => {
      const p = await createPopulationPerson(app, {
        tenantId: data.tenant.id,
        salonId,
        tag,
        hireDate: hire,
      });
      ids[tag] = p.employeeId;
      for (const d of ["2026-08-03", "2026-08-04", "2026-09-01", "2026-09-02"]) {
        await entry(p.employeeId, salonId, d);
      }
    };
    await mk("RA1", salonA);
    await mk("RA2", salonA);
    await mk("RB1", salonB);
    await mk("RB2", salonB);

    // A person of the foreign tenant, to prove a foreign employeeId answers like an unknown one.
    const fp = await createPopulationPerson(app, {
      tenantId: foreign.tenant.id,
      salonId: foreign.salonId as string,
      tag: "RF",
      hireDate: hire,
    });
    foreignPerson = fp.employeeId;

    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const caller = async (
      tag: string,
      assignments: Array<
        | { accessRoleId: string; scopeType: "SALONS"; salonIds: string[] }
        | { permissions: string[]; scopeType: "TENANT" | "SALONS"; salonIds?: string[] }
      >,
    ): Promise<string> => {
      const suffix = `${tag}-${randomBytes(3).toString("hex")}`;
      const user = await app.prisma.user.create({
        data: {
          email: `rpr612-${suffix}@example.invalid`,
          passwordHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      await app.prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: user.id,
          employeeNumber: `RPR${suffix}`.toUpperCase().slice(0, 20),
          firstName: "Fixture",
          lastName: "PeriodReach612",
          hireDate: new Date("2024-01-01"),
        },
      });
      for (const assignment of assignments) {
        let accessRoleId: string;
        if ("accessRoleId" in assignment) {
          accessRoleId = assignment.accessRoleId;
        } else {
          const name = `Reach612 ${suffix} ${assignment.permissions.join("+")}`;
          const role = await app.prisma.accessRole.create({
            data: {
              tenantId: data.tenant.id,
              name,
              nameKey: roleNameKey(name),
              permissions: normalizeRolePermissions(assignment.permissions),
            },
          });
          accessRoleId = role.id;
        }
        await app.prisma.roleAssignment.create({
          data: {
            tenantId: data.tenant.id,
            userId: user.id,
            accessRoleId,
            scopeType: assignment.scopeType,
            salonIds: assignment.salonIds ?? [],
            employeeIds: [],
          },
        });
      }
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: user.email, password: PASSWORD },
      });
      expect(login.statusCode, login.body).toBe(200);
      return (JSON.parse(login.body) as { accessToken: string }).accessToken;
    };
    managerToken = await caller("mgr", [
      { accessRoleId: SYSTEM_ROLE_IDS.MANAGER, scopeType: "SALONS", salonIds: [salonA] },
    ]);
    partialToken = await caller("part", [
      { permissions: ["report:read:ZUGEWIESEN"], scopeType: "TENANT" },
      { permissions: ["overtime:read:ZUGEWIESEN"], scopeType: "SALONS", salonIds: [salonA] },
    ]);
    noOvertimeToken = await caller("noot", [
      { permissions: ["report:read:ZUGEWIESEN"], scopeType: "TENANT" },
    ]);
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      for (const tenantId of [data.tenant.id, foreign.tenant.id]) {
        await app.prisma.roleAssignment.deleteMany({ where: { tenantId } });
        await app.prisma.accessRole.deleteMany({ where: { tenantId } });
        await cleanupTestData(app, tenantId);
      }
    } catch (err) {
      console.error("reports-period-reach-612 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("a SALONS[A] manager sees only the persons homed in A, with saldo", async () => {
    const r = await period("from=2026-08&to=2026-09", managerToken);
    expect(r.rows.map((x) => x.employeeId).sort(byText)).toEqual([ids.RA1, ids.RA2].sort(byText));
    for (const row of r.rows) {
      expect(row.sollUnavailableReason, row.employeeId).toBeUndefined();
      expect(typeof row.expectedMinutes).toBe("number");
      expect(typeof row.balanceMinutes).toBe("number");
      expect(typeof row.closingBalanceMinutes).toBe("number");
    }
    expect(r.kpis.personCount).toBe(2);
    expect(r.kpis.saldoPersonCount).toBe(2);
  });

  it("report:read for the tenant with overtime:read for salon A only: A persons with saldo, the rest withheld, KPIs over A only", async () => {
    const r = await period("from=2026-08&to=2026-09", partialToken);
    for (const id of [ids.RA1, ids.RA2]) {
      const row = rowOf(r, id);
      expect(row.sollUnavailableReason).toBeUndefined();
      expect(typeof row.expectedMinutes).toBe("number");
      expect(typeof row.balanceMinutes).toBe("number");
      expect(typeof row.closingBalanceMinutes).toBe("number");
    }
    for (const id of [ids.RB1, ids.RB2]) {
      const row = rowOf(r, id);
      expect(row.sollUnavailableReason).toBe("NO_PERMISSION");
      expect(row.expectedMinutes).toBeNull();
      expect(row.balanceMinutes).toBeNull();
      expect(row.openingBalanceMinutes).toBeNull();
      expect(row.closingBalanceMinutes).toBeNull();
      // Ist stays with report:read.
      expect(row.workedMinutes).toBe(32 * 60);
      for (const m of row.months) {
        expect(m.expectedMinutes).toBeNull();
        expect(m.balanceMinutes).toBeNull();
        expect(m.closingBalanceMinutes).toBeNull();
      }
    }
    const covered = r.rows.filter((x) => x.sollUnavailableReason === undefined);
    const coveredIds = covered.map((x) => x.employeeId);
    // The tenant's other persons (seed employees, the callers) have no Stammsalon and are not covered either.
    expect(coveredIds.sort(byText)).toEqual([ids.RA1, ids.RA2].sort(byText));
    expect(r.kpis.saldoPersonCount).toBe(2);
    expect(r.kpis.personCount).toBe(r.rows.length);
    expect(r.kpis.expectedMinutes).toBe(covered.reduce((s, x) => s + (x.expectedMinutes ?? 0), 0));
    expect(r.kpis.balanceMinutes).toBe(covered.reduce((s, x) => s + (x.balanceMinutes ?? 0), 0));
    expect(r.kpis.closingBalanceMinutes).toBe(
      covered.reduce((s, x) => s + (x.closingBalanceMinutes ?? 0), 0),
    );
    // Not vacuous: the withheld persons exist, and the sums are not the whole tenant's.
    expect(r.kpis.workedMinutes).toBeGreaterThan(covered.reduce((s, x) => s + x.workedMinutes, 0));
  });

  it("report:read without overtime:read shows no Soll and no saldo anywhere", async () => {
    const r = await period("from=2026-08&to=2026-09", noOvertimeToken);
    expect(ofFixture(r)).toHaveLength(4);
    for (const row of r.rows) {
      expect(row.sollUnavailableReason, row.employeeId).toBe("NO_PERMISSION");
      expect(row.expectedMinutes).toBeNull();
      expect(row.balanceMinutes).toBeNull();
      expect(row.openingBalanceMinutes).toBeNull();
      expect(row.closingBalanceMinutes).toBeNull();
    }
    expect(r.kpis.saldoPersonCount).toBe(0);
    expect(r.kpis.expectedMinutes).toBeNull();
    expect(r.kpis.balanceMinutes).toBeNull();
    expect(r.kpis.closingBalanceMinutes).toBeNull();
    expect(r.kpis.workedMinutes).toBeGreaterThan(0);
  });

  it("a foreign or unknown employeeId gives the same empty answer", async () => {
    const foreignRes = await get(
      `/api/v1/reports/period?from=2026-08&to=2026-09&employeeId=${foreignPerson}`,
    );
    const unknownRes = await get(
      `/api/v1/reports/period?from=2026-08&to=2026-09&employeeId=${randomUUID()}`,
    );
    expect(foreignRes.statusCode).toBe(200);
    expect(unknownRes.statusCode).toBe(200);
    expect(foreignRes.body).toBe(unknownRes.body);
    const body = JSON.parse(foreignRes.body) as Period;
    expect(body.rows).toEqual([]);
    expect(body.kpis.personCount).toBe(0);
    // A person of another salon is out of the manager's reach: the same empty answer.
    const outside = await get(
      `/api/v1/reports/period?from=2026-08&to=2026-09&employeeId=${ids.RB1}`,
      managerToken,
    );
    expect(outside.statusCode).toBe(200);
    expect((JSON.parse(outside.body) as Period).rows).toEqual([]);
    // Not vacuous: the same id is visible to the admin.
    const own = await period(`from=2026-08&to=2026-09&employeeId=${ids.RB1}`);
    expect(own.rows.map((x) => x.employeeId)).toEqual([ids.RB1]);
  });

  it("prints the caller x person matrix (saldo shown / withheld)", async () => {
    const callers: Array<[string, string]> = [
      ["admin", data.adminToken],
      ["manager A", managerToken],
      ["partial (overtime A)", partialToken],
      ["no overtime", noOvertimeToken],
    ];
    const lines: string[] = [];
    for (const [label, token] of callers) {
      const r = await period("from=2026-08&to=2026-09", token);
      const cells = (["RA1", "RA2", "RB1", "RB2"] as const).map((tag) => {
        const row = r.rows.find((x) => x.employeeId === ids[tag]);
        if (!row) return `${tag}: absent`;
        return `${tag}: ${row.sollUnavailableReason === undefined ? "saldo" : "withheld"}`;
      });
      lines.push(`${label.padEnd(22)} ${cells.join(" | ")}`);
    }
    console.info(`[612-02] reach matrix\n${lines.join("\n")}`);
    expect(lines).toHaveLength(4);
  });
});
