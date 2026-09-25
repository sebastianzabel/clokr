/**
 * Phase 91b Plan 02 (Issue #91) — unit + integration coverage for `contexts/platform/scope-filter.ts`
 * (D-07). This file starts with the TimeEntry pair (D-09, Task 2) — the one genuinely hard case,
 * requiring a raw-SQL Stammsalon-fallback per entry row — and grows with the remaining resource-type
 * pairs (D-10/D-11/D-12) in Task 3.
 *
 * `AccessReach` values are hand-built (no HTTP layer, no `resolveAccessReach` — that resolver is
 * Plan 91b-01's own, already tested); `scope-filter.ts`'s functions are exercised directly against
 * the real worker database, the same convention `resolve-access-reach.test.ts` uses for its sibling
 * facade function.
 *
 * No person names in fixtures (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { DEFAULT_SALON_OPENING_HOURS } from "../facade/salons";
import type { AccessReach } from "../access-context";
import { isTimeEntryInScope, scopedTimeEntryIds } from "../scope-filter";

type Seed = Awaited<ReturnType<typeof seedTestData>>;

function uniqueSuffix(label: string): string {
  return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const wholeTenant: AccessReach = { kind: "wholeTenant" };
function scoped(salonIds: string[], employeeIds: string[]): AccessReach {
  return { kind: "scoped", salonIds, employeeIds };
}

/** A `db` handle that throws on ANY property access — proves a code path never touches the DB.
 * Same shape as `resolve-access-reach.test.ts`'s own `dbThatMustNotBeTouched`. */
function dbThatMustNotBeTouched(): never {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("scope-filter must not read the database for this reach/branch");
      },
    },
  ) as never;
}

describe("scope-filter.ts — TimeEntry (Phase 91b Plan 02 Task 2, Issue #91, D-09)", () => {
  let app: FastifyInstance;
  let tenantA: Seed;
  let tenantB: Seed;
  let salonOld: { id: string };
  let salonNew: { id: string };
  let salonDirect: { id: string };
  let salonUnrelated: { id: string };

  async function createEmployee(namePrefix: string) {
    const s = uniqueSuffix(namePrefix);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
    });
    return app.prisma.employee.create({
      data: {
        tenantId: tenantA.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase(),
        firstName: namePrefix,
        lastName: "ScopeFilter",
        hireDate: new Date("2024-01-01"),
      },
    });
  }

  function createHome(
    employeeId: string,
    salonId: string,
    validFrom: string,
    validUntil: string | null,
  ) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date(validFrom),
        validUntil: validUntil ? new Date(validUntil) : null,
        weekdays: [],
      },
    });
  }

  function createEntry(
    employeeId: string,
    salonId: string,
    date: string,
    opts: { deletedAt?: Date } = {},
  ) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: new Date(date),
        startTime: new Date(`${date}T08:00:00Z`),
        endTime: new Date(`${date}T16:00:00Z`),
        type: "WORK",
        deletedAt: opts.deletedAt ?? null,
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "sf-te-a");
    tenantB = await seedTestData(app, "sf-te-b");

    const makeSalon = (name: string) =>
      app.prisma.salon.create({
        data: {
          tenantId: tenantA.tenant.id,
          name,
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: true,
        },
      });
    salonOld = await makeSalon("SF Salon Old");
    salonNew = await makeSalon("SF Salon New");
    salonDirect = await makeSalon("SF Salon Direct");
    salonUnrelated = await makeSalon("SF Salon Unrelated");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (tenantA):", err);
    }
    try {
      await cleanupTestData(app, tenantB.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (tenantB):", err);
    }
  });

  describe("isTimeEntryInScope", () => {
    it("wholeTenant reach is always true, with ZERO database reads", async () => {
      const result = await isTimeEntryInScope(
        dbThatMustNotBeTouched(),
        tenantA.tenant.id,
        wholeTenant,
        {
          salonId: salonUnrelated.id,
          employeeId: "00000000-0000-4000-8000-000000000001",
          date: new Date("2026-01-01"),
        },
      );
      expect(result).toBe(true);
    });

    it("a scoped reach with BOTH arrays empty is always false, with ZERO database reads", async () => {
      const result = await isTimeEntryInScope(
        dbThatMustNotBeTouched(),
        tenantA.tenant.id,
        scoped([], []),
        {
          salonId: salonUnrelated.id,
          employeeId: "00000000-0000-4000-8000-000000000002",
          date: new Date("2026-01-01"),
        },
      );
      expect(result).toBe(false);
    });

    it("entry's OWN salonId in reach.salonIds -> true, even when the employee's Stammsalon differs", async () => {
      const employee = await createEmployee("own-salon-match");
      await createHome(employee.id, salonUnrelated.id, "2024-01-01", null);

      const result = await isTimeEntryInScope(
        app.prisma,
        tenantA.tenant.id,
        scoped([salonDirect.id], []),
        { salonId: salonDirect.id, employeeId: employee.id, date: new Date("2026-01-01") },
      );
      expect(result).toBe(true);
    });

    it("entry's employeeId in reach.employeeIds -> true regardless of salon (PERSONS, salon-independent)", async () => {
      const employee = await createEmployee("person-match");
      await createHome(employee.id, salonUnrelated.id, "2024-01-01", null);

      const result = await isTimeEntryInScope(
        app.prisma,
        tenantA.tenant.id,
        scoped([], [employee.id]),
        { salonId: salonUnrelated.id, employeeId: employee.id, date: new Date("2026-01-01") },
      );
      expect(result).toBe(true);
    });

    it("neither own-salon nor employeeId match, but the Stammsalon AT THE ENTRY'S OWN DATE does -> true", async () => {
      const employee = await createEmployee("stammsalon-fallback");
      await createHome(employee.id, salonOld.id, "2024-01-01", "2026-05-31");
      await createHome(employee.id, salonNew.id, "2026-06-01", null);

      // Entry's own salon (salonUnrelated) matches nothing; on 2026-05-15 the Stammsalon is
      // salonOld — a reach scoped to salonOld must still include it.
      const result = await isTimeEntryInScope(
        app.prisma,
        tenantA.tenant.id,
        scoped([salonOld.id], []),
        { salonId: salonUnrelated.id, employeeId: employee.id, date: new Date("2026-05-15") },
      );
      expect(result).toBe(true);
    });

    it("none of the three branches match -> false", async () => {
      const employee = await createEmployee("no-match");
      await createHome(employee.id, salonUnrelated.id, "2024-01-01", null);

      const result = await isTimeEntryInScope(
        app.prisma,
        tenantA.tenant.id,
        scoped([salonDirect.id], []),
        { salonId: salonUnrelated.id, employeeId: employee.id, date: new Date("2026-01-01") },
      );
      expect(result).toBe(false);
    });
  });

  describe("scopedTimeEntryIds", () => {
    it("wholeTenant reach returns the sentinel 'all'", async () => {
      const result = await scopedTimeEntryIds(
        dbThatMustNotBeTouched(),
        tenantA.tenant.id,
        wholeTenant,
        new Date("2026-01-01"),
        new Date("2026-12-31"),
      );
      expect(result).toBe("all");
    });

    it("a scoped reach with BOTH arrays empty returns [] with ZERO database reads (no query attempted)", async () => {
      const result = await scopedTimeEntryIds(
        dbThatMustNotBeTouched(),
        tenantA.tenant.id,
        scoped([], []),
        new Date("2026-01-01"),
        new Date("2026-12-31"),
      );
      expect(result).toEqual([]);
    });

    it("the mid-range Stammsalon-change fixture: the SAME reach returns a DIFFERENT id set above vs. below the change date", async () => {
      const employee = await createEmployee("mid-range-change");
      await createHome(employee.id, salonOld.id, "2024-01-01", "2026-05-31");
      await createHome(employee.id, salonNew.id, "2026-06-01", null);

      // Both entries carry an UNRELATED own salon — only the per-row Stammsalon fallback can place
      // them in or out of scope.
      const entryBefore = await createEntry(employee.id, salonUnrelated.id, "2026-05-15");
      const entryAfter = await createEntry(employee.id, salonUnrelated.id, "2026-06-15");

      const scopedToOld = await scopedTimeEntryIds(
        app.prisma,
        tenantA.tenant.id,
        scoped([salonOld.id], []),
        new Date("2026-05-01"),
        new Date("2026-06-30"),
      );
      expect(scopedToOld).toEqual([entryBefore.id]);

      const scopedToNew = await scopedTimeEntryIds(
        app.prisma,
        tenantA.tenant.id,
        scoped([salonNew.id], []),
        new Date("2026-05-01"),
        new Date("2026-06-30"),
      );
      expect(scopedToNew).toEqual([entryAfter.id]);
    });

    it("scoped, salonIds only (employeeIds empty — no 'IN ()' built for the employee branch): an entry's OWN salonId match is included", async () => {
      const employee = await createEmployee("salon-only");
      await createHome(employee.id, salonUnrelated.id, "2024-01-01", null);
      const entry = await createEntry(employee.id, salonDirect.id, "2026-02-01");

      const result = await scopedTimeEntryIds(
        app.prisma,
        tenantA.tenant.id,
        scoped([salonDirect.id], []),
        new Date("2026-01-01"),
        new Date("2026-12-31"),
      );
      expect(result).toEqual([entry.id]);
    });

    it("scoped, employeeIds only (salonIds empty — no 'IN ()' built for the salon or Stammsalon branch): every entry of that employee is included regardless of salon", async () => {
      const employee = await createEmployee("employee-only");
      await createHome(employee.id, salonUnrelated.id, "2024-01-01", null);
      const entry1 = await createEntry(employee.id, salonUnrelated.id, "2026-03-01");
      const entry2 = await createEntry(employee.id, salonDirect.id, "2026-03-02");

      const result = await scopedTimeEntryIds(
        app.prisma,
        tenantA.tenant.id,
        scoped([], [employee.id]),
        new Date("2026-01-01"),
        new Date("2026-12-31"),
      );
      expect((result as string[]).sort()).toEqual([entry1.id, entry2.id].sort());
    });

    it("a soft-deleted entry, and an entry outside [dateFrom, dateTo], are never returned even when they would otherwise match", async () => {
      const employee = await createEmployee("deleted-and-out-of-window");
      await createHome(employee.id, salonUnrelated.id, "2024-01-01", null);
      const inWindow = await createEntry(employee.id, salonDirect.id, "2026-04-15");
      await createEntry(employee.id, salonDirect.id, "2026-04-16", { deletedAt: new Date() });
      await createEntry(employee.id, salonDirect.id, "2026-05-01"); // outside the window below

      const result = await scopedTimeEntryIds(
        app.prisma,
        tenantA.tenant.id,
        scoped([salonDirect.id], []),
        new Date("2026-04-01"),
        new Date("2026-04-30"),
      );
      expect(result).toEqual([inWindow.id]);
    });

    it("a foreign tenant's matching entry is never returned (tenant boundary via the Employee join)", async () => {
      const foreignSalon = await app.prisma.salon.create({
        data: {
          tenantId: tenantB.tenant.id,
          name: "SF Foreign Salon",
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: true,
        },
      });
      await app.prisma.timeEntry.create({
        data: {
          employeeId: tenantB.employee.id,
          salonId: foreignSalon.id,
          date: new Date("2026-07-01"),
          startTime: new Date("2026-07-01T08:00:00Z"),
          endTime: new Date("2026-07-01T16:00:00Z"),
          type: "WORK",
        },
      });

      // Reach names the foreign employee's own id directly — proves the tenant boundary is the
      // Employee join, not merely "the employeeId wasn't in reach".
      const result = await scopedTimeEntryIds(
        app.prisma,
        tenantA.tenant.id,
        scoped([], [tenantB.employee.id]),
        new Date("2026-01-01"),
        new Date("2026-12-31"),
      );
      expect(result).toEqual([]);
    });
  });
});
