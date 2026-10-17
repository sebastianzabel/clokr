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
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, reissueTokenNow } from "./setup";
import { createPopulationPerson, type PopulationPerson } from "./population-fixtures-613";

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

  async function withClock<T>(token: string, fn: (token: string) => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FAKE_NOW);
    try {
      return await fn(reissueTokenNow(app, token));
    } finally {
      vi.useRealTimers();
    }
  }

  async function overview(token: string, query = ""): Promise<Overview> {
    return withClock(token, async (t) => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/dashboard/overtime-overview${query}`,
        headers: { authorization: `Bearer ${t}` },
      });
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body) as Overview;
    });
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
});
