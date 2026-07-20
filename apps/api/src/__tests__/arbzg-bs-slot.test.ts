// Phase 76.31-05 — ArbZG §3 slot-aware BS-minute sourcing (D-08 FULL scope).
//
// Proves the §3 daily (10h) and weekly (48h) compliance checks in checkArbZG use
// the slot-resolved BS amount (getVocationalSchoolMinutesForDate), NOT a flat 480:
//   - A SHIFT_BASED 38h/4-day Azubi with a LONG BS day is credited 570 min (9.5h).
//     A daily total that stays UNDER the 10h cap at 480 but crosses it at 570 fires
//     MAX_DAILY_EXCEEDED — proving the amount changed the check (RESEARCH R5).
//   - A 5-day block week sums to the tenant's blockWeekMinutes (not 5 × 480), and
//     that slot-resolved sum flows into the §3 48h weekly cap.
//
// These are the ArbZG-parity counterparts to the saldo-side slot rewire (76.31-04).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { checkArbZG } from "../utils/arbzg";

function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

async function seedBsAbsence(app: FastifyInstance, employeeId: string, date: Date) {
  return app.prisma.absence.create({
    data: {
      employeeId,
      type: "VOCATIONAL_SCHOOL",
      source: "PATTERN",
      startDate: date,
      endDate: date,
      days: 1.0,
      createdBy: "arbzg-bs-slot-test",
      deletedAt: null,
    },
  });
}

async function seedTimeEntry(
  app: FastifyInstance,
  employeeId: string,
  date: Date,
  startTime: Date,
  endTime: Date,
) {
  return app.prisma.timeEntry.create({
    data: {
      employeeId,
      date,
      startTime,
      endTime,
      breakMinutes: 0,
      source: "MANUAL",
      type: "WORK",
    },
  });
}

describe("checkArbZG slot-aware BS minutes (Phase 76.31-05, D-08 FULL)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // Anchor week: 2026-06-15 (Mon) ... 2026-06-21 (Sun) — fully in the future.
  const MON = utcDate("2026-06-15");
  const TUE = utcDate("2026-06-16");
  const WED = utcDate("2026-06-17");
  const THU = utcDate("2026-06-18");
  const FRI = utcDate("2026-06-19");

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "arbzg-bs-slot");

    // Reshape the seeded employee to a SHIFT_BASED 38h/4-day Azubi:
    //   workDaysPerWeek = 4 (Mo-Do markers > 0) → dailySoll = round(38*60/4) = 570.
    // The slot resolver's FIRST_LONG_DAY layer is fed the explicit tenant slot
    // config below (570), which is what the ArbZG check must now count.
    await app.prisma.workSchedule.updateMany({
      where: { employeeId: data.employee.id },
      data: {
        type: "SHIFT_BASED",
        weeklyHours: 38,
        mondayHours: 9.5,
        tuesdayHours: 9.5,
        wednesdayHours: 9.5,
        thursdayHours: 9.5,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
      },
    });

    // BVaDiG-2024 slot config: a LONG BS day credits 570 min (9.5h), a block week
    // credits 2850 min total (5 × 570). These are the amounts the resolver returns.
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: {
        bsSlotFirstLongDayMinutes: 570,
        bsSlotBlockWeekMinutes: 2850,
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    await app.prisma.absence.deleteMany({ where: { employeeId: data.employee.id } });
    await app.prisma.timeEntry.deleteMany({ where: { employeeId: data.employee.id } });
  });

  // ── § 3 daily 10h cap uses the slot-resolved (570) amount ───────────────────

  describe("§ 3 MAX_DAILY_EXCEEDED counts the slot-resolved LONG-day amount", () => {
    it("fires: 40 min work + 570 min BS = 610 > 600 (would NOT fire at flat 480 = 520)", async () => {
      // LONG BS day (single day → ordinal 1 → FIRST_LONG_DAY → 570 min).
      await seedBsAbsence(app, data.employee.id, MON);
      // 40 min of regular work on the same day (08:00-08:40 Berlin = 06:00-06:40 UTC).
      await seedTimeEntry(
        app,
        data.employee.id,
        MON,
        new Date("2026-06-15T06:00:00.000Z"),
        new Date("2026-06-15T06:40:00.000Z"),
      );

      const warnings = await checkArbZG(app.prisma, data.employee.id, MON);
      const w = warnings.find((x) => x.code === "MAX_DAILY_EXCEEDED");
      // 570 (BS) + 40 (work) = 610 min = 10.2h > 10h → fires.
      // At the OLD flat 480: 480 + 40 = 520 min = 8.7h < 10h → would NOT have fired.
      expect(w).toBeDefined();
      expect(w!.severity).toBe("error");
      expect(w!.message).toMatch(/10\.2 h/);
    });

    it("does NOT fire: 40 min work would stay under 10h if BS were only 480 (guards the 570 delta)", async () => {
      // Same 40 min work but NO BS day → 40 min total, far under the cap. Confirms
      // the fire in the prior test is driven by the 570-min BS credit, not the work.
      await seedTimeEntry(
        app,
        data.employee.id,
        MON,
        new Date("2026-06-15T06:00:00.000Z"),
        new Date("2026-06-15T06:40:00.000Z"),
      );
      const warnings = await checkArbZG(app.prisma, data.employee.id, MON);
      expect(warnings.find((x) => x.code === "MAX_DAILY_EXCEEDED")).toBeUndefined();
    });
  });

  // ── § 3 weekly 48h cap sums the slot-resolved BS minutes ────────────────────

  describe("§ 3 MAX_WEEKLY_EXCEEDED sums slot-resolved BS minutes", () => {
    it("block week sums to blockWeekMinutes (2850), not 5 × 480 — pushes week over 48h with Sat work", async () => {
      // 5 BS days Mon-Fri → block week (N=5) → each day credits round(2850/5)=570,
      // summing to 2850 min = 47.5h.
      for (const d of [MON, TUE, WED, THU, FRI]) {
        await seedBsAbsence(app, data.employee.id, d);
      }
      // 1h Sat work (07:00-08:00 Berlin = 05:00-06:00 UTC) → 47.5h + 1h = 48.5h > 48h.
      // At flat 5 × 480 = 40h: 40h + 1h = 41h → would NOT fire.
      await seedTimeEntry(
        app,
        data.employee.id,
        utcDate("2026-06-20"),
        new Date("2026-06-20T05:00:00.000Z"),
        new Date("2026-06-20T06:00:00.000Z"),
      );

      const warnings = await checkArbZG(app.prisma, data.employee.id, utcDate("2026-06-20"));
      const w = warnings.find((x) => x.code === "MAX_WEEKLY_EXCEEDED");
      expect(w).toBeDefined();
      expect(w!.severity).toBe("error");
      // 47.5h (BS block) + 1h (Sat) = 48.5h.
      expect(w!.message).toMatch(/48\.5 h/);
    });

    it("does NOT fire with only the 5-day block (47.5h, no regular work)", async () => {
      for (const d of [MON, TUE, WED, THU, FRI]) {
        await seedBsAbsence(app, data.employee.id, d);
      }
      const warnings = await checkArbZG(app.prisma, data.employee.id, MON);
      expect(warnings.find((x) => x.code === "MAX_WEEKLY_EXCEEDED")).toBeUndefined();
    });
  });
});
