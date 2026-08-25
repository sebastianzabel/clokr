/**
 * D-03 proving test — Phase 76.24
 *
 * Proves that once AZ-model-switch history exists (two validFrom-bounded WorkSchedule
 * rows spanning a week→shift boundary), the existing resolution code resolves the
 * OLD (FIXED_SCHEDULE) row for months BEFORE the switch and the NEW (SHIFT_BASED) row
 * for months ON/AFTER the switch.
 *
 * Two resolution paths are exercised:
 *
 * Path A: getEffectiveSchedule(app, employeeId, forDate)  [routes/time-entries.ts]
 *   — the live saldo/overtime-calc path.
 *
 * Path B: prisma.workSchedule.findFirst({ where: { employeeId, validFrom: { lte: forDate } },
 *            orderBy: { validFrom: "desc" } })
 *   — the same query inlined as the "getEffectiveSchedule equivalent" in
 *     recalculate-snapshots-after-shift-soll-fix.ts (utils/recompute-snapshot.ts, which
 *     defined this same query as a module-private getEffectiveScheduleForDate helper, was
 *     removed in Phase 99 together with its only caller — see apps/api/scripts/README.md
 *     "Removed scripts").
 *     This path is not exported, so we assert the underlying query directly.
 *     Once history exists, a past-month close for a week→shift switcher consumes
 *     the correct historical model through this same resolution rule.
 *
 * Seed strategy:
 *   seedTestData creates one FIXED_SCHEDULE row at validFrom=2024-01-01 (weeklyHours=40).
 *   We add two rows with later dates that dominate for any 2025+ query:
 *     • FIXED_SCHEDULE (the "week" model) at validFrom=2025-01-01 — weeklyHours=38 (distinct sentinel)
 *     • SHIFT_BASED               at validFrom=2025-06-01 — weeklyHours=40
 *   For 2025-03-15 (before switch) the 2025-01-01 row wins.
 *   For 2025-07-15 (after  switch) the 2025-06-01 row wins.
 *   For 2025-06-01 (boundary, lte is inclusive) the 2025-06-01 row wins.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import { getEffectiveSchedule } from "../time-entries";
import type { FastifyInstance } from "fastify";

describe("Effective schedule resolution across a week→shift switch boundary (D-03)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // IDs of the rows we inject — used for validation in tests and not for direct cleanup
  // (cleanupTestData deletes all workSchedule rows for the tenant's employees).
  let fixedRowId: string;
  let shiftRowId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "es");

    // ── Inject the two-version schedule history ────────────────────────────────
    // Row 1: FIXED_SCHEDULE ("week" model) — pre-switch months.
    // weeklyHours=38 is a deliberate sentinel that distinguishes this row from the
    // seed-default row (weeklyHours=40 at 2024-01-01) and from the SHIFT_BASED row.
    const fixedRow = await app.prisma.workSchedule.create({
      data: {
        employeeId: data.employee.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 38,
        mondayHours: 7.6,
        tuesdayHours: 7.6,
        wednesdayHours: 7.6,
        thursdayHours: 7.6,
        fridayHours: 7.6,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2025-01-01"),
      },
    });
    fixedRowId = fixedRow.id;

    // Row 2: SHIFT_BASED — the AZ-model switch that takes effect on 2025-06-01.
    const shiftRow = await app.prisma.workSchedule.create({
      data: {
        employeeId: data.employee.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2025-06-01"),
      },
    });
    shiftRowId = shiftRow.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("effective-schedule-by-date cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── Path A: getEffectiveSchedule (routes/time-entries.ts) ─────────────────────

  describe("Path A — getEffectiveSchedule (live saldo path)", () => {
    it("before-switch date → resolves the FIXED_SCHEDULE row (OLD model, weeklyHours=38)", async () => {
      // 2025-03-15 is after the seed row (2024-01-01) and before the switch row (2025-06-01).
      // The newest validFrom ≤ 2025-03-15 is the FIXED_SCHEDULE row at 2025-01-01.
      const schedule = await getEffectiveSchedule(app, data.employee.id, new Date("2025-03-15"));

      expect(schedule.type).toBe("FIXED_SCHEDULE");
      expect((schedule as { id?: string }).id).toBe(fixedRowId);
      // Confirm sentinel weekly hours to prove it is NOT the seed row (40h) or the shift row
      expect(Number(schedule.weeklyHours)).toBe(38);
    });

    it("after-switch date → resolves the SHIFT_BASED row (NEW model)", async () => {
      // 2025-07-15 is after the switch row (2025-06-01) — SHIFT_BASED wins.
      const schedule = await getEffectiveSchedule(app, data.employee.id, new Date("2025-07-15"));

      expect(schedule.type).toBe("SHIFT_BASED");
      expect((schedule as { id?: string }).id).toBe(shiftRowId);
      expect(Number(schedule.weeklyHours)).toBe(40);
    });

    it("boundary date (validFrom itself) → SHIFT_BASED is inclusive (lte)", async () => {
      // 2025-06-01 is exactly the SHIFT_BASED validFrom — lte means it matches.
      const schedule = await getEffectiveSchedule(app, data.employee.id, new Date("2025-06-01"));

      expect(schedule.type).toBe("SHIFT_BASED");
      expect((schedule as { id?: string }).id).toBe(shiftRowId);
    });

    it("date between seed row and FIXED history row → resolves the seed row (oldest pre-switch row)", async () => {
      // 2024-06-15 is before both injected rows; only the seed 2024-01-01 row qualifies.
      const schedule = await getEffectiveSchedule(app, data.employee.id, new Date("2024-06-15"));

      expect(schedule.type).toBe("FIXED_SCHEDULE");
      // This is the seed-default row (weeklyHours=40, NOT the sentinel 38h row)
      expect(Number(schedule.weeklyHours)).toBe(40);
      // Should NOT be the injected FIXED row (that starts 2025-01-01)
      expect((schedule as { id?: string }).id).not.toBe(fixedRowId);
    });
  });

  // ── Path B: raw validFrom<=forDate query (mirrors the getEffectiveSchedule-equivalent
  //    inline query in recalculate-snapshots-after-shift-soll-fix.ts) ─
  //
  // That script inlines this exact query (not exported, so we assert it directly here).
  // By asserting this query we prove that a past-month close (which resolves the
  // effective schedule via the midMonth date of the period) resolves the same
  // historically-correct model once history rows exist.
  // (utils/recompute-snapshot.ts defined the same query as a module-private
  // getEffectiveScheduleForDate helper but was removed in Phase 99 together with its
  // only caller, recalculate-snapshots-after-soll-fix.ts — see
  // apps/api/scripts/README.md "Removed scripts".)

  describe("Path B — raw findFirst (mirrors getEffectiveScheduleForDate / past-month close)", () => {
    it("before-switch date → resolves the FIXED_SCHEDULE row (OLD model)", async () => {
      // Mirrors: getEffectiveScheduleForDate(prisma, employeeId, new Date("2025-03-15"))
      const schedule = await app.prisma.workSchedule.findFirst({
        where: { employeeId: data.employee.id, validFrom: { lte: new Date("2025-03-15") } },
        orderBy: { validFrom: "desc" },
      });

      expect(schedule).not.toBeNull();
      expect(schedule!.type).toBe("FIXED_SCHEDULE");
      expect(schedule!.id).toBe(fixedRowId);
      expect(Number(schedule!.weeklyHours)).toBe(38);
    });

    it("after-switch date → resolves the SHIFT_BASED row (NEW model)", async () => {
      // Mirrors: getEffectiveScheduleForDate(prisma, employeeId, new Date("2025-07-15"))
      const schedule = await app.prisma.workSchedule.findFirst({
        where: { employeeId: data.employee.id, validFrom: { lte: new Date("2025-07-15") } },
        orderBy: { validFrom: "desc" },
      });

      expect(schedule).not.toBeNull();
      expect(schedule!.type).toBe("SHIFT_BASED");
      expect(schedule!.id).toBe(shiftRowId);
    });

    it("boundary date (validFrom itself) → SHIFT_BASED is inclusive (lte)", async () => {
      // Mirrors: getEffectiveScheduleForDate(prisma, employeeId, new Date("2025-06-01"))
      const schedule = await app.prisma.workSchedule.findFirst({
        where: { employeeId: data.employee.id, validFrom: { lte: new Date("2025-06-01") } },
        orderBy: { validFrom: "desc" },
      });

      expect(schedule).not.toBeNull();
      expect(schedule!.type).toBe("SHIFT_BASED");
      expect(schedule!.id).toBe(shiftRowId);
    });

    it("past-month close for Feb 2025 (mid-month = 2025-02-14) → FIXED_SCHEDULE (OLD model)", async () => {
      // This is the concrete scenario D-03 targets: a Monatsabschluss for a period
      // before the switch. The close passes midMonth (e.g. 2025-02-14) to
      // getEffectiveScheduleForDate. With the FIXED row at 2025-01-01 in place, the
      // resolution correctly returns the OLD model, NOT the SHIFT_BASED post-switch row.
      const midMonth = new Date("2025-02-14");
      const schedule = await app.prisma.workSchedule.findFirst({
        where: { employeeId: data.employee.id, validFrom: { lte: midMonth } },
        orderBy: { validFrom: "desc" },
      });

      expect(schedule).not.toBeNull();
      expect(schedule!.type).toBe("FIXED_SCHEDULE");
      expect(Number(schedule!.weeklyHours)).toBe(38); // sentinel — confirms the 2025-01-01 row, not the seed
    });

    it("past-month close for Aug 2025 (mid-month = 2025-08-14) → SHIFT_BASED (NEW model)", async () => {
      // Monatsabschluss for a period after the switch. The close passes midMonth
      // (2025-08-14) and correctly resolves the SHIFT_BASED row.
      const midMonth = new Date("2025-08-14");
      const schedule = await app.prisma.workSchedule.findFirst({
        where: { employeeId: data.employee.id, validFrom: { lte: midMonth } },
        orderBy: { validFrom: "desc" },
      });

      expect(schedule).not.toBeNull();
      expect(schedule!.type).toBe("SHIFT_BASED");
      expect(schedule!.id).toBe(shiftRowId);
    });
  });
});
