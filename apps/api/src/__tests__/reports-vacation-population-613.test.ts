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
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, reissueTokenNow } from "./setup";
import { createPopulationPerson, type PopulationPerson } from "./population-fixtures-613";

const FAKE_NOW = new Date("2026-11-18T10:00:00Z");
const YEAR = 2026;

type Persons = Record<"E1" | "D" | "X" | "A" | "P", PopulationPerson>;

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
  async function withClock<T>(token: string, fn: (token: string) => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FAKE_NOW);
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
});
