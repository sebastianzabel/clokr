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
 *
 * Mutation, recorded here, not re-run by CI (Phase 87b, 2026-10-12):
 * - M1: drop the `isVoided` filter from `currentAndFutureAssignmentSalonIds` -> red:
 *   "a voided row (validUntil before validFrom) contributes nothing".
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { currentAndFutureAssignmentSalonIds } from "../index";
import { DEFAULT_SALON_OPENING_HOURS } from "../facade/salons";

type Seed = Awaited<ReturnType<typeof seedTestData>>;

const NOW = new Date("2026-06-15T10:00:00.000Z");
// 2026-07-01 00:30 in Europe/Berlin, still 2026-06-30 in UTC.
const TZ_EDGE = new Date("2026-06-30T22:30:00.000Z");

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function uniqueSuffix(label: string): string {
  return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

describe("currentAndFutureAssignmentSalonIds (Phase 87b, Issue #87, D-10)", () => {
  let app: FastifyInstance;
  let tA: Seed;
  let salonA: { id: string };
  let salonB: { id: string };
  let tB: Seed;

  async function createEmployee(tenantId: string, label: string) {
    const suffix = uniqueSuffix(label);
    const user = await app.prisma.user.create({
      data: {
        email: `asi-${suffix}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 4),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    return app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `ASI-${suffix}`.slice(0, 20),
        firstName: label,
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
      },
    });
  }

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
    tB = await seedTestData(app, "asi87b");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tA.tenant.id);
      await cleanupTestData(app, tB.tenant.id);
    } catch (err) {
      console.error("assignment-salon-ids-87 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("HOME A open + DEPLOYMENT B running answers [A, B] sorted ascending", async () => {
    const emp = await createEmployee(tA.tenant.id, "asiTracer");
    await row(tA.tenant.id, emp.id, salonA.id, "HOME", "2024-01-01", null);
    await row(tA.tenant.id, emp.id, salonB.id, "DEPLOYMENT", "2026-01-01", "2026-12-31", [2]);
    const ids = await currentAndFutureAssignmentSalonIds(app.prisma, tA.tenant.id, emp.id, NOW);
    expect(ids).toEqual([salonA.id, salonB.id].sort(byCodeUnit));
  });

  it("a DEPLOYMENT that ended before the day contributes nothing", async () => {
    const emp = await createEmployee(tA.tenant.id, "asiEnded");
    await row(tA.tenant.id, emp.id, salonA.id, "HOME", "2024-01-01", null);
    await row(tA.tenant.id, emp.id, salonB.id, "DEPLOYMENT", "2026-01-01", "2026-05-31", [2]);
    expect(await currentAndFutureAssignmentSalonIds(app.prisma, tA.tenant.id, emp.id, NOW)).toEqual(
      [salonA.id],
    );
  });

  it("a voided row (validUntil before validFrom) contributes nothing", async () => {
    const emp = await createEmployee(tA.tenant.id, "asiVoided");
    await row(tA.tenant.id, emp.id, salonA.id, "HOME", "2024-01-01", null);
    await row(tA.tenant.id, emp.id, salonB.id, "DEPLOYMENT", "2026-07-01", "2026-06-30", [2]);
    expect(await currentAndFutureAssignmentSalonIds(app.prisma, tA.tenant.id, emp.id, NOW)).toEqual(
      [salonA.id],
    );
  });

  it("a FUTURE row contributes", async () => {
    const emp = await createEmployee(tA.tenant.id, "asiFuture");
    await row(tA.tenant.id, emp.id, salonA.id, "HOME", "2024-01-01", null);
    await row(tA.tenant.id, emp.id, salonB.id, "DEPLOYMENT", "2026-09-01", null, [2]);
    expect(await currentAndFutureAssignmentSalonIds(app.prisma, tA.tenant.id, emp.id, NOW)).toEqual(
      [salonA.id, salonB.id].sort(byCodeUnit),
    );
  });

  it("a running row on a deactivated salon still contributes (no activity filter)", async () => {
    const inactive = await createSalon(tA.tenant.id, "ASI inactive", false);
    const emp = await createEmployee(tA.tenant.id, "asiInactive");
    await row(tA.tenant.id, emp.id, salonA.id, "HOME", "2024-01-01", null);
    await row(tA.tenant.id, emp.id, inactive.id, "DEPLOYMENT", "2026-01-01", "2026-12-31", [2]);
    expect(await currentAndFutureAssignmentSalonIds(app.prisma, tA.tenant.id, emp.id, NOW)).toEqual(
      [salonA.id, inactive.id].sort(byCodeUnit),
    );
  });

  it("the tenant-local day decides: validUntil 2026-06-30 is over, 2026-07-01 still counts", async () => {
    const over = await createEmployee(tA.tenant.id, "asiEdgeOver");
    await row(tA.tenant.id, over.id, salonA.id, "DEPLOYMENT", "2026-01-01", "2026-06-30", [2]);
    expect(
      await currentAndFutureAssignmentSalonIds(app.prisma, tA.tenant.id, over.id, TZ_EDGE),
    ).toEqual([]);

    const running = await createEmployee(tA.tenant.id, "asiEdgeRunning");
    await row(tA.tenant.id, running.id, salonA.id, "DEPLOYMENT", "2026-01-01", "2026-07-01", [2]);
    expect(
      await currentAndFutureAssignmentSalonIds(app.prisma, tA.tenant.id, running.id, TZ_EDGE),
    ).toEqual([salonA.id]);
  });

  it("two rows on the same salon answer that salon once", async () => {
    const emp = await createEmployee(tA.tenant.id, "asiDup");
    await row(tA.tenant.id, emp.id, salonA.id, "HOME", "2024-01-01", null);
    await row(tA.tenant.id, emp.id, salonA.id, "DEPLOYMENT", "2026-01-01", "2026-12-31", [2]);
    expect(await currentAndFutureAssignmentSalonIds(app.prisma, tA.tenant.id, emp.id, NOW)).toEqual(
      [salonA.id],
    );
  });

  it("an employee without rows, an unknown id and a foreign tenant's employee answer []", async () => {
    const bare = await createEmployee(tA.tenant.id, "asiBare");
    expect(
      await currentAndFutureAssignmentSalonIds(app.prisma, tA.tenant.id, bare.id, NOW),
    ).toEqual([]);

    const unknownId = "00000000-0000-4000-8000-000000000087";
    expect(
      await currentAndFutureAssignmentSalonIds(app.prisma, tA.tenant.id, unknownId, NOW),
    ).toEqual([]);

    const foreign = await createEmployee(tB.tenant.id, "asiForeign");
    await row(tB.tenant.id, foreign.id, tB.salonId, "HOME", "2024-01-01", null);
    // The foreign employee asked with the main tenant's id: same [] as the unknown id.
    expect(
      await currentAndFutureAssignmentSalonIds(app.prisma, tA.tenant.id, foreign.id, NOW),
    ).toEqual([]);
    // The main tenant's employee asked with the foreign tenant's id: rows of another tenant never appear.
    const own = await createEmployee(tA.tenant.id, "asiOwn");
    await row(tA.tenant.id, own.id, salonA.id, "HOME", "2024-01-01", null);
    expect(await currentAndFutureAssignmentSalonIds(app.prisma, tB.tenant.id, own.id, NOW)).toEqual(
      [],
    );
    // Control: the foreign tenant does see its own employee.
    expect(
      await currentAndFutureAssignmentSalonIds(app.prisma, tB.tenant.id, foreign.id, NOW),
    ).toEqual([tB.salonId]);
  });
});
