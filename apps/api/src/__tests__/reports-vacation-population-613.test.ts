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
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, reissueTokenNow } from "./setup";
import { createPopulationPerson, type PopulationPerson } from "./population-fixtures-613";

// Spies that still call through: the PDF handlers expose their rows only by feeding them into
// pdfkit (compressed streams), so the tests read the payload the route built.
vi.mock("../composition/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../composition/pdf")>();
  return {
    ...actual,
    streamLeaveListPdf: vi.fn(actual.streamLeaveListPdf),
    streamVacationOverviewPdf: vi.fn(actual.streamVacationOverviewPdf),
    generateVacationOverviewPdf: vi.fn(actual.generateVacationOverviewPdf),
  };
});

const FAKE_NOW = new Date("2026-11-18T10:00:00Z");
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

  // The payload each PDF handler built, newest call.
  function lastCall<T extends (...args: never[]) => unknown>(fn: T) {
    const calls = vi.mocked(fn).mock.calls;
    return calls[calls.length - 1] as unknown as Parameters<T>;
  }

  async function getPdf(url: string) {
    const res = await withClock(d.adminToken, async (t) =>
      app.inject({ method: "GET", url, headers: { authorization: `Bearer ${t}` } }),
    );
    expect(res.statusCode).toBe(200);
  }

  const numbersOf = (rows: Array<{ employeeNumber: string }>) => rows.map((r) => r.employeeNumber);

  describe("vacation PDF", () => {
    it("list part and overview part name the same persons in the same order", async () => {
      await getPdf(`/api/v1/reports/vacation/pdf?year=${YEAR}`);
      const list = lastCall(pdfModule.streamLeaveListPdf)[1];
      const overview = lastCall(pdfModule.streamVacationOverviewPdf)[1];
      const listNumbers = numbersOf(list.employees);
      const overviewNumbers = numbersOf(overview.employees);
      expect(listNumbers).toEqual(overviewNumbers);
      expect(listNumbers).toEqual(
        expect.arrayContaining([p.E1, p.D, p.X].map((x) => x.employeeNumber)),
      );
      expect(listNumbers).not.toContain(p.A.employeeNumber);
      expect(listNumbers).not.toContain(p.P.employeeNumber);

      // order: last name, first name, id — checked on the ordering fixture inside the payload
      const at = (x: PopulationPerson) => overviewNumbers.indexOf(x.employeeNumber);
      expect(at(p.O1)).toBeGreaterThanOrEqual(0);
      expect(at(p.O1)).toBeLessThan(at(p.O2)); // Alpha before Beta although "Zora" > "Abel"
      expect(at(p.T2)).toBeLessThan(at(p.T1)); // same last name, Emil before Mia
    });

    it("a person without an entitlement is a placeholder row, listed in the list part too", async () => {
      await getPdf(`/api/v1/reports/vacation/pdf?year=${YEAR}`);
      const list = lastCall(pdfModule.streamLeaveListPdf)[1];
      const overview = lastCall(pdfModule.streamVacationOverviewPdf)[1];
      const row = overview.employees.find((r) => r.employeeNumber === p.X.employeeNumber);
      expect(row?.missingEntitlement).toBe(true);
      expect(row?.totalDays).toBeUndefined();
      expect(numbersOf(list.employees)).toContain(p.X.employeeNumber);
      const real = overview.employees.find((r) => r.employeeNumber === p.E1.employeeNumber);
      expect(real?.missingEntitlement).toBeFalsy();
      expect(real?.totalDays).toBe(28);
    });
  });

  describe("leave list and overview PDF", () => {
    it("the standalone overview PDF has the vacation PDF's persons in the same order", async () => {
      await getPdf(`/api/v1/reports/vacation/pdf?year=${YEAR}`);
      const fromVacation = numbersOf(lastCall(pdfModule.streamVacationOverviewPdf)[1].employees);
      await getPdf(`/api/v1/reports/leave-overview/pdf?year=${YEAR}`);
      const standalone = lastCall(pdfModule.generateVacationOverviewPdf)[0];
      expect(numbersOf(standalone.employees)).toEqual(fromVacation);
      const placeholder = standalone.employees.find((r) => r.employeeNumber === p.X.employeeNumber);
      expect(placeholder?.missingEntitlement).toBe(true);
    });

    it("the leave list PDF has the vacation PDF's list part", async () => {
      await getPdf(`/api/v1/reports/vacation/pdf?year=${YEAR}`);
      const fromVacation = numbersOf(lastCall(pdfModule.streamLeaveListPdf)[1].employees);
      await getPdf(`/api/v1/reports/leave-list/pdf?year=${YEAR}`);
      expect(numbersOf(lastCall(pdfModule.streamLeaveListPdf)[1].employees)).toEqual(fromVacation);
    });
  });
});
