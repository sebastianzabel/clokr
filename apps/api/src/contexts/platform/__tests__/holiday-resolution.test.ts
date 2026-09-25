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
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
} from "../../../__tests__/setup";
import { holidaysAtWorkLocation } from "../facade/holiday-resolution";
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
