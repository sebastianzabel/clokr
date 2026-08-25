// Phase 103 Plan 05 (DISCRETION-MUSTERHISTORIE) — BS-pattern historisation tests.
//
// Task 1: shared deterministic ordering (BS_PATTERN_ORDER_BY) proven across ALL FOUR
// single-winner consumers — not just two agreeing with each other — plus pure
// ambiguity detection (findAmbiguousClaimDates) and the legitimate multi-pattern union
// staying additive. Task 2: the owner-selected historisation option (see
// 103-HISTORISATION-DIAGNOSTIC.md `## Owner Decision` — option A + option B).
//
// Never hardcode an absolute calendar date reasoning about "now" (hireDate, locked
// months, age-at-date): this project has a documented history of date-hardcoded tests
// turning into silent time bombs once "today" moves past them. Pure calendar-math
// helpers (isoWeekOf) reasoning about synthetic dates with no dependency on "today" are
// the one exception — mirrors the same convention already used in
// vocational-school.test.ts / jarbschg-slot.test.ts.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import {
  BS_PATTERN_ORDER_BY,
  findAmbiguousClaimDates,
  type PatternClaimShape,
} from "../utils/vocational-school-pattern-order";
import {
  getVocationalSchoolMinutesForDate,
  bsUnterrichtsMinutesByDateForIsoWeek,
} from "../utils/vocational-school-saldo";
import { loadBsSlotOverrides } from "../utils/load-bs-slot-overrides";
import { checkJArbSchG } from "../utils/jarbschg";
import { previewVocationalSchoolGeneration } from "../utils/vocational-school-generator";

// ── Date helpers (dynamic — never a hardcoded absolute date reasoning about "now") ──

function todayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function addDaysUtc(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Monday of the current ISO week, UTC midnight. */
function currentMonday(): Date {
  const d = todayUtc();
  const native = d.getUTCDay(); // 0=Sun..6=Sat
  const dow = native === 0 ? 6 : native - 1; // 0=Mo..6=So
  return addDaysUtc(d, -dow);
}

/** Monday `weeksAgo` weeks before the current ISO week. */
function mondayWeeksAgo(weeksAgo: number): Date {
  return addDaysUtc(currentMonday(), -7 * weeksAgo);
}

// ISO week number (1..53) of a UTC date. Mirrors the helper in
// vocational-school-generator.ts / vocational-school-pattern-order.ts.
function isoWeekOf(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

/** Birth date that makes the employee exactly `years` old AT `referenceDate` (with a
 * 1-day safety margin so the birthday has unambiguously already passed). Computed
 * relative to the test's own reference date, never relative to wall-clock "today". */
function ageAtRefDate(referenceDate: Date, years: number): Date {
  const d = new Date(referenceDate.getTime());
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

// ── Fixture helpers ──────────────────────────────────────────────────────────

async function seedBsAbsence(app: FastifyInstance, employeeId: string, date: Date) {
  return app.prisma.absence.create({
    data: {
      employeeId,
      type: "VOCATIONAL_SCHOOL",
      source: "PATTERN",
      startDate: date,
      endDate: date,
      days: 1.0,
      createdBy: "bs-pattern-historisation-test",
      deletedAt: null,
    },
  });
}

interface CreatePatternOpts {
  validFrom: Date;
  validUntil?: Date | null;
  createdAt?: Date;
  daysOfWeek?: number[];
  blockWeeks?: number[];
  blockYear?: number | null;
  bsSlotFirstLongDayMinutes?: number | null;
  bsSlotSecondLongDayMinutes?: number | null;
  bsSlotShortDayMinutes?: number | null;
  bsSlotBlockWeekMinutes?: number | null;
  unterrichtsMinutenByDow?: Record<string, number>;
  isActive?: boolean;
}

async function createPattern(app: FastifyInstance, employeeId: string, opts: CreatePatternOpts) {
  return app.prisma.employeeVocationalSchoolPattern.create({
    data: {
      employeeId,
      daysOfWeek: opts.daysOfWeek ?? [],
      blockWeeks: opts.blockWeeks ?? [],
      blockYear: opts.blockYear ?? null,
      validFrom: opts.validFrom,
      validUntil: opts.validUntil ?? null,
      isActive: opts.isActive ?? true,
      createdAt: opts.createdAt ?? new Date(),
      bsSlotFirstLongDayMinutes: opts.bsSlotFirstLongDayMinutes ?? null,
      bsSlotSecondLongDayMinutes: opts.bsSlotSecondLongDayMinutes ?? null,
      bsSlotShortDayMinutes: opts.bsSlotShortDayMinutes ?? null,
      bsSlotBlockWeekMinutes: opts.bsSlotBlockWeekMinutes ?? null,
      unterrichtsMinutenByDow: opts.unterrichtsMinutenByDow ?? {},
    },
  });
}

// 103-BEFUND.md § "Zweiter Befund" — the measured real-world tie: same validFrom,
// createdAt 41 days apart. Reused verbatim as the fixture shape throughout this file.
const TIE_CREATEDAT_GAP_MS = 41 * 24 * 60 * 60 * 1000;

// ── DB-backed determinism tests (all four single-winner consumers) ──────────────

describe("BS-pattern tied-validFrom determinism (Phase 103 Plan 05 Task 1)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "bs-hist");
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
    await app.prisma.employeeVocationalSchoolPattern.deleteMany({
      where: { employeeId: data.employee.id },
    });
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: {
        classification: "AZUBI",
        birthDate: null,
        bsSlotFirstLongDayMinutes: null,
        bsSlotSecondLongDayMinutes: null,
        bsSlotShortDayMinutes: null,
        bsSlotBlockWeekMinutes: null,
      },
    });
  });

  it("BS_PATTERN_ORDER_BY resolves a tied validFrom to the SAME winner (later createdAt) across 10 consecutive findFirst calls", async () => {
    const validFrom = mondayWeeksAgo(10);
    const older = await createPattern(app, data.employee.id, {
      validFrom,
      createdAt: new Date(validFrom.getTime()),
      daysOfWeek: [0],
    });
    const newer = await createPattern(app, data.employee.id, {
      validFrom,
      createdAt: new Date(validFrom.getTime() + TIE_CREATEDAT_GAP_MS),
      daysOfWeek: [0],
    });

    for (let i = 0; i < 10; i++) {
      const winner = await app.prisma.employeeVocationalSchoolPattern.findFirst({
        where: { employeeId: data.employee.id, isActive: true },
        orderBy: BS_PATTERN_ORDER_BY,
      });
      expect(winner?.id).toBe(newer.id);
      expect(winner?.id).not.toBe(older.id);
    }
  });

  it("getVocationalSchoolMinutesForDate and loadBsSlotOverrides() agree on the tied-validFrom winner and stay stable across 10 calls — DIFFERENT bsSlotFirstLongDayMinutes so a flipped winner changes the number, not just an id", async () => {
    const validFrom = mondayWeeksAgo(10);
    const target = validFrom; // single isolated BS day this ISO week → FIRST_LONG_DAY
    await seedBsAbsence(app, data.employee.id, target);

    await createPattern(app, data.employee.id, {
      validFrom,
      createdAt: new Date(validFrom.getTime()),
      daysOfWeek: [0],
      bsSlotFirstLongDayMinutes: 300,
    });
    const newer = await createPattern(app, data.employee.id, {
      validFrom,
      createdAt: new Date(validFrom.getTime() + TIE_CREATEDAT_GAP_MS),
      daysOfWeek: [0],
      bsSlotFirstLongDayMinutes: 500,
    });

    const minutesResults: number[] = [];
    const overrideResults: (number | null)[] = [];
    for (let i = 0; i < 10; i++) {
      minutesResults.push(
        await getVocationalSchoolMinutesForDate(app.prisma, data.employee.id, target, null),
      );
      const ov = await loadBsSlotOverrides(app.prisma, data.employee.id, target);
      overrideResults.push(ov.patternSlots?.bsSlotFirstLongDayMinutes ?? null);
    }

    expect(new Set(minutesResults).size).toBe(1);
    expect(new Set(overrideResults).size).toBe(1);
    // Both consumers agree on the SAME winner (the later-createdAt row, 500 min) —
    // not merely stable individually, but identical to each other.
    expect(minutesResults[0]).toBe(500);
    expect(overrideResults[0]).toBe(500);
    expect(newer.bsSlotFirstLongDayMinutes).toBe(500);
  });

  it("bsUnterrichtsMinutesByDateForIsoWeek resolves the tied-validFrom winner's per-DOW Unterrichtszeit map stably across 10 calls", async () => {
    const validFrom = mondayWeeksAgo(10);
    await seedBsAbsence(app, data.employee.id, validFrom); // no per-day override → pattern fallback

    await createPattern(app, data.employee.id, {
      validFrom,
      createdAt: new Date(validFrom.getTime()),
      unterrichtsMinutenByDow: { "0": 100 },
    });
    await createPattern(app, data.employee.id, {
      validFrom,
      createdAt: new Date(validFrom.getTime() + TIE_CREATEDAT_GAP_MS),
      unterrichtsMinutenByDow: { "0": 480 },
    });

    const results: Array<number | null> = [];
    for (let i = 0; i < 10; i++) {
      const map = await bsUnterrichtsMinutesByDateForIsoWeek(
        app.prisma,
        data.employee.id,
        validFrom,
      );
      results.push(map[toIso(validFrom)] ?? null);
    }

    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe(480); // later-createdAt row wins
  });

  it("checkJArbSchG resolves a stable verdict across 10 repeated calls when the tied rows carry DIFFERENT bsSlotSecondLongDayMinutes — the number, not just the id, must flip", async () => {
    const MON = mondayWeeksAgo(10);
    const TUE = addDaysUtc(MON, 1);
    await seedBsAbsence(app, data.employee.id, MON);
    await seedBsAbsence(app, data.employee.id, TUE); // >= 2 distinct BS days → RESOLVER mode

    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { birthDate: ageAtRefDate(TUE, 17) }, // minor at TUE
    });

    // TUE = ordinal 2 → SECOND_LONG_DAY. isLongDay = creditedMinutes > 225 (JARBSCHG_LONG_DAY_INSTRUCTION_MIN).
    await createPattern(app, data.employee.id, {
      validFrom: MON,
      createdAt: new Date(MON.getTime()),
      bsSlotSecondLongDayMinutes: 100, // <= 225 → NOT a long day if this one wins
    });
    const newer = await createPattern(app, data.employee.id, {
      validFrom: MON,
      createdAt: new Date(MON.getTime() + TIE_CREATEDAT_GAP_MS),
      bsSlotSecondLongDayMinutes: 480, // > 225 → long day, hard-blocks a minor
    });
    expect(newer.bsSlotSecondLongDayMinutes).toBe(480);

    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(
        await checkJArbSchG(app.prisma, {
          employeeId: data.employee.id,
          date: TUE,
          plannedNetWorkMin: 300,
        }),
      );
    }

    for (const r of results) expect(r.blocked).toBe(results[0].blocked);
    // The later-createdAt row (480 min, long day) wins → hard block fires.
    expect(results[0].blocked).toBe(true);
  });

  it("GET pattern list orders active patterns using the same total order BS_PATTERN_ORDER_BY gives the slot resolvers, so the UI's 'current' pattern matches the saldo's", async () => {
    const validFrom = mondayWeeksAgo(10);
    await createPattern(app, data.employee.id, {
      validFrom,
      createdAt: new Date(validFrom.getTime()),
      daysOfWeek: [0],
    });
    const newer = await createPattern(app, data.employee.id, {
      validFrom,
      createdAt: new Date(validFrom.getTime() + TIE_CREATEDAT_GAP_MS),
      daysOfWeek: [1],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${data.employee.id}/vocational-school-pattern`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{ id: string }>;
    expect(body[0]?.id).toBe(newer.id);
  });
});

// ── Pure ambiguity detection tests (DB-free) ─────────────────────────────────────

describe("findAmbiguousClaimDates (Phase 103 Plan 05 Task 1, pure)", () => {
  it("reports [] for a weekday pattern plus a temporally-disjoint block-week pattern — the legitimate superseded-pattern shape, not a false positive", () => {
    const blockWindowMonday = mondayWeeksAgo(4);
    const blockIso = isoWeekOf(blockWindowMonday);

    const weekday: PatternClaimShape = {
      dayOfWeek: null,
      daysOfWeek: [0],
      blockWeeks: [],
      blockYear: null,
      validFrom: mondayWeeksAgo(20),
      validUntil: addDaysUtc(mondayWeeksAgo(6), -1), // closed BEFORE the block pattern starts
    };
    const block: PatternClaimShape = {
      dayOfWeek: null,
      daysOfWeek: [],
      blockWeeks: [blockIso.week],
      blockYear: blockIso.year,
      validFrom: mondayWeeksAgo(6), // starts AFTER the weekday pattern closed
      validUntil: null,
    };

    const dates = findAmbiguousClaimDates(
      [weekday, block],
      mondayWeeksAgo(20),
      addDaysUtc(mondayWeeksAgo(4), 4),
    );
    expect(dates).toEqual([]);
  });

  it("reports every overlapping date, ascending and deduped, when two active patterns genuinely claim the same day (the unclosed-supersession shape)", () => {
    const overlapMonday = mondayWeeksAgo(5);
    const overlapIso = isoWeekOf(overlapMonday);

    const weekday: PatternClaimShape = {
      dayOfWeek: null,
      daysOfWeek: [0], // every Monday
      blockWeeks: [],
      blockYear: null,
      validFrom: mondayWeeksAgo(20),
      validUntil: null, // never closed — the bug this plan's Task 2 fixes going forward
    };
    const block: PatternClaimShape = {
      dayOfWeek: null,
      daysOfWeek: [],
      blockWeeks: [overlapIso.week],
      blockYear: overlapIso.year,
      validFrom: mondayWeeksAgo(6),
      validUntil: null,
    };

    const dates = findAmbiguousClaimDates(
      [weekday, block],
      mondayWeeksAgo(20),
      addDaysUtc(mondayWeeksAgo(4), 4),
    );

    // The block week's own Monday is claimed by BOTH patterns.
    expect(dates).toContain(toIso(overlapMonday));
    expect(dates.length).toBeGreaterThan(0);
    expect(dates).toEqual([...dates].sort());
    expect(new Set(dates).size).toBe(dates.length);
  });

  it("returns [] when fewer than two patterns are given — no ambiguity is possible with a single claimant", () => {
    const only: PatternClaimShape = {
      dayOfWeek: null,
      daysOfWeek: [0],
      blockWeeks: [],
      blockYear: null,
      validFrom: mondayWeeksAgo(10),
      validUntil: null,
    };
    expect(findAmbiguousClaimDates([only], mondayWeeksAgo(10), mondayWeeksAgo(1))).toEqual([]);
    expect(findAmbiguousClaimDates([], mondayWeeksAgo(10), mondayWeeksAgo(1))).toEqual([]);
  });
});

// ── Generator-level: ambiguousDates wiring + the legitimate union is preserved ────

describe("Generator ambiguousDates + legitimate multi-pattern union (Phase 103 Plan 05 Task 1)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "bs-hist-gen");
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
    await app.prisma.employeeVocationalSchoolPattern.deleteMany({
      where: { employeeId: data.employee.id },
    });
  });

  it("ambiguousDates stays undefined for a forward-only run (no explicit windowStart) — byte-identical result shape, no extra work", async () => {
    const validFrom = mondayWeeksAgo(1);
    await createPattern(app, data.employee.id, { validFrom, daysOfWeek: [0] });

    const result = await previewVocationalSchoolGeneration(app.prisma, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      weeksAhead: 1,
    });
    expect(result.ambiguousDates).toBeUndefined();
  });

  it("ambiguousDates is populated for a retroactive run (explicit windowStart) when two active patterns overlap", async () => {
    const overlapMonday = mondayWeeksAgo(3);
    const overlapIso = isoWeekOf(overlapMonday);

    await createPattern(app, data.employee.id, {
      validFrom: mondayWeeksAgo(10),
      daysOfWeek: [0],
    });
    await createPattern(app, data.employee.id, {
      validFrom: mondayWeeksAgo(4),
      blockWeeks: [overlapIso.week],
      blockYear: overlapIso.year,
    });

    const result = await previewVocationalSchoolGeneration(app.prisma, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      windowStart: mondayWeeksAgo(10),
      windowEnd: addDaysUtc(mondayWeeksAgo(1), 6),
    });

    expect(result.ambiguousDates).toBeDefined();
    expect(result.ambiguousDates).toContain(toIso(overlapMonday));
  });

  it("a weekday pattern + a temporally-disjoint block-week pattern still create the union of BOTH day sets — created count unchanged, ambiguousDates empty", async () => {
    const weekdayStart = mondayWeeksAgo(20);
    const weekdayEnd = addDaysUtc(mondayWeeksAgo(6), -1); // closes before the block pattern starts
    const blockStart = mondayWeeksAgo(6);
    const blockMonday = mondayWeeksAgo(3);
    const blockIso = isoWeekOf(blockMonday);
    const windowStart = weekdayStart;
    const windowEnd = addDaysUtc(mondayWeeksAgo(1), 6);

    await createPattern(app, data.employee.id, {
      validFrom: weekdayStart,
      validUntil: weekdayEnd,
      daysOfWeek: [0], // every Monday
    });
    await createPattern(app, data.employee.id, {
      validFrom: blockStart,
      blockWeeks: [blockIso.week],
      blockYear: blockIso.year,
    });

    // Expected Monday count in [weekdayStart, weekdayEnd], computed (never hardcoded).
    let expectedMondays = 0;
    for (let d = weekdayStart; d <= weekdayEnd; d = addDaysUtc(d, 1)) {
      if (d.getUTCDay() === 1) expectedMondays++;
    }
    const expectedCreated = expectedMondays + 5; // + the block week's Mo-Fr

    const result = await previewVocationalSchoolGeneration(app.prisma, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      windowStart,
      windowEnd,
    });

    expect(result.ambiguousDates).toEqual([]);
    expect(result.created).toBe(expectedCreated);
  });
});

// ── Task 2 — option B: PUT closes validUntil on the row(s) it is already
// deactivating, inside the same transaction ─────────────────────────────────────
//
// Owner Decision (103-HISTORISATION-DIAGNOSTIC.md, decided 2026-08-22):
// "Authorised: option A + option B ... NOT authorised: option C. No one-off repair
// script, and no rewrite of the two rows that are already anomalous ... They stay
// exactly as they are." Option B's scope is hard-bounded: validUntil is written ONLY
// on rows the PUT transaction is already deactivating in that same save — no sweep,
// no backfill of unrelated rows (that would be option C, declined).

describe("PUT vocational-school-pattern — option B close-out (Phase 103 Plan 05 Task 2)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "bs-hist-optb");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // Mirrors vocational-school.test.ts's own afterEach: the PUT handler fires a
  // fire-and-forget background BS-generator run. Drain it after every test so it
  // can never leak Absence rows into the next test's beforeEach baseline.
  afterEach(async () => {
    await app.waitForPendingBSGenerations?.();
  });

  beforeEach(async () => {
    await app.prisma.absence.deleteMany({ where: { employeeId: data.employee.id } });
    await app.prisma.employeeVocationalSchoolPattern.deleteMany({
      where: { employeeId: data.employee.id },
    });
  });

  async function putPatterns(patterns: unknown[]) {
    return app.inject({
      method: "PUT",
      url: `/api/v1/employees/${data.employee.id}/vocational-school-pattern`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { patterns },
    });
  }

  it("closes the superseded row's validUntil to the day before a strictly later incoming validFrom", async () => {
    const oldRow = await createPattern(app, data.employee.id, {
      validFrom: mondayWeeksAgo(20),
      daysOfWeek: [0],
    });

    const newValidFrom = mondayWeeksAgo(2);
    const res = await putPatterns([{ daysOfWeek: [1], validFrom: toIso(newValidFrom) }]);
    expect(res.statusCode).toBe(200);

    const reread = await app.prisma.employeeVocationalSchoolPattern.findUniqueOrThrow({
      where: { id: oldRow.id },
    });
    expect(reread.isActive).toBe(false);
    expect(reread.validUntil).not.toBeNull();
    expect(toIso(reread.validUntil!)).toBe(toIso(addDaysUtc(newValidFrom, -1)));
  });

  it("leaves validUntil null when the incoming validFrom is EQUAL to the superseded row's own validFrom", async () => {
    const sameDate = mondayWeeksAgo(2);
    const oldRow = await createPattern(app, data.employee.id, {
      validFrom: sameDate,
      daysOfWeek: [0],
    });

    const res = await putPatterns([{ daysOfWeek: [1], validFrom: toIso(sameDate) }]);
    expect(res.statusCode).toBe(200);

    const reread = await app.prisma.employeeVocationalSchoolPattern.findUniqueOrThrow({
      where: { id: oldRow.id },
    });
    expect(reread.isActive).toBe(false);
    expect(reread.validUntil).toBeNull();
  });

  it("leaves validUntil null when the incoming validFrom is EARLIER than the superseded row's own validFrom (a row that never applied before the new one has no meaningful end date)", async () => {
    const oldRow = await createPattern(app, data.employee.id, {
      validFrom: mondayWeeksAgo(2),
      daysOfWeek: [0],
    });

    const earlierValidFrom = mondayWeeksAgo(5);
    const res = await putPatterns([{ daysOfWeek: [1], validFrom: toIso(earlierValidFrom) }]);
    expect(res.statusCode).toBe(200);

    const reread = await app.prisma.employeeVocationalSchoolPattern.findUniqueOrThrow({
      where: { id: oldRow.id },
    });
    expect(reread.validUntil).toBeNull();
  });

  it("leaves a row that already carries an explicit validUntil unchanged — the admin's own prior statement is never overwritten", async () => {
    const presetValidUntil = mondayWeeksAgo(15);
    const oldRow = await createPattern(app, data.employee.id, {
      validFrom: mondayWeeksAgo(20),
      validUntil: presetValidUntil,
      daysOfWeek: [0],
    });

    const res = await putPatterns([{ daysOfWeek: [1], validFrom: toIso(mondayWeeksAgo(2)) }]);
    expect(res.statusCode).toBe(200);

    const reread = await app.prisma.employeeVocationalSchoolPattern.findUniqueOrThrow({
      where: { id: oldRow.id },
    });
    expect(toIso(reread.validUntil!)).toBe(toIso(presetValidUntil));
  });

  it("the REPLACE audit row's oldValue.patterns still shows the pre-change state (validUntil null, BEFORE the close-out write)", async () => {
    const oldRow = await createPattern(app, data.employee.id, {
      validFrom: mondayWeeksAgo(20),
      daysOfWeek: [0],
    });

    const res = await putPatterns([{ daysOfWeek: [1], validFrom: toIso(mondayWeeksAgo(2)) }]);
    expect(res.statusCode).toBe(200);

    const auditRow = await app.prisma.auditLog.findFirst({
      where: {
        entity: "EmployeeVocationalSchoolPattern",
        entityId: data.employee.id,
        action: "REPLACE",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRow).not.toBeNull();
    const oldValue = auditRow!.oldValue as {
      patterns: Array<{ id: string; validUntil: string | null }>;
    };
    const capturedOldRow = oldValue.patterns.find((p) => p.id === oldRow.id);
    expect(capturedOldRow).toBeDefined();
    // The before-snapshot was taken BEFORE the transaction (and this task must not
    // move it) — it must still show the row as it was PRIOR to this PUT's own
    // close-out write, i.e. validUntil null, even though the row is closed by now.
    expect(capturedOldRow!.validUntil).toBeNull();
  });
});
