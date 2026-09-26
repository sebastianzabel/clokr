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
import {
  isTimeEntryInScope,
  scopedTimeEntryIds,
  resolveStammsalonScopedEmployeeIds,
  isStammsalonScopeMatch,
  isShiftInScope,
  shiftScopeWhere,
  resolvePersonScopedEmployeeIds,
  isPersonMasterDataInScope,
} from "../scope-filter";

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
          federalState: "NIEDERSACHSEN", // Phase 71b (issue #71) — required since the merge; irrelevant to this test's own assertions
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
          federalState: "NIEDERSACHSEN", // Phase 71b (issue #71) — required since the merge; irrelevant to this test's own assertions
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

describe("scope-filter.ts — Stammsalon-only: leave/absence/saldo/exports (Phase 91b Plan 02 Task 3, Issue #91, D-10)", () => {
  let app: FastifyInstance;
  let tenantA: Seed;
  let salonX: { id: string };
  let salonY: { id: string };

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
        lastName: "ScopeFilterD10",
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

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "sf-d10-a");

    const makeSalon = (name: string) =>
      app.prisma.salon.create({
        data: {
          tenantId: tenantA.tenant.id,
          name,
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: true,
          federalState: "NIEDERSACHSEN", // Phase 71b (issue #71) — required since the merge; irrelevant to this test's own assertions
        },
      });
    salonX = await makeSalon("SF D10 Salon X");
    salonY = await makeSalon("SF D10 Salon Y");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  describe("resolveStammsalonScopedEmployeeIds", () => {
    it("wholeTenant reach returns the sentinel 'all', with ZERO database reads", async () => {
      const result = await resolveStammsalonScopedEmployeeIds(
        dbThatMustNotBeTouched(),
        tenantA.tenant.id,
        wholeTenant,
        new Date("2026-01-01"),
      );
      expect(result).toBe("all");
    });

    it("a scoped reach with BOTH arrays empty returns [], with ZERO database reads", async () => {
      const result = await resolveStammsalonScopedEmployeeIds(
        dbThatMustNotBeTouched(),
        tenantA.tenant.id,
        scoped([], []),
        new Date("2026-01-01"),
      );
      expect(result).toEqual([]);
    });

    it("the union of Stammsalon-at-Stichtag employees (salonIds) and reach.employeeIds, deduplicated", async () => {
      const empHome = await createEmployee("d10-home-match");
      await createHome(empHome.id, salonX.id, "2024-01-01", null);
      const empOther = await createEmployee("d10-employee-only");
      await createHome(empOther.id, salonY.id, "2024-01-01", null); // not in salonIds

      const result = await resolveStammsalonScopedEmployeeIds(
        app.prisma,
        tenantA.tenant.id,
        scoped([salonX.id], [empOther.id]),
        new Date("2026-01-01"),
      );
      expect((result as string[]).sort()).toEqual([empHome.id, empOther.id].sort());
    });
  });

  describe("isStammsalonScopeMatch", () => {
    it("wholeTenant reach is always true", async () => {
      const result = await isStammsalonScopeMatch(
        dbThatMustNotBeTouched(),
        tenantA.tenant.id,
        wholeTenant,
        "00000000-0000-4000-8000-000000000010",
        new Date("2026-01-01"),
      );
      expect(result).toBe(true);
    });

    it("employeeId in reach.employeeIds -> true, with ZERO database reads", async () => {
      const result = await isStammsalonScopeMatch(
        dbThatMustNotBeTouched(),
        tenantA.tenant.id,
        scoped([], ["00000000-0000-4000-8000-000000000011"]),
        "00000000-0000-4000-8000-000000000011",
        new Date("2026-01-01"),
      );
      expect(result).toBe(true);
    });

    it("salonIds empty and employeeId not in employeeIds -> false, with ZERO database reads", async () => {
      const result = await isStammsalonScopeMatch(
        dbThatMustNotBeTouched(),
        tenantA.tenant.id,
        scoped([], []),
        "00000000-0000-4000-8000-000000000012",
        new Date("2026-01-01"),
      );
      expect(result).toBe(false);
    });

    it("the Stichtag actually matters: the SAME reach gives a DIFFERENT answer for two different Stichtag values", async () => {
      const employee = await createEmployee("d10-stichtag-matters");
      await createHome(employee.id, salonX.id, "2024-01-01", "2025-12-31");
      await createHome(employee.id, salonY.id, "2026-01-01", null);

      const reach = scoped([salonX.id], []);
      const before = await isStammsalonScopeMatch(
        app.prisma,
        tenantA.tenant.id,
        reach,
        employee.id,
        new Date("2025-06-01"),
      );
      const after = await isStammsalonScopeMatch(
        app.prisma,
        tenantA.tenant.id,
        reach,
        employee.id,
        new Date("2026-06-01"),
      );
      expect(before).toBe(true);
      expect(after).toBe(false);
    });
  });
});

describe("scope-filter.ts — Shift (Phase 91b Plan 02 Task 3, Issue #91, D-11)", () => {
  let app: FastifyInstance;
  let tenantA: Seed;
  let salonX: { id: string };
  let salonY: { id: string };
  let employeeInReach: { id: string };
  let employeeOutOfReach: { id: string };

  async function createShift(salonId: string, employeeId: string, date: string) {
    return app.prisma.shift.create({
      data: {
        employeeId,
        salonId,
        date: new Date(date),
        startTime: "08:00",
        endTime: "16:00",
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "sf-d11-a");

    const makeSalon = (name: string) =>
      app.prisma.salon.create({
        data: {
          tenantId: tenantA.tenant.id,
          name,
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: true,
          federalState: "NIEDERSACHSEN", // Phase 71b (issue #71) — required since the merge; irrelevant to this test's own assertions
        },
      });
    salonX = await makeSalon("SF D11 Salon X");
    salonY = await makeSalon("SF D11 Salon Y");

    const mkEmployee = async (namePrefix: string) => {
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
          lastName: "ScopeFilterD11",
          hireDate: new Date("2024-01-01"),
        },
      });
    };
    employeeInReach = await mkEmployee("d11-in-reach");
    employeeOutOfReach = await mkEmployee("d11-out-of-reach");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  describe("isShiftInScope (pure — no db/tenantId parameter)", () => {
    it("wholeTenant reach is always true", () => {
      expect(isShiftInScope(wholeTenant, { salonId: salonY.id, employeeId: null })).toBe(true);
    });

    it("shift.salonId in reach.salonIds -> true", () => {
      expect(
        isShiftInScope(scoped([salonX.id], []), { salonId: salonX.id, employeeId: null }),
      ).toBe(true);
    });

    it("shift.employeeId non-null and in reach.employeeIds -> true", () => {
      expect(
        isShiftInScope(scoped([], [employeeInReach.id]), {
          salonId: salonY.id,
          employeeId: employeeInReach.id,
        }),
      ).toBe(true);
    });

    it("an UNASSIGNED shift (employeeId: null) with a salon NOT in reach.salonIds -> false (no Stammsalon fallback for shifts, D-11)", () => {
      expect(
        isShiftInScope(scoped([salonX.id], [employeeInReach.id]), {
          salonId: salonY.id,
          employeeId: null,
        }),
      ).toBe(false);
    });

    it("neither salon nor employee match -> false", () => {
      expect(
        isShiftInScope(scoped([salonX.id], [employeeInReach.id]), {
          salonId: salonY.id,
          employeeId: employeeOutOfReach.id,
        }),
      ).toBe(false);
    });
  });

  describe("shiftScopeWhere (pure — integration-tested against a real shift.findMany call)", () => {
    it("wholeTenant reach: {} adds no filter — both salons' shifts are returned", async () => {
      const shiftX = await createShift(salonX.id, employeeInReach.id, "2026-08-01");
      const shiftY = await createShift(salonY.id, employeeOutOfReach.id, "2026-08-02");

      const rows = await app.prisma.shift.findMany({
        where: { ...shiftScopeWhere(wholeTenant), id: { in: [shiftX.id, shiftY.id] } },
      });
      expect(rows.map((r) => r.id).sort()).toEqual([shiftX.id, shiftY.id].sort());
    });

    it("a scoped reach with BOTH arrays empty matches ZERO real rows (Prisma's own empty-in-array behavior, no manual FALSE guard needed)", async () => {
      const shift = await createShift(salonX.id, employeeInReach.id, "2026-08-03");

      const rows = await app.prisma.shift.findMany({
        where: { ...shiftScopeWhere(scoped([], [])), id: shift.id },
      });
      expect(rows).toEqual([]);
    });

    it("scoped, salonIds non-empty: only the matching-salon shift is returned", async () => {
      const shiftX = await createShift(salonX.id, employeeOutOfReach.id, "2026-08-04");
      const shiftY = await createShift(salonY.id, employeeOutOfReach.id, "2026-08-05");

      const rows = await app.prisma.shift.findMany({
        where: { ...shiftScopeWhere(scoped([salonX.id], [])), id: { in: [shiftX.id, shiftY.id] } },
      });
      expect(rows.map((r) => r.id)).toEqual([shiftX.id]);
    });

    it("scoped, employeeIds non-empty: only the matching-employee shift is returned, regardless of salon", async () => {
      const shiftMatch = await createShift(salonY.id, employeeInReach.id, "2026-08-06");
      const shiftOther = await createShift(salonY.id, employeeOutOfReach.id, "2026-08-07");

      const rows = await app.prisma.shift.findMany({
        where: {
          ...shiftScopeWhere(scoped([], [employeeInReach.id])),
          id: { in: [shiftMatch.id, shiftOther.id] },
        },
      });
      expect(rows.map((r) => r.id)).toEqual([shiftMatch.id]);
    });
  });
});

describe("scope-filter.ts — Person master data (Phase 91b Plan 02 Task 3, Issue #91, D-12)", () => {
  let app: FastifyInstance;
  let tenantA: Seed;
  let salonP: { id: string };
  let salonUnrelated: { id: string };
  let empHomeToday: { id: string };
  let empDeployToday: { id: string };
  let empPersonOnly: { id: string };
  let empOutOfScope: { id: string };

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
        lastName: "ScopeFilterD12",
        hireDate: new Date("2020-01-01"),
      },
    });
  }

  function createAssignment(
    employeeId: string,
    salonId: string,
    kind: "HOME" | "DEPLOYMENT",
    validFrom: string,
  ) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: tenantA.tenant.id,
        employeeId,
        salonId,
        kind,
        validFrom: new Date(validFrom),
        validUntil: null, // open-ended — always valid "today", whenever this test actually runs
        weekdays: [],
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "sf-d12-a");

    const makeSalon = (name: string) =>
      app.prisma.salon.create({
        data: {
          tenantId: tenantA.tenant.id,
          name,
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: true,
          federalState: "NIEDERSACHSEN", // Phase 71b (issue #71) — required since the merge; irrelevant to this test's own assertions
        },
      });
    salonP = await makeSalon("SF D12 Salon P");
    salonUnrelated = await makeSalon("SF D12 Salon Unrelated");

    empHomeToday = await createEmployee("d12-home-today");
    await createAssignment(empHomeToday.id, salonP.id, "HOME", "2020-01-01");

    empDeployToday = await createEmployee("d12-deploy-today");
    await createAssignment(empDeployToday.id, salonUnrelated.id, "HOME", "2020-01-01");
    await createAssignment(empDeployToday.id, salonP.id, "DEPLOYMENT", "2020-01-01");

    empPersonOnly = await createEmployee("d12-person-only");
    await createAssignment(empPersonOnly.id, salonUnrelated.id, "HOME", "2020-01-01");

    empOutOfScope = await createEmployee("d12-out-of-scope");
    await createAssignment(empOutOfScope.id, salonUnrelated.id, "HOME", "2020-01-01");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  describe("resolvePersonScopedEmployeeIds", () => {
    it("wholeTenant reach returns the sentinel 'all', with ZERO database reads", async () => {
      const result = await resolvePersonScopedEmployeeIds(
        dbThatMustNotBeTouched(),
        tenantA.tenant.id,
        wholeTenant,
      );
      expect(result).toBe("all");
    });

    it("a scoped reach with BOTH arrays empty returns [], with ZERO database reads", async () => {
      const result = await resolvePersonScopedEmployeeIds(
        dbThatMustNotBeTouched(),
        tenantA.tenant.id,
        scoped([], []),
      );
      expect(result).toEqual([]);
    });

    it("the union of Stammsalon-TODAY, active-DEPLOYMENT-TODAY and reach.employeeIds, deduplicated", async () => {
      const result = await resolvePersonScopedEmployeeIds(
        app.prisma,
        tenantA.tenant.id,
        scoped([salonP.id], [empPersonOnly.id]),
      );
      expect((result as string[]).sort()).toEqual(
        [empHomeToday.id, empDeployToday.id, empPersonOnly.id].sort(),
      );
      expect(result).not.toContain(empOutOfScope.id);
    });
  });

  describe("isPersonMasterDataInScope", () => {
    it("wholeTenant reach is always true", async () => {
      const result = await isPersonMasterDataInScope(
        dbThatMustNotBeTouched(),
        tenantA.tenant.id,
        wholeTenant,
        empOutOfScope.id,
      );
      expect(result).toBe(true);
    });

    it("employeeId in reach.employeeIds -> true, with ZERO database reads", async () => {
      const result = await isPersonMasterDataInScope(
        dbThatMustNotBeTouched(),
        tenantA.tenant.id,
        scoped([], [empPersonOnly.id]),
        empPersonOnly.id,
      );
      expect(result).toBe(true);
    });

    it("Stammsalon-today match -> true", async () => {
      const result = await isPersonMasterDataInScope(
        app.prisma,
        tenantA.tenant.id,
        scoped([salonP.id], []),
        empHomeToday.id,
      );
      expect(result).toBe(true);
    });

    it("active-deployment-today match -> true", async () => {
      const result = await isPersonMasterDataInScope(
        app.prisma,
        tenantA.tenant.id,
        scoped([salonP.id], []),
        empDeployToday.id,
      );
      expect(result).toBe(true);
    });

    it("neither Stammsalon-today, deployment-today, nor employeeIds match -> false", async () => {
      const result = await isPersonMasterDataInScope(
        app.prisma,
        tenantA.tenant.id,
        scoped([salonP.id], []),
        empOutOfScope.id,
      );
      expect(result).toBe(false);
    });
  });
});
