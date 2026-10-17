/**
 * Issue #613 (Phase 613, plan 02) — the leave and vacation readers use the period population.
 *
 * Tenant time zone Europe/Berlin, clock faked to 2026-11-18T10:00:00Z (only `Date`). Persons for
 * the year 2026 (no person names, no real e-mails — synthetic fixture):
 *   E1  left 2026-09-30, entitlement row            -> listed (real row)
 *   D   login deactivated, no exit, entitlement row -> listed (real row)
 *   X   in the population, NO vacation entitlement   -> placeholder row „kein Anspruch hinterlegt“
 *   A   anonymised sentinel, entitlement row        -> never listed, never healed
 *   P   left 2025-12-31, stale 2026 entitlement row -> never listed
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import * as pdfModule from "../composition/pdf";
import { runCarryoverWarningOnce } from "../contexts/absence/plugins/carryover-warning";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, reissueTokenNow } from "./setup";
import { createPopulationPerson, type PopulationPerson } from "./population-fixtures-613";

// A spy that still calls through: the Monatsexport exposes its rows only by feeding them into
// pdfkit (compressed streams), so the tests read the payload the route built. Issue #617: the
// vacation PDFs this file used to read were removed; the export's two sections replace them.
vi.mock("../composition/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../composition/pdf")>();
  return {
    ...actual,
    generateMonthlyExportPdf: vi.fn(actual.generateMonthlyExportPdf),
  };
});

const FAKE_NOW = new Date("2026-11-18T10:00:00Z");
// The export writes an audit row stamped with the faked clock; that instant must lie in the past of
// any real run (other tests count audit rows since their own start), unlike FAKE_NOW above.
const EXPORT_NOW = new Date("2026-10-05T10:00:00Z");
const YEAR = 2026;

type Persons = Record<"E1" | "D" | "X" | "A" | "P" | "O1" | "O2" | "T1" | "T2", PopulationPerson>;

interface OverviewRow {
  employee: { id: string; employeeNumber: string };
  missingEntitlement: boolean;
  totalDays: number | null;
}

describe("Issue #613 — leave and vacation population", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;
  let p: Persons;
  let aEntitlementId: string;

  /** Runs `fn` with the faked clock and a token valid under it. */
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

  async function getJson<T>(url: string, token = d.adminToken) {
    return withClock(token, async (t) => {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${t}` },
      });
      return { status: res.statusCode, body: JSON.parse(res.body) as T };
    });
  }

  async function entitlementFor(employeeId: string, usedDays = 0) {
    return app.prisma.leaveEntitlement.create({
      data: {
        employeeId,
        leaveTypeId: d.vacationType.id,
        year: YEAR,
        totalDays: 28,
        usedDays,
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "vac613");
    const base = { tenantId: d.tenant.id, salonId: d.salonId };
    const hire = new Date("2024-01-01T00:00:00.000Z");
    p = {
      ...({} as Persons),
      E1: await createPopulationPerson(app, {
        ...base,
        tag: "e1",
        hireDate: hire,
        exitDate: new Date("2026-09-30T00:00:00.000Z"),
      }),
      D: await createPopulationPerson(app, {
        ...base,
        tag: "d",
        hireDate: hire,
        loginActive: false,
      }),
      X: await createPopulationPerson(app, { ...base, tag: "x", hireDate: hire }),
      A: await createPopulationPerson(app, { ...base, tag: "a", hireDate: hire, anonymized: true }),
      P: await createPopulationPerson(app, {
        ...base,
        tag: "p",
        hireDate: hire,
        exitDate: new Date("2025-12-31T00:00:00.000Z"),
      }),
    };
    // Ordering fixture: first-name order is the reverse of last-name order (O1/O2), and two persons
    // share a last name (T1/T2) — the old overview sort by "first last" fails on both.
    const ordering = { ...base, hireDate: hire };
    p.O1 = await createPopulationPerson(app, { ...ordering, tag: "o1" });
    p.O2 = await createPopulationPerson(app, { ...ordering, tag: "o2" });
    p.T1 = await createPopulationPerson(app, { ...ordering, tag: "t1" });
    p.T2 = await createPopulationPerson(app, { ...ordering, tag: "t2" });
    for (const [person, firstName, lastName] of [
      [p.O1, "Zora", "P613Alpha"],
      [p.O2, "Abel", "P613Beta"],
      [p.T1, "Mia", "P613Same"],
      [p.T2, "Emil", "P613Same"],
    ] as const) {
      await app.prisma.employee.update({
        where: { id: person.employeeId },
        data: { firstName, lastName },
      });
      await entitlementFor(person.employeeId);
    }
    await entitlementFor(p.E1.employeeId);
    await entitlementFor(p.D.employeeId);
    // A carries a used-days figure the self-heal would reset to 0 if it touched the row.
    aEntitlementId = (await entitlementFor(p.A.employeeId, 7)).id;
    await entitlementFor(p.P.employeeId, 3);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, d.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("leave overview JSON", () => {
    it("lists E1 and D as real rows, X as a placeholder, and neither A nor P", async () => {
      const res = await getJson<OverviewRow[]>(`/api/v1/reports/leave-overview?year=${YEAR}`);
      expect(res.status).toBe(200);
      const byNumber = new Map(res.body.map((r) => [r.employee.employeeNumber, r]));
      for (const person of [p.E1, p.D]) {
        expect(byNumber.get(person.employeeNumber)?.missingEntitlement).toBe(false);
      }
      const placeholder = byNumber.get(p.X.employeeNumber);
      expect(placeholder?.missingEntitlement).toBe(true);
      expect(placeholder?.totalDays).toBeNull();
      expect(byNumber.has(p.A.employeeNumber)).toBe(false);
      expect(byNumber.has(p.P.employeeNumber)).toBe(false);
    });

    it("does not write the anonymised person's entitlement by viewing the report", async () => {
      const before = await app.prisma.leaveEntitlement.findUniqueOrThrow({
        where: { id: aEntitlementId },
      });
      const res = await getJson<OverviewRow[]>(`/api/v1/reports/leave-overview?year=${YEAR}`);
      expect(res.status).toBe(200);
      const after = await app.prisma.leaveEntitlement.findUniqueOrThrow({
        where: { id: aEntitlementId },
      });
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(Number(after.usedDays)).toBe(Number(before.usedDays));
      expect(Number(after.usedDays)).toBe(7);
    });
  });

  /** The payload the Monatsexport route built for September 2026 (past month, Stichtag 30.09.). */
  async function exportPayload() {
    const spy = vi.mocked(pdfModule.generateMonthlyExportPdf);
    spy.mockClear();
    const res = await withClock(
      d.adminToken,
      async (t) =>
        app.inject({
          method: "GET",
          url: `/api/v1/reports/monthly-export/pdf?year=${YEAR}&month=9`,
          headers: { authorization: `Bearer ${t}` },
        }),
      EXPORT_NOW,
    );
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    return spy.mock.calls[0][0];
  }

  describe("Monatsexport (successor of the vacation list and overview PDFs, #617)", () => {
    it("both sections name the same persons in last name, first name, id order", async () => {
      const data = await exportPayload();
      // One row per person carries the month section and the vacation section, so the two
      // sections list the same persons in the same order by construction; the order is the rule.
      const numbers = data.rows.map((r) => r.employeeNumber);
      expect(numbers).toEqual(
        expect.arrayContaining([p.E1, p.D, p.X].map((x) => x.employeeNumber)),
      );
      // P left before the year began: in no month of 2026.
      expect(numbers).not.toContain(p.P.employeeNumber);

      const at = (x: PopulationPerson) => numbers.indexOf(x.employeeNumber);
      expect(at(p.O1)).toBeGreaterThanOrEqual(0);
      expect(at(p.O1)).toBeLessThan(at(p.O2)); // Alpha before Beta although "Zora" > "Abel"
      expect(at(p.T2)).toBeLessThan(at(p.T1)); // same last name, Emil before Mia
    });

    it("a person without a VACATION entitlement has vacation null; real rows carry the figures", async () => {
      const data = await exportPayload();
      const row = (x: PopulationPerson) =>
        data.rows.find((r) => r.employeeNumber === x.employeeNumber);
      expect(row(p.X)?.vacation).toBeNull();
      for (const person of [p.E1, p.D]) {
        expect(row(person)?.vacation).not.toBeNull();
      }
      expect(row(p.E1)?.vacation?.entitlementDays).toBe(28);
    });
  });

  describe("carry-over list and cron", () => {
    const CARRY_NOW = new Date("2026-02-10T10:00:00Z");
    const DAY_MS = 24 * 60 * 60 * 1000;

    it("neither the warning list nor the cron names an anonymised person; the exit rule stays", async () => {
      const base = { tenantId: d.tenant.id, salonId: d.salonId };
      const hire = new Date("2024-01-01T00:00:00.000Z");
      const carry = {
        K: await createPopulationPerson(app, { ...base, tag: "ck", hireDate: hire }),
        D: await createPopulationPerson(app, {
          ...base,
          tag: "cd",
          hireDate: hire,
          loginActive: false,
        }),
        A: await createPopulationPerson(app, {
          ...base,
          tag: "ca",
          hireDate: hire,
          anonymized: true,
        }),
        F: await createPopulationPerson(app, {
          ...base,
          tag: "cf",
          hireDate: hire,
          exitDate: new Date("2026-06-30T00:00:00.000Z"),
        }),
      };
      // 30 days after the faked "now": a default warning threshold (60/30/14/7) matches
      const deadline = new Date(CARRY_NOW.getTime() + 30 * DAY_MS);
      const entitlementIds: Record<string, string> = {};
      for (const [key, person] of Object.entries(carry)) {
        const ent = await app.prisma.leaveEntitlement.create({
          data: {
            employeeId: person.employeeId,
            leaveTypeId: d.vacationType.id,
            year: YEAR,
            totalDays: 28,
            usedDays: 0,
            carriedOverDays: 5,
            carryOverDeadline: deadline,
          },
        });
        entitlementIds[key] = ent.id;
      }
      await app.prisma.tenantConfig.update({
        where: { tenantId: d.tenant.id },
        data: { carryoverWarningEnabled: true, carryoverWarningThresholds: [60, 30, 14, 7] },
      });

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(CARRY_NOW);
      let listed: string[];
      try {
        const token = reissueTokenNow(app, d.adminToken);
        const res = await app.inject({
          method: "GET",
          url: "/api/v1/reports/carryover-at-risk",
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        listed = (JSON.parse(res.body) as { rows: Array<{ entitlementId: string }> }).rows.map(
          (r) => r.entitlementId,
        );
        await runCarryoverWarningOnce(app, { onlyTenantId: d.tenant.id });
      } finally {
        vi.useRealTimers();
      }

      const warned = (
        await app.prisma.auditLog.findMany({
          where: {
            action: "CARRYOVER_WARNED",
            entity: "LeaveEntitlement",
            entityId: { in: Object.values(entitlementIds) },
          },
          select: { entityId: true },
        })
      ).map((r) => r.entityId);

      // the unchanged BUrlG rule: no exit date; the login state does not matter
      expect(listed).toEqual(expect.arrayContaining([entitlementIds.K, entitlementIds.D]));
      expect(warned).toEqual(expect.arrayContaining([entitlementIds.K, entitlementIds.D]));
      expect(listed).not.toContain(entitlementIds.F);
      expect(warned).not.toContain(entitlementIds.F);
      // Issue #613: the anonymised person is neither listed nor warned
      expect(listed).not.toContain(entitlementIds.A);
      expect(warned).not.toContain(entitlementIds.A);
      expect(
        await app.prisma.notification.count({
          where: { userId: carry.A.userId, type: "CARRYOVER_EXPIRING" },
        }),
      ).toBe(0);
      // list and cron select the same entitlements of the fixture
      const mine = new Set(Object.values(entitlementIds));
      expect(listed.filter((id) => mine.has(id)).sort((a, b) => a.localeCompare(b))).toEqual(
        warned
          .filter((id): id is string => id !== null && mine.has(id))
          .sort((a, b) => a.localeCompare(b)),
      );
    });
  });
});
