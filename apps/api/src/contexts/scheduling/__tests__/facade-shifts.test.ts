/**
 * Phase 100B Plan 05 (Wave 2) — focused integration test for the Schichtplanung facade's S1/S2
 * (`getShiftsInRange`, `flagShiftsConflictingWithLeave`). Uses the existing shift fixture pattern
 * (`prisma.shift.create` directly, matching `shifts-my-week.test.ts`) — no new fixture builder.
 *
 * S3 (`cancelOrphanShifts`) and S4 (`getEmployeeAvailability`) are exercised indirectly through
 * the existing route-level suites once plan 05 Task 2 rewires `settings.ts`/`me.ts` to call them —
 * both are thin single-purpose wrappers over one Prisma call each, and the plan's own `<action>`
 * text asks only for "a focused integration test for S1 ... plus one for S2".
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import { getShiftsInRange, flagShiftsConflictingWithLeave } from "../index";
import type { FastifyInstance } from "fastify";

describe("Schichtplanung facade — getShiftsInRange / flagShiftsConflictingWithLeave (Phase 100B Plan 05)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let otherTenantData: Awaited<ReturnType<typeof seedTestData>>;
  let templateId: string;

  // Fixed future Monday/Tuesday/Wednesday window, far enough out not to collide with other
  // describe blocks' fixtures in the shared test database (mirrors shifts-my-week.test.ts).
  const MONDAY_ISO = "2026-11-02";
  const TUESDAY_ISO = "2026-11-03";
  const WEDNESDAY_ISO = "2026-11-04";
  const OUTSIDE_ISO = "2026-11-20"; // outside the [Monday, Tuesday] window used below

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "sched-facade");
    otherTenantData = await seedTestData(app, "sched-facade-other");

    const prisma = app.prisma;
    const template = await prisma.shiftTemplate.create({
      data: {
        tenantId: data.tenant.id,
        name: "Früh",
        startTime: "08:00",
        endTime: "12:00",
        color: "#00FF00",
      },
    });
    templateId = template.id;

    // employee: two shifts on Monday (same day, different startTime — the ordering tie-break),
    // one on Tuesday, one outside the window, one soft-deleted inside the window.
    await prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        templateId,
        date: new Date(MONDAY_ISO + "T00:00:00Z"),
        startTime: "14:00",
        endTime: "18:00",
        label: "Spät",
      },
    });
    await prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        date: new Date(MONDAY_ISO + "T00:00:00Z"),
        startTime: "08:00",
        endTime: "12:00",
        label: "Früh",
      },
    });
    await prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        date: new Date(TUESDAY_ISO + "T00:00:00Z"),
        startTime: "08:00",
        endTime: "12:00",
      },
    });
    await prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        date: new Date(OUTSIDE_ISO + "T00:00:00Z"),
        startTime: "08:00",
        endTime: "12:00",
      },
    });
    await prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        date: new Date(WEDNESDAY_ISO + "T00:00:00Z"),
        startTime: "08:00",
        endTime: "12:00",
        deletedAt: new Date(),
        deletedReason: "TEST_SOFT_DELETE",
      },
    });

    // adminEmployee: one shift on Tuesday, same tenant.
    await prisma.shift.create({
      data: {
        employeeId: data.adminEmployee.id,
        date: new Date(TUESDAY_ISO + "T00:00:00Z"),
        startTime: "09:00",
        endTime: "13:00",
      },
    });

    // a different tenant's employee, same dates — must never leak into a "tenant" scope query
    // for data.tenant.
    await prisma.shift.create({
      data: {
        employeeId: otherTenantData.employee.id,
        date: new Date(MONDAY_ISO + "T00:00:00Z"),
        startTime: "08:00",
        endTime: "12:00",
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, otherTenantData.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("getShiftsInRange", () => {
    it("kind: 'employee' — returns only that employee's active shifts in range, ordered by date then startTime", async () => {
      const rows = await getShiftsInRange(
        app.prisma,
        { kind: "employee", employeeId: data.employee.id, tenantId: data.tenant.id },
        new Date(MONDAY_ISO + "T00:00:00Z"),
        new Date(TUESDAY_ISO + "T00:00:00Z"),
      );

      // 3 active rows in [Monday, Tuesday]: two Monday (ordering pair) + one Tuesday.
      // The Wednesday soft-deleted row and the Monday-far-future OUTSIDE_ISO row are excluded.
      expect(rows).toHaveLength(3);
      expect(
        rows.map((r) => ({ date: r.date.toISOString().slice(0, 10), startTime: r.startTime })),
      ).toEqual([
        { date: MONDAY_ISO, startTime: "08:00" },
        { date: MONDAY_ISO, startTime: "14:00" },
        { date: TUESDAY_ISO, startTime: "08:00" },
      ]);
      // The union select's template relation is populated for the templated row (14:00, whose
      // `label` "Spät" is a per-shift override distinct from `template.name` "Früh") and null for
      // the untemplated one (08:00, `label` "Früh" here is just the shift's own field).
      expect(rows[0].template).toBeNull();
      expect(rows[1].template).toEqual({ name: "Früh", color: "#00FF00" });
    });

    it("kind: 'employee' with to=null — open-ended range returns everything from `from` onward (settings.ts:854's shape)", async () => {
      const rows = await getShiftsInRange(
        app.prisma,
        { kind: "employee", employeeId: data.employee.id, tenantId: data.tenant.id },
        new Date(MONDAY_ISO + "T00:00:00Z"),
      );
      // Monday x2, Tuesday, OUTSIDE_ISO — the soft-deleted Wednesday row stays excluded.
      expect(rows).toHaveLength(4);
      expect(rows.at(-1)?.date.toISOString().slice(0, 10)).toBe(OUTSIDE_ISO);
    });

    it("kind: 'employees' — bulk scope returns both employees' shifts, still tenant-correct", async () => {
      const rows = await getShiftsInRange(
        app.prisma,
        {
          kind: "employees",
          employeeIds: [data.employee.id, data.adminEmployee.id],
          tenantId: data.tenant.id,
        },
        new Date(MONDAY_ISO + "T00:00:00Z"),
        new Date(TUESDAY_ISO + "T00:00:00Z"),
      );
      const employeeIds = new Set(rows.map((r) => r.employeeId));
      expect(employeeIds).toEqual(new Set([data.employee.id, data.adminEmployee.id]));
      expect(rows).toHaveLength(4); // employee's 3 (Mon x2 + Tue) + adminEmployee's 1 (Tue)
    });

    it("kind: 'tenant' — tenant-wide scope returns every employee's shifts in this tenant, never the other tenant's", async () => {
      const rows = await getShiftsInRange(
        app.prisma,
        { kind: "tenant", tenantId: data.tenant.id },
        new Date(MONDAY_ISO + "T00:00:00Z"),
        new Date(TUESDAY_ISO + "T00:00:00Z"),
      );
      const employeeIds = new Set(rows.map((r) => r.employeeId));
      expect(employeeIds).toEqual(new Set([data.employee.id, data.adminEmployee.id]));
      expect(employeeIds.has(otherTenantData.employee.id)).toBe(false);
      expect(rows).toHaveLength(4);
    });
  });

  describe("flagShiftsConflictingWithLeave", () => {
    it("flags active, not-yet-flagged shifts in range and returns exactly the flagged rows", async () => {
      const shift1 = await app.prisma.shift.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2026-12-01T00:00:00Z"),
          startTime: "08:00",
          endTime: "12:00",
          label: "Conflict-A",
        },
      });
      const shift2 = await app.prisma.shift.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2026-12-02T00:00:00Z"),
          startTime: "08:00",
          endTime: "12:00",
          label: "Conflict-B",
        },
      });
      // Already flagged — must NOT be re-selected/re-flagged (matches leave.ts:1424's
      // `conflictsWithLeave: false` predicate).
      const alreadyFlagged = await app.prisma.shift.create({
        data: {
          employeeId: data.employee.id,
          date: new Date("2026-12-02T00:00:00Z"),
          startTime: "14:00",
          endTime: "18:00",
          conflictsWithLeave: true,
        },
      });

      const flagged = await flagShiftsConflictingWithLeave(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        new Date("2026-12-01T00:00:00Z"),
        new Date("2026-12-02T00:00:00Z"),
      );

      expect(flagged.map((s) => s.id).sort()).toEqual([shift1.id, shift2.id].sort());

      const [reloaded1, reloaded2, reloadedAlready] = await Promise.all([
        app.prisma.shift.findUniqueOrThrow({ where: { id: shift1.id } }),
        app.prisma.shift.findUniqueOrThrow({ where: { id: shift2.id } }),
        app.prisma.shift.findUniqueOrThrow({ where: { id: alreadyFlagged.id } }),
      ]);
      expect(reloaded1.conflictsWithLeave).toBe(true);
      expect(reloaded2.conflictsWithLeave).toBe(true);
      expect(reloadedAlready.conflictsWithLeave).toBe(true); // untouched, was already true

      // A same-window shift belonging to a DIFFERENT tenant is never touched, even though the
      // date range overlaps — the added `employee: { tenantId }` clause (see facade/shifts.ts's
      // own docblock) must actually constrain, not merely be declared.
      const otherTenantShift = await app.prisma.shift.create({
        data: {
          employeeId: otherTenantData.employee.id,
          date: new Date("2026-12-01T00:00:00Z"),
          startTime: "08:00",
          endTime: "12:00",
        },
      });
      const flaggedAgain = await flagShiftsConflictingWithLeave(
        app.prisma,
        otherTenantData.employee.id,
        data.tenant.id, // WRONG tenant on purpose
        new Date("2026-12-01T00:00:00Z"),
        new Date("2026-12-01T00:00:00Z"),
      );
      expect(flaggedAgain).toHaveLength(0);
      const reloadedOther = await app.prisma.shift.findUniqueOrThrow({
        where: { id: otherTenantShift.id },
      });
      expect(reloadedOther.conflictsWithLeave).toBe(false);
    });
  });
});
