/**
 * Phase 71b Plan 02 (issue #71, D-04) — behaviour of the central holiday resolution
 * (`holidaysForSalon`, `holidaysAtWorkLocation`), proven at resolver level (AC-4..AC-7) before any
 * of the 13 existing readers is switched onto it (that is plans 03-07 of this phase).
 *
 * Fronleichnam 2026 = Thursday 2026-06-04 (Easter 2026-04-05 + 60 days) — a statutory holiday in
 * BAYERN, not in NIEDERSACHSEN; June 2026 carries no NIEDERSACHSEN statutory holiday
 * (Pfingstmontag 2026 = 2026-05-25, before the fixture's June window).
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  getTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
} from "../../../__tests__/setup";
import {
  holidaysAtWorkLocation,
  holidaysForSalon,
  type WorkLocationEntry,
} from "../facade/holiday-resolution";
import { salonForDay, salonsForDays } from "../facade/salon-assignments";
import { dayToDate, addDays, type CalendarDay } from "../salon-assignment-rules";
import { getWorkedEntriesInRange } from "../../time-tracking";

describe("holidaysAtWorkLocation — tracer (Phase 71b Plan 02, issue #71, D-04, AC-4)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let salonAId: string; // BAYERN, created SECOND (not the tenant's default salon)
  let salonBId: string; // NIEDERSACHSEN, created FIRST (the tenant's default salon)
  let e1Id: string; // HOME B, closed WORK entry on 2026-06-04 in salon A
  let e2Id: string; // HOME B, closed WORK entry on 2026-06-04 in salon B

  beforeAll(async () => {
    app = await getTestApp();
    const seed = await seedTestData(app, "hr-tracer", { withDefaultSalon: false });
    tenantId = seed.tenant.id;

    const salonB = await createTestSalon(app.prisma, tenantId, { federalState: "NIEDERSACHSEN" });
    salonBId = salonB.id;
    const salonA = await createTestSalon(app.prisma, tenantId, { federalState: "BAYERN" });
    salonAId = salonA.id;

    async function createEmployee(label: string) {
      const user = await app.prisma.user.create({
        data: {
          email: `hr-tracer-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@test.de`,
          passwordHash: "x",
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      return app.prisma.employee.create({
        data: {
          tenantId,
          userId: user.id,
          employeeNumber: `HR-${label}-${Date.now().toString(36)}`,
          firstName: label,
          lastName: "Tracer",
          hireDate: new Date("2026-01-01"),
        },
      });
    }

    const e1 = await createEmployee("e1");
    e1Id = e1.id;
    const e2 = await createEmployee("e2");
    e2Id = e2.id;

    for (const employeeId of [e1Id, e2Id]) {
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId,
          employeeId,
          salonId: salonBId,
          kind: "HOME",
          validFrom: new Date("2026-01-01"),
          validUntil: null,
          weekdays: [],
        },
      });
    }

    // e1 worked Fronleichnam AT SALON A (Bayern) — a closed WORK entry.
    await app.prisma.timeEntry.create({
      data: {
        employeeId: e1Id,
        date: new Date("2026-06-04"),
        startTime: new Date("2026-06-04T08:00:00Z"),
        endTime: new Date("2026-06-04T16:00:00Z"),
        type: "WORK",
        salonId: salonAId,
      },
    });
    // e2 worked the SAME day AT SALON B (Niedersachsen) — same tenant, one date, two salons.
    await app.prisma.timeEntry.create({
      data: {
        employeeId: e2Id,
        date: new Date("2026-06-04"),
        startTime: new Date("2026-06-04T08:00:00Z"),
        endTime: new Date("2026-06-04T16:00:00Z"),
        type: "WORK",
        salonId: salonBId,
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("holiday-resolution tracer cleanup failed:", err);
    }
  });

  it("AC-4: one tenant, two Bundesländer, one date — a closed work entry decides, not a tenant-wide state", async () => {
    // Proves T2 (getWorkedEntriesInRange) now carries salonId — the resolver reads it from here,
    // never from a direct TimeEntry query of its own.
    const rows = await getWorkedEntriesInRange(
      app.prisma,
      { kind: "employees", employeeIds: [e1Id, e2Id], tenantId },
      new Date("2026-06-01"),
      new Date("2026-06-30"),
    );
    expect(rows.length).toBe(2);
    expect(rows.every((row) => typeof row.salonId === "string")).toBe(true);

    const entries = rows.map((row) => ({
      employeeId: row.employeeId,
      date: row.date,
      startTime: row.startTime,
      salonId: row.salonId,
    }));

    const result = await holidaysAtWorkLocation(
      app.prisma,
      tenantId,
      [e1Id, e2Id],
      "2026-06-01",
      "2026-06-30",
      entries,
    );

    expect(result.get(e1Id)?.get("2026-06-04")).toBe("Fronleichnam");
    expect(result.get(e2Id)?.has("2026-06-04")).toBe(false);
  });
});

describe("Resolver behaviour matrix — AC-5/AC-6/AC-7, holidaysForSalon, fail-closed, foreign ids, MULTI-ENTRY, query count, parity (Phase 71b Plan 02 Task 2, issue #71)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let salonAId: string; // BAYERN
  let salonBId: string; // NIEDERSACHSEN, the tenant's default salon (created first)
  let e3Id: string; // HOME B + DEPLOYMENT A Thursdays, no entry
  let e4Id: string; // HOME B only, no entry
  let e5Id: string; // HOME B + DEPLOYMENT A Thursdays, closed entry on B on Fronleichnam
  let e6Id: string; // hireDate 2026-06-15, NO assignment row at all
  let e7Id: string; // HOME A only
  let e8Id: string; // HOME B — used only for hand-built MULTI-ENTRY entries
  let e9Id: string; // HOME B — padding for the 7-employee query-count case
  let stadtfestId: string; // manual PublicHoliday id on salon A, 2026-06-10 "Stadtfest A"

  async function createEmployee(label: string, hireDate: string) {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `hr-matrix-${label}-${suffix}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    return app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `HRM-${label}-${suffix}`,
        firstName: label,
        lastName: "Matrix",
        hireDate: new Date(hireDate),
      },
    });
  }

  async function createHome(employeeId: string, salonId: string) {
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date("2026-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
  }

  async function createDeployment(employeeId: string, salonId: string, weekdays: number[]) {
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId,
        salonId,
        kind: "DEPLOYMENT",
        validFrom: new Date("2026-01-01"),
        validUntil: null,
        weekdays,
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    const seed = await seedTestData(app, "hr-matrix", { withDefaultSalon: false });
    tenantId = seed.tenant.id;

    const salonB = await createTestSalon(app.prisma, tenantId, { federalState: "NIEDERSACHSEN" });
    salonBId = salonB.id;
    const salonA = await createTestSalon(app.prisma, tenantId, { federalState: "BAYERN" });
    salonAId = salonA.id;

    const e3 = await createEmployee("e3", "2026-01-01");
    e3Id = e3.id;
    const e4 = await createEmployee("e4", "2026-01-01");
    e4Id = e4.id;
    const e5 = await createEmployee("e5", "2026-01-01");
    e5Id = e5.id;
    const e6 = await createEmployee("e6", "2026-06-15");
    e6Id = e6.id;
    const e7 = await createEmployee("e7", "2026-01-01");
    e7Id = e7.id;
    const e8 = await createEmployee("e8", "2026-01-01");
    e8Id = e8.id;
    const e9 = await createEmployee("e9", "2026-01-01");
    e9Id = e9.id;

    await createHome(e3Id, salonBId);
    await createDeployment(e3Id, salonAId, [3]); // Thursday

    await createHome(e4Id, salonBId);

    await createHome(e5Id, salonBId);
    await createDeployment(e5Id, salonAId, [3]);
    await app.prisma.timeEntry.create({
      data: {
        employeeId: e5Id,
        date: new Date("2026-06-04"),
        startTime: new Date("2026-06-04T08:00:00Z"),
        endTime: new Date("2026-06-04T16:00:00Z"),
        type: "WORK",
        salonId: salonBId,
      },
    });

    // e6: deliberately no assignment row at all.

    await createHome(e7Id, salonAId);
    await createHome(e8Id, salonBId);
    await createHome(e9Id, salonBId);

    const stadtfest = await app.prisma.publicHoliday.create({
      data: {
        tenantId,
        salonId: salonAId,
        date: new Date("2026-06-10"), // Wednesday
        name: "Stadtfest A",
        federalState: "BAYERN",
        year: 2026,
      },
    });
    stadtfestId = stadtfest.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("holiday-resolution matrix cleanup failed:", err);
    }
  });

  it("AC-5: a DEPLOYMENT weekday match makes the day a holiday via work-location fallback; a HOME-only employee is unaffected", async () => {
    const result = await holidaysAtWorkLocation(
      app.prisma,
      tenantId,
      [e3Id, e4Id],
      "2026-06-01",
      "2026-06-30",
      [],
    );
    expect(result.get(e3Id)?.get("2026-06-04")).toBe("Fronleichnam");
    expect(result.get(e4Id)?.has("2026-06-04")).toBe(false);
  });

  it("AC-6: a closed work entry beats the DEPLOYMENT pattern for the same day", async () => {
    const entries: WorkLocationEntry[] = [
      {
        employeeId: e5Id,
        date: new Date("2026-06-04"),
        startTime: new Date("2026-06-04T08:00:00Z"),
        salonId: salonBId,
      },
    ];
    const result = await holidaysAtWorkLocation(
      app.prisma,
      tenantId,
      [e5Id],
      "2026-06-01",
      "2026-06-30",
      entries,
    );
    expect(result.get(e5Id)?.has("2026-06-04")).toBe(false);
  });

  it("AC-7: a manual holiday applies only to employees resolved to that salon on that day", async () => {
    const result = await holidaysAtWorkLocation(
      app.prisma,
      tenantId,
      [e7Id, e3Id, e4Id],
      "2026-06-01",
      "2026-06-30",
      [],
    );
    expect(result.get(e7Id)?.get("2026-06-10")).toBe("Stadtfest A");
    // e3 is deployed to salon A only on Thursdays; 2026-06-10 is a Wednesday -> HOME salon B applies.
    expect(result.get(e3Id)?.has("2026-06-10")).toBe(false);
    expect(result.get(e4Id)?.has("2026-06-10")).toBe(false);
  });

  it("default fallback: an employee with NO assignment row resolves to the tenant's default salon, before and after their own hire date", async () => {
    const result = await holidaysAtWorkLocation(
      app.prisma,
      tenantId,
      [e6Id],
      "2026-06-01",
      "2026-06-30",
      [],
    );
    // Salon B (default) has no June holiday; if e6 had wrongly resolved to salon A, Stadtfest A
    // (2026-06-10) would leak in — it must not.
    expect(result.get(e6Id)?.size).toBe(0);
  });

  it("MULTI-ENTRY: several entries for one employee on one day — the earliest start decides", async () => {
    const day = "2026-06-04";
    const entry = (startTime: string, salonId: string): WorkLocationEntry => ({
      employeeId: e8Id,
      date: new Date(day),
      startTime: new Date(startTime),
      salonId,
    });

    const bEarliest = await holidaysAtWorkLocation(
      app.prisma,
      tenantId,
      [e8Id],
      "2026-06-01",
      "2026-06-30",
      [entry("2026-06-04T07:00:00Z", salonBId), entry("2026-06-04T13:00:00Z", salonAId)],
    );
    expect(bEarliest.get(e8Id)?.has(day)).toBe(false); // Niedersachsen has no Fronleichnam

    const aEarliest = await holidaysAtWorkLocation(
      app.prisma,
      tenantId,
      [e8Id],
      "2026-06-01",
      "2026-06-30",
      [entry("2026-06-04T13:00:00Z", salonBId), entry("2026-06-04T07:00:00Z", salonAId)],
    );
    expect(aEarliest.get(e8Id)?.get(day)).toBe("Fronleichnam");
  });

  it("a foreign/unknown employeeId is absent from the result; entries of non-requested employees are ignored", async () => {
    const foreignId = "00000000-0000-0000-0000-000000000000";
    const entries: WorkLocationEntry[] = [
      // e3's entry, but e3 is NOT in the requested employeeIds below — must be ignored.
      {
        employeeId: e3Id,
        date: new Date("2026-06-04"),
        startTime: new Date("2026-06-04T08:00:00Z"),
        salonId: salonAId,
      },
    ];
    const result = await holidaysAtWorkLocation(
      app.prisma,
      tenantId,
      [e4Id, foreignId],
      "2026-06-01",
      "2026-06-30",
      entries,
    );
    expect(result.has(foreignId)).toBe(false);
    expect(result.has(e4Id)).toBe(true);
    expect(result.get(e4Id)?.has("2026-06-04")).toBe(false);
  });

  it("fail-closed: a tenant whose only salon is deactivated, and an employee without an assignment, rejects rather than answering no-holiday", async () => {
    const failSeed = await seedTestData(app, "hr-matrix-failclosed", { withDefaultSalon: false });
    try {
      await createTestSalon(app.prisma, failSeed.tenant.id, {
        federalState: "BAYERN",
        isActive: false,
      });
      const employee = await app.prisma.employee.create({
        data: {
          tenantId: failSeed.tenant.id,
          userId: (
            await app.prisma.user.create({
              data: {
                email: `hr-matrix-fc-${Date.now().toString(36)}@test.de`,
                passwordHash: "x",
                role: "EMPLOYEE",
                isActive: true,
              },
            })
          ).id,
          employeeNumber: `HRM-FC-${Date.now().toString(36)}`,
          firstName: "FailClosed",
          lastName: "Matrix",
          hireDate: new Date("2026-01-01"),
        },
      });

      await expect(
        holidaysAtWorkLocation(
          app.prisma,
          failSeed.tenant.id,
          [employee.id],
          "2026-06-01",
          "2026-06-30",
          [],
        ),
      ).rejects.toThrow(/no active salon/);
    } finally {
      await cleanupTestData(app, failSeed.tenant.id);
    }
  });

  it("query count: employeeSalonAssignment.findMany and publicHoliday.findMany are each called exactly once for 7 employees over a full year; the result matches the per-employee equivalent", async () => {
    const employeeIds = [e3Id, e4Id, e5Id, e6Id, e7Id, e8Id, e9Id];
    expect(employeeIds.length).toBe(7);

    const assignmentSpy = vi.spyOn(app.prisma.employeeSalonAssignment, "findMany");
    const holidaySpy = vi.spyOn(app.prisma.publicHoliday, "findMany");

    const batched = await holidaysAtWorkLocation(
      app.prisma,
      tenantId,
      employeeIds,
      "2026-01-01",
      "2026-12-31",
      [],
    );

    expect(assignmentSpy).toHaveBeenCalledTimes(1);
    expect(holidaySpy).toHaveBeenCalledTimes(1);
    assignmentSpy.mockRestore();
    holidaySpy.mockRestore();

    for (const employeeId of employeeIds) {
      const single = await holidaysAtWorkLocation(
        app.prisma,
        tenantId,
        [employeeId],
        "2026-01-01",
        "2026-12-31",
        [],
      );
      expect([...(batched.get(employeeId) ?? new Map())]).toEqual([
        ...(single.get(employeeId) ?? new Map()),
      ]);
    }
  });

  it("parity: salonsForDays agrees with salonForDay for every day of a range", async () => {
    const from: CalendarDay = "2026-06-01";
    const to: CalendarDay = "2026-06-21";
    const batched = await salonsForDays(app.prisma, tenantId, [e3Id], from, to);
    const e3Map = batched.get(e3Id);
    expect(e3Map).toBeDefined();

    const days: CalendarDay[] = [];
    for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
    expect(days.length).toBeGreaterThan(0);

    for (const day of days) {
      const single = await salonForDay(app.prisma, tenantId, e3Id, dayToDate(day));
      expect(e3Map?.get(day) ?? null).toBe(single?.salonId ?? null);
    }
  });

  // Placed LAST: mutates salon A's manual-holiday set (creates then deletes a same-day override),
  // so it cannot affect the assertions above.
  it("holidaysForSalon: computed UNION manual, manual overrides the computed name on the same day, year boundary, foreign tenant's salon", async () => {
    const salonAHolidays = await holidaysForSalon(
      app.prisma,
      tenantId,
      salonAId,
      "2026-06-01",
      "2026-06-30",
    );
    expect(salonAHolidays).toEqual([
      { date: "2026-06-04", name: "Fronleichnam", manualHolidayId: null },
      { date: "2026-06-10", name: "Stadtfest A", manualHolidayId: stadtfestId },
    ]);

    const salonBHolidays = await holidaysForSalon(
      app.prisma,
      tenantId,
      salonBId,
      "2026-06-01",
      "2026-06-30",
    );
    expect(salonBHolidays).toEqual([]);

    const override = await app.prisma.publicHoliday.create({
      data: {
        tenantId,
        salonId: salonAId,
        date: new Date("2026-06-04"),
        name: "Fronleichnam (Salon)",
        federalState: "BAYERN",
        year: 2026,
      },
    });
    try {
      const overridden = await holidaysForSalon(
        app.prisma,
        tenantId,
        salonAId,
        "2026-06-01",
        "2026-06-30",
      );
      expect(overridden.find((h) => h.date === "2026-06-04")).toEqual({
        date: "2026-06-04",
        name: "Fronleichnam (Salon)",
        manualHolidayId: override.id,
      });
    } finally {
      await app.prisma.publicHoliday.delete({ where: { id: override.id } });
    }

    const newYear = await holidaysForSalon(
      app.prisma,
      tenantId,
      salonBId,
      "2026-12-28",
      "2027-01-03",
    );
    expect(newYear.some((h) => h.date === "2027-01-01" && h.name === "Neujahr")).toBe(true);

    const otherTenantSeed = await seedTestData(app, "hr-matrix-foreign-salon");
    try {
      const foreignSalonHolidays = await holidaysForSalon(
        app.prisma,
        tenantId,
        otherTenantSeed.salonId,
        "2026-06-01",
        "2026-06-30",
      );
      expect(foreignSalonHolidays).toEqual([]);
    } finally {
      await cleanupTestData(app, otherTenantSeed.tenant.id);
    }
  });
});
