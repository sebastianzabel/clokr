// Phase 63 Plan 02 — Berufsschule Saldo helper tests.
//
// Covers BERSCH-03 (single-day → 480 Worked + 480 Soll) and BERSCH-04
// (block-week ≥5 days → 2400 total capped at the tenant's weekly setting).
//
// The helper is the building block for the 4 overtime.ts loops + auto-close-month.ts
// snapshot path (Plan 03 wires the integration). Here we test the helper in isolation:
// given an employee + tenant config + a date, what BS minutes does the day contribute?

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import {
  countBsDaysInIsoWeek,
  getVocationalSchoolMinutesForDate,
} from "../utils/vocational-school-saldo";

// ── Test helpers ─────────────────────────────────────────────────────────────

// UTC midnight for a YYYY-MM-DD date string.
function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

// Build an Absence row for a given employee + date + type (default VOCATIONAL_SCHOOL).
async function seedAbsence(
  app: FastifyInstance,
  employeeId: string,
  date: Date,
  opts: { type?: "VOCATIONAL_SCHOOL" | "SICK"; deleted?: boolean } = {},
) {
  return app.prisma.absence.create({
    data: {
      employeeId,
      type: opts.type ?? "VOCATIONAL_SCHOOL",
      source: "PATTERN",
      startDate: date,
      endDate: date,
      days: 1.0,
      createdBy: "saldo-test",
      deletedAt: opts.deleted ? new Date() : null,
    },
  });
}

describe("getVocationalSchoolMinutesForDate + countBsDaysInIsoWeek (Phase 63 Plan 02)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // Anchor dates inside a single ISO week (Mon 2026-06-15 ... Sun 2026-06-21).
  // This week is safely in the future so it never collides with other tests' "now" math.
  const MON = utcDate("2026-06-15");
  const TUE = utcDate("2026-06-16");
  const WED = utcDate("2026-06-17");
  const THU = utcDate("2026-06-18");
  const FRI = utcDate("2026-06-19");
  const SAT = utcDate("2026-06-20");
  const SUN = utcDate("2026-06-21");
  // Next ISO week (Mon 2026-06-22) — used to verify isolation across weeks.
  const NEXT_MON = utcDate("2026-06-22");

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "vs-saldo");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // Each test starts with a clean Absence slate for the employee.
  beforeEach(async () => {
    await app.prisma.absence.deleteMany({
      where: { employeeId: data.employee.id },
    });
  });

  // ── countBsDaysInIsoWeek ───────────────────────────────────────────────────

  describe("countBsDaysInIsoWeek", () => {
    it("returns 0 when no BS rows exist for the employee", async () => {
      const count = await countBsDaysInIsoWeek(app.prisma, data.employee.id, MON);
      expect(count).toBe(0);
    });

    it("returns 3 when 3 distinct BS dates exist in the same ISO week", async () => {
      await seedAbsence(app, data.employee.id, MON);
      await seedAbsence(app, data.employee.id, WED);
      await seedAbsence(app, data.employee.id, FRI);
      const count = await countBsDaysInIsoWeek(app.prisma, data.employee.id, MON);
      expect(count).toBe(3);
    });

    it("excludes soft-deleted Absences", async () => {
      await seedAbsence(app, data.employee.id, MON);
      await seedAbsence(app, data.employee.id, TUE, { deleted: true });
      await seedAbsence(app, data.employee.id, WED);
      const count = await countBsDaysInIsoWeek(app.prisma, data.employee.id, MON);
      expect(count).toBe(2);
    });

    it("excludes BS rows from a different ISO week even if dates are adjacent", async () => {
      await seedAbsence(app, data.employee.id, SUN); // ISO week N
      await seedAbsence(app, data.employee.id, NEXT_MON); // ISO week N+1
      const count = await countBsDaysInIsoWeek(app.prisma, data.employee.id, SUN);
      expect(count).toBe(1);
    });

    it("excludes non-VOCATIONAL_SCHOOL absences (e.g. SICK)", async () => {
      await seedAbsence(app, data.employee.id, MON, { type: "SICK" });
      await seedAbsence(app, data.employee.id, WED);
      const count = await countBsDaysInIsoWeek(app.prisma, data.employee.id, MON);
      expect(count).toBe(1);
    });
  });

  // ── getVocationalSchoolMinutesForDate ──────────────────────────────────────

  describe("getVocationalSchoolMinutesForDate", () => {
    // The default tenant config from the seeder has neither field set (those are
    // populated by the Phase 63-01 schema default). Pass `null` here to fall through
    // to the hard-coded defaults in the helper.
    const defaultConfig = null;

    it("returns 0 when no Absence exists for that date", async () => {
      const min = await getVocationalSchoolMinutesForDate(
        app.prisma,
        data.employee.id,
        MON,
        defaultConfig,
      );
      expect(min).toBe(0);
    });

    it("returns 0 when an Absence exists but type !== VOCATIONAL_SCHOOL", async () => {
      await seedAbsence(app, data.employee.id, MON, { type: "SICK" });
      const min = await getVocationalSchoolMinutesForDate(
        app.prisma,
        data.employee.id,
        MON,
        defaultConfig,
      );
      expect(min).toBe(0);
    });

    it("returns 0 when an Absence exists but is soft-deleted", async () => {
      await seedAbsence(app, data.employee.id, MON, { deleted: true });
      const min = await getVocationalSchoolMinutesForDate(
        app.prisma,
        data.employee.id,
        MON,
        defaultConfig,
      );
      expect(min).toBe(0);
    });

    it("BERSCH-03 — single BS-day in ISO week returns daily default 480", async () => {
      await seedAbsence(app, data.employee.id, WED);
      const min = await getVocationalSchoolMinutesForDate(
        app.prisma,
        data.employee.id,
        WED,
        defaultConfig,
      );
      expect(min).toBe(480);
    });

    it("BERSCH-03 — single BS-day with tenantConfig daily=360 returns 360", async () => {
      await seedAbsence(app, data.employee.id, WED);
      const min = await getVocationalSchoolMinutesForDate(app.prisma, data.employee.id, WED, {
        vocationalSchoolMinutesPerDay: 360,
        vocationalSchoolBlockMinutesPerWeek: 1800,
      });
      expect(min).toBe(360);
    });

    it("BERSCH-04 — 5 BS-days in ISO week returns weekly/5 = 480 (defaults)", async () => {
      // Mon-Fri block, default config (2400 / 5 = 480 — coincidentally matches single-day default).
      await seedAbsence(app, data.employee.id, MON);
      await seedAbsence(app, data.employee.id, TUE);
      await seedAbsence(app, data.employee.id, WED);
      await seedAbsence(app, data.employee.id, THU);
      await seedAbsence(app, data.employee.id, FRI);
      const min = await getVocationalSchoolMinutesForDate(
        app.prisma,
        data.employee.id,
        WED,
        defaultConfig,
      );
      expect(min).toBe(480);
    });

    it("BERSCH-04 — 7 BS-days in ISO week with default config returns 343 (CAP enforced)", async () => {
      // Full Mo-Su block — 2400 / 7 = 342.857... → rounded to 343.
      await seedAbsence(app, data.employee.id, MON);
      await seedAbsence(app, data.employee.id, TUE);
      await seedAbsence(app, data.employee.id, WED);
      await seedAbsence(app, data.employee.id, THU);
      await seedAbsence(app, data.employee.id, FRI);
      await seedAbsence(app, data.employee.id, SAT);
      await seedAbsence(app, data.employee.id, SUN);
      const min = await getVocationalSchoolMinutesForDate(
        app.prisma,
        data.employee.id,
        WED,
        defaultConfig,
      );
      // CRITICAL: must NOT be 480 — that would mean the cap didn't kick in.
      expect(min).not.toBe(480);
      expect(min).toBe(343);
    });

    it("BERSCH-04 — 7 BS-days with daily=360 weekly=1800 returns 257", async () => {
      // 1800 / 7 = 257.14... → rounded to 257.
      await seedAbsence(app, data.employee.id, MON);
      await seedAbsence(app, data.employee.id, TUE);
      await seedAbsence(app, data.employee.id, WED);
      await seedAbsence(app, data.employee.id, THU);
      await seedAbsence(app, data.employee.id, FRI);
      await seedAbsence(app, data.employee.id, SAT);
      await seedAbsence(app, data.employee.id, SUN);
      const min = await getVocationalSchoolMinutesForDate(app.prisma, data.employee.id, MON, {
        vocationalSchoolMinutesPerDay: 360,
        vocationalSchoolBlockMinutesPerWeek: 1800,
      });
      expect(min).toBe(257);
    });

    it("4 BS-days (< 5 threshold) in ISO week stays on daily path → 480 (FIRST_LONG_DAY)", async () => {
      // Mo-Th, only 4 days — block-week cap does NOT kick in.
      // Phase 76.31 (B): query MON (ordinal 1 = FIRST_LONG_DAY) to assert the daily path.
      // With no schedule passed, the daily-Soll fallback = BS_DAILY_DEFAULT_MIN (480); the
      // legacy per-day pauschal is preserved for the FIRST_LONG_DAY slot. (Block-week would
      // credit 2400/4 = 600 ≠ 480, so 480 proves block mode did NOT engage.)
      await seedAbsence(app, data.employee.id, MON);
      await seedAbsence(app, data.employee.id, TUE);
      await seedAbsence(app, data.employee.id, WED);
      await seedAbsence(app, data.employee.id, THU);
      const min = await getVocationalSchoolMinutesForDate(
        app.prisma,
        data.employee.id,
        MON,
        defaultConfig,
      );
      expect(min).toBe(480);
    });

    it("absence in different ISO week does NOT push current week into block mode", async () => {
      // 4 absences in week N (single-day path) + 1 in week N+1 → query FIRST_LONG_DAY of week N → 480.
      // Phase 76.31 (B): query MON (ordinal 1 = FIRST_LONG_DAY). Block-week would give 2400/4 = 600.
      await seedAbsence(app, data.employee.id, MON);
      await seedAbsence(app, data.employee.id, TUE);
      await seedAbsence(app, data.employee.id, WED);
      await seedAbsence(app, data.employee.id, THU);
      await seedAbsence(app, data.employee.id, NEXT_MON); // week N+1
      const min = await getVocationalSchoolMinutesForDate(
        app.prisma,
        data.employee.id,
        MON,
        defaultConfig,
      );
      // Week N has 4 BS days → single-day path, not block path → FIRST_LONG_DAY default.
      expect(min).toBe(480);
    });

    it("soft-deleted absence does NOT contribute to its day", async () => {
      await seedAbsence(app, data.employee.id, MON, { deleted: true });
      const min = await getVocationalSchoolMinutesForDate(
        app.prisma,
        data.employee.id,
        MON,
        defaultConfig,
      );
      expect(min).toBe(0);
    });

    it("MONTHLY_HOURS scenario: helper returns the same number regardless of schedule type", async () => {
      // Switch the employee's WorkSchedule to MONTHLY_HOURS to document D-04 boundary:
      // the helper is schedule-agnostic — it ONLY returns the minute count for the date.
      // Plan 03 will be responsible for deciding whether to add this to expectedMinutes too.
      await app.prisma.workSchedule.updateMany({
        where: { employeeId: data.employee.id },
        data: { type: "MONTHLY_HOURS", monthlyHours: 60 },
      });
      await seedAbsence(app, data.employee.id, WED);
      const min = await getVocationalSchoolMinutesForDate(
        app.prisma,
        data.employee.id,
        WED,
        defaultConfig,
      );
      expect(min).toBe(480);
      // Restore for any subsequent test (not strictly needed since beforeEach wipes absences,
      // but schedules persist across tests — restore the FIXED_SCHEDULE default).
      await app.prisma.workSchedule.updateMany({
        where: { employeeId: data.employee.id },
        data: { type: "FIXED_SCHEDULE", monthlyHours: null },
      });
    });
  });
});
