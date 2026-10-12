/**
 * Phase 87b (Issue #87), D-10 — `currentAndFutureAssignmentSalonIds`, the one Unterbau answer to
 * "which salons do this employee's current and future salon assignments name".
 *
 * Why it exists: the clock-salon preselection of Zeiterfassung ("exactly one salon, so no choice")
 * must not restate the assignment-validity rules (voided rows, tenant-local calendar day, ended
 * rows). `contextSalonIds` (Phase 82) reads the same answer for the caller's own salons, so the
 * rule lives in `contexts/platform/facade/salon-assignments.ts` exactly once.
 *
 * The function is imported through the public index (`../index`), the only way another context may
 * reach it. No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { currentAndFutureAssignmentSalonIds } from "../index";
import { DEFAULT_SALON_OPENING_HOURS } from "../facade/salons";

type Seed = Awaited<ReturnType<typeof seedTestData>>;

const NOW = new Date("2026-06-15T10:00:00.000Z");

describe("currentAndFutureAssignmentSalonIds (Phase 87b, Issue #87, D-10)", () => {
  let app: FastifyInstance;
  let tA: Seed;
  let salonA: { id: string };
  let salonB: { id: string };

  function createSalon(tenantId: string, name: string, isActive = true) {
    return app.prisma.salon.create({
      data: {
        tenantId,
        name,
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive,
        federalState: "NIEDERSACHSEN",
        ...(isActive ? {} : { deactivatedAt: new Date() }),
      },
    });
  }

  function row(
    tenantId: string,
    employeeId: string,
    salonId: string,
    kind: "HOME" | "DEPLOYMENT",
    validFrom: string,
    validUntil: string | null,
    weekdays: number[] = [],
  ) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId,
        salonId,
        kind,
        validFrom: new Date(`${validFrom}T00:00:00Z`),
        validUntil: validUntil === null ? null : new Date(`${validUntil}T00:00:00Z`),
        weekdays,
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    tA = await seedTestData(app, "asi87a");
    salonA = await createSalon(tA.tenant.id, "ASI A");
    salonB = await createSalon(tA.tenant.id, "ASI B");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tA.tenant.id);
    } catch (err) {
      console.error("assignment-salon-ids-87 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("HOME A open + DEPLOYMENT B running answers [A, B] sorted ascending", async () => {
    await row(tA.tenant.id, tA.employee.id, salonA.id, "HOME", "2024-01-01", null);
    await row(
      tA.tenant.id,
      tA.employee.id,
      salonB.id,
      "DEPLOYMENT",
      "2026-01-01",
      "2026-12-31",
      [2],
    );
    const ids = await currentAndFutureAssignmentSalonIds(
      app.prisma,
      tA.tenant.id,
      tA.employee.id,
      NOW,
    );
    expect(ids).toEqual([salonA.id, salonB.id].sort());
  });
});
