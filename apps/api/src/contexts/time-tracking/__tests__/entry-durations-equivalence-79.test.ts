/**
 * Phase 79 Plan 01 (Issue #79), R5/R6, D-10/D-12 — every pre-79 working-time expression equals
 * its post-79 recipe with EXACT equality.
 *
 * The left side is `./fixtures/legacy-working-minutes-pre79.ts`: verbatim copies of the twelve
 * inline expressions of commit `f1fbb71f`. The right side is the recipe each call site writes once
 * it is migrated onto the duration kernel (plans 79-03 and 79-05). The comparison is `!==` on
 * floats, not "close enough": the operation order is the contract (D-12), and a refactor that
 * reassociates `(sum + presence) - break` into `sum + (presence - break)` changes the last bit
 * for millisecond-precision rows. The sensitivity test at the bottom proves this matrix can see
 * exactly that change.
 *
 * DB-free. No instant is relative to "now" — every instant is a fixed UTC instant, including both
 * 2026 Europe/Berlin DST switch days. Every matrix asserts a case-count floor (anti-vacuity), so a
 * generator that silently produces nothing turns the test red instead of green.
 */
import { describe, it, expect } from "vitest";
import { entryDurations, addWorkingMinutes } from "../entry-durations";
import {
  legacyCloseEmployeeMonthNetMinutes,
  legacyOvertimeBalanceWorkedMinutes,
  legacyMonthSaldoWorkedMinutes,
  legacyDashboardTodayMinutes,
  legacyDashboardPeriodWorkedMinutes,
  legacyDashboardTeamWeekDayMinutes,
  legacyDashboardMyWeekDayMinutes,
  legacyReportsNetHours,
  legacyDatevWorkedMinutes,
  legacyArbzgDaySlotTotals,
  legacyArbzgWeeklyNetMinutes,
  legacyArbzgAverageNetMinutes,
  type LegacyEntryRow,
} from "./fixtures/legacy-working-minutes-pre79";

// ── Migration recipes — what plans 79-03 and 79-05 write at each call site ────────────────────

/** S1 — close-employee-month.ts: per entry. */
const recipeCloseEmployeeMonthNetMinutes = (e: {
  startTime: Date;
  endTime: Date;
  breakMinutes: bigint | number;
}): number => entryDurations(e).workingMinutes;

/** S2 — overtime-balance.ts: left fold. */
const recipeOvertimeBalanceWorkedMinutes = (entries: LegacyEntryRow[]): number =>
  entries.reduce((sum, e) => addWorkingMinutes(sum, e), 0);

/** S3 — month-saldo.ts: left fold (an open entry leaves the sum unchanged). */
const recipeMonthSaldoWorkedMinutes = (entries: LegacyEntryRow[]): number =>
  entries.reduce((sum, e) => addWorkingMinutes(sum, e), 0);

/** S4 — dashboard.ts "today": the `if (e.endTime)` guard stays, the addend is the kernel value. */
const recipeDashboardTodayMinutes = (todayEntries: LegacyEntryRow[]): number => {
  let todayMinutes = 0;
  for (const e of todayEntries) {
    if (e.endTime) {
      todayMinutes += entryDurations(e).workingMinutes;
    }
  }
  return todayMinutes;
};

/** S5 — dashboard.ts period loop. */
const recipeDashboardPeriodWorkedMinutes = (periodEntries: LegacyEntryRow[]): number => {
  let periodWorkedMinutes = 0;
  for (const e of periodEntries) {
    if (e.endTime) {
      periodWorkedMinutes += entryDurations(e).workingMinutes;
    }
  }
  return periodWorkedMinutes;
};

/** S6 — dashboard.ts team week: keeps `!e.isInvalid && e.endTime`. */
const recipeDashboardTeamWeekDayMinutes = (dayEntries: LegacyEntryRow[]): number => {
  let workedMinutes = 0;
  for (const e of dayEntries) {
    if (!e.isInvalid && e.endTime) {
      workedMinutes += entryDurations(e).workingMinutes;
    }
  }
  return workedMinutes;
};

/** S7 — dashboard.ts my week: left fold. */
const recipeDashboardMyWeekDayMinutes = (dayEntries: LegacyEntryRow[]): number =>
  dayEntries.reduce((sum: number, e) => addWorkingMinutes(sum, e), 0);

/** S8 — reports.ts: per entry inside the caller's unchanged rounding, open -> 0. */
const recipeReportsNetHours = (e: LegacyEntryRow): number =>
  e.endTime ? Math.round((entryDurations(e).workingMinutes / 60) * 100) / 100 : 0;

/** S9 — reports.ts DATEV: left fold. */
const recipeDatevWorkedMinutes = (entries: LegacyEntryRow[]): number =>
  entries.reduce((sum, e) => addWorkingMinutes(sum, e), 0);

/** S10 — arbzg.ts daily check per-slot loop. */
const recipeArbzgDaySlotTotals = (
  daySlots: LegacyEntryRow[],
): { netWorkedMin: number; explicitBreakMin: number } => {
  let netWorkedMin = 0;
  let explicitBreakMin = 0;
  for (const slot of daySlots) {
    const d = entryDurations(slot);
    explicitBreakMin += d.breakMinutes;
    netWorkedMin += d.workingMinutes;
  }
  return { netWorkedMin, explicitBreakMin };
};

/** S11 — arbzg.ts weekly check: left fold. */
const recipeArbzgWeeklyNetMinutes = (weekSlots: LegacyEntryRow[]): number =>
  weekSlots.reduce((sum, e) => addWorkingMinutes(sum, e), 0);

/** S12 — arbzg.ts 24-week average: left fold. */
const recipeArbzgAverageNetMinutes = (avgEntries: LegacyEntryRow[]): number =>
  avgEntries.reduce((sum, e) => addWorkingMinutes(sum, e), 0);

// ── Deterministic generators ──────────────────────────────────────────────────────────────────

/** mulberry32 — a seeded PRNG so every run sees the same matrix (no Math.random). */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 790079;
const MS_MIN = 60_000;
const MS_H = 3_600_000;

// 2026-03-29 and 2026-10-25 are the Europe/Berlin DST switch days.
const DAYS = ["2026-02-02", "2026-03-28", "2026-03-29", "2026-06-15", "2026-10-24", "2026-10-25"];

const dayStart = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);

/** Start offsets within a day, in ms. The 21:00 and 23:30 starts cross midnight with long durations. */
const MINUTE_STARTS = [
  30 * MS_MIN, // 00:30
  6 * MS_H, // 06:00
  7 * MS_H + 58 * MS_MIN, // 07:58
  21 * MS_H, // 21:00
  23 * MS_H + 30 * MS_MIN, // 23:30
];
const SECOND_STARTS = [
  7 * MS_H + 58 * MS_MIN + 17_000, // 07:58:17
  21 * MS_H + 17_000, // 21:00:17
];
const MS_STARTS = [
  6 * MS_H + 58 * MS_MIN + 17_123, // 06:58:17.123
  7 * MS_H + 58 * MS_MIN + 44_987, // 07:58:44.987
];
const ALL_STARTS = [...MINUTE_STARTS, ...SECOND_STARTS, ...MS_STARTS];

const DURATIONS = [
  0,
  1 * MS_MIN,
  4 * MS_H,
  6 * MS_H,
  6 * MS_H + 1_000, // 6 h 0 min 1 s
  7 * MS_H + 30 * MS_MIN,
  8 * MS_H,
  8 * MS_H + 33 * MS_MIN + 27_864, // 8 h 33 min 27.864 s
  9 * MS_H,
  10 * MS_H,
  12 * MS_H,
  14 * MS_H,
];

/** 600 exceeds the presence of every short duration, so working time goes negative there. */
const NUMBER_BREAKS: number[] = [0, 15, 30, 45, 60, 90, 600];
const BIGINT_BREAKS: bigint[] = [30n, 45n];

type Break = number | bigint | null;

const closedRow = (day: string, start: number, dur: number, brk: Break): LegacyEntryRow => {
  const s = dayStart(day) + start;
  return { startTime: new Date(s), endTime: new Date(s + dur), breakMinutes: brk };
};

/** The full closed cartesian pool: day x start x duration x break (number, bigint and null). */
function closedPool(breaks: Break[]): LegacyEntryRow[] {
  const rows: LegacyEntryRow[] = [];
  for (const day of DAYS)
    for (const start of ALL_STARTS)
      for (const dur of DURATIONS) for (const b of breaks) rows.push(closedRow(day, start, dur, b));
  return rows;
}

type Pick = { closedOnly: boolean; msOnly?: boolean };

/** One PRNG-drawn row; open and invalid rows only when `closedOnly` is false. */
function drawRow(rand: () => number, pick: Pick): LegacyEntryRow {
  const choose = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const day = choose(DAYS);
  const start = choose(pick.msOnly ? MS_STARTS : ALL_STARTS);
  const dur = choose(DURATIONS);
  const brk: Break = choose<Break>([...NUMBER_BREAKS, ...BIGINT_BREAKS, null]);
  const row = closedRow(day, start, dur, brk);
  if (!pick.closedOnly) {
    if (rand() < 0.15) row.endTime = null;
    if (rand() < 0.15) row.isInvalid = true;
  }
  return row;
}

function sequences(seed: number, count: number, pick: Pick): LegacyEntryRow[][] {
  const rand = mulberry32(seed);
  const out: LegacyEntryRow[][] = [];
  for (let i = 0; i < count; i++) {
    const len = 1 + Math.floor(rand() * 25);
    const seq: LegacyEntryRow[] = [];
    for (let j = 0; j < len; j++) seq.push(drawRow(rand, pick));
    out.push(seq);
  }
  return out;
}

const describeRow = (r: LegacyEntryRow): string =>
  `${r.startTime.toISOString()}..${r.endTime ? r.endTime.toISOString() : "open"} brk=${String(r.breakMinutes)}${r.isInvalid ? " invalid" : ""}`;

const MIXED = sequences(SEED, 3000, { closedOnly: false });
const CLOSED = sequences(SEED + 1, 3000, { closedOnly: true });
const MS_CLOSED = sequences(SEED + 2, 3000, { closedOnly: true, msOnly: true });

// ── Equivalence ───────────────────────────────────────────────────────────────────────────────

describe("Issue #79 R5/R6 — legacy pre-79 expressions equal the kernel recipes (exact equality)", () => {
  it("S1 per entry (number and bigint breaks): closed cartesian pool", () => {
    const pool = closedPool([...NUMBER_BREAKS, ...BIGINT_BREAKS]);
    const mismatches: string[] = [];
    let cases = 0;
    for (const r of pool) {
      const e = { startTime: r.startTime, endTime: r.endTime!, breakMinutes: r.breakMinutes! };
      const legacy = legacyCloseEmployeeMonthNetMinutes(
        e as Parameters<typeof legacyCloseEmployeeMonthNetMinutes>[0],
      );
      const recipe = recipeCloseEmployeeMonthNetMinutes(
        e as Parameters<typeof recipeCloseEmployeeMonthNetMinutes>[0],
      );
      cases++;
      if (legacy !== recipe) mismatches.push(`${describeRow(r)}: ${legacy} !== ${recipe}`);
    }
    expect(cases).toBeGreaterThan(5000);
    expect(mismatches).toEqual([]);
  });

  it("S8 per entry incl. the caller's rounding (number, bigint and null breaks): closed cartesian pool", () => {
    const pool = closedPool([...NUMBER_BREAKS, ...BIGINT_BREAKS, null]);
    const mismatches: string[] = [];
    let cases = 0;
    for (const r of pool) {
      cases++;
      const legacy = legacyReportsNetHours(r);
      const recipe = recipeReportsNetHours(r);
      if (legacy !== recipe) mismatches.push(`${describeRow(r)}: ${legacy} !== ${recipe}`);
    }
    expect(cases).toBeGreaterThan(5000);
    expect(mismatches).toEqual([]);
  });

  it("S8 open entries stay 0", () => {
    const open: LegacyEntryRow = {
      startTime: new Date("2026-02-02T08:00:00.000Z"),
      endTime: null,
      breakMinutes: 30,
    };
    expect(legacyReportsNetHours(open)).toBe(0);
    expect(recipeReportsNetHours(open)).toBe(0);
  });

  it("S10 per slot (closed rows only): netWorkedMin and explicitBreakMin", () => {
    const mismatches: string[] = [];
    let cases = 0;
    for (const seq of CLOSED) {
      cases++;
      const legacy = legacyArbzgDaySlotTotals(seq);
      const recipe = recipeArbzgDaySlotTotals(seq);
      if (
        legacy.netWorkedMin !== recipe.netWorkedMin ||
        legacy.explicitBreakMin !== recipe.explicitBreakMin
      ) {
        mismatches.push(
          `${seq.map(describeRow).join(" | ")}: ${JSON.stringify(legacy)} !== ${JSON.stringify(recipe)}`,
        );
      }
    }
    expect(cases).toBeGreaterThan(2000);
    expect(mismatches).toEqual([]);
  });

  const mixedShapes: Array<
    [string, (r: LegacyEntryRow[]) => number, (r: LegacyEntryRow[]) => number]
  > = [
    ["S2 left fold", legacyOvertimeBalanceWorkedMinutes, recipeOvertimeBalanceWorkedMinutes],
    ["S4 loop (today)", legacyDashboardTodayMinutes, recipeDashboardTodayMinutes],
    ["S5 loop (period)", legacyDashboardPeriodWorkedMinutes, recipeDashboardPeriodWorkedMinutes],
    [
      "S6 loop (team week, skips invalid)",
      legacyDashboardTeamWeekDayMinutes,
      recipeDashboardTeamWeekDayMinutes,
    ],
    ["S7 left fold (my week)", legacyDashboardMyWeekDayMinutes, recipeDashboardMyWeekDayMinutes],
    ["S9 left fold (DATEV)", legacyDatevWorkedMinutes, recipeDatevWorkedMinutes],
  ];
  for (const [name, legacy, recipe] of mixedShapes) {
    it(`${name}: sequences incl. open and invalid rows`, () => {
      const mismatches: string[] = [];
      let cases = 0;
      let openRows = 0;
      let invalidRows = 0;
      for (const seq of MIXED) {
        cases++;
        for (const r of seq) {
          if (!r.endTime) openRows++;
          if (r.isInvalid) invalidRows++;
        }
        const l = legacy(seq);
        const n = recipe(seq);
        if (l !== n) mismatches.push(`${seq.map(describeRow).join(" | ")}: ${l} !== ${n}`);
      }
      expect(cases).toBeGreaterThan(2000);
      // the pool really exercised open and invalid rows
      expect(openRows).toBeGreaterThan(500);
      expect(invalidRows).toBeGreaterThan(500);
      expect(mismatches).toEqual([]);
    });
  }

  const closedShapes: Array<
    [string, (r: LegacyEntryRow[]) => number, (r: LegacyEntryRow[]) => number]
  > = [
    ["S3 left fold (month saldo)", legacyMonthSaldoWorkedMinutes, recipeMonthSaldoWorkedMinutes],
    ["S11 left fold (ArbZG weekly)", legacyArbzgWeeklyNetMinutes, recipeArbzgWeeklyNetMinutes],
    ["S12 left fold (ArbZG average)", legacyArbzgAverageNetMinutes, recipeArbzgAverageNetMinutes],
  ];
  for (const [name, legacy, recipe] of closedShapes) {
    it(`${name}: closed-only sequences (their production inputs filter endTime not null)`, () => {
      const mismatches: string[] = [];
      let cases = 0;
      for (const seq of CLOSED) {
        cases++;
        const l = legacy(seq);
        const n = recipe(seq);
        if (l !== n) mismatches.push(`${seq.map(describeRow).join(" | ")}: ${l} !== ${n}`);
      }
      expect(cases).toBeGreaterThan(2000);
      expect(mismatches).toEqual([]);
    });
  }

  it("D-03 harmonisation: an OPEN row with break 30 is -30 in the legacy S3 fold and 0 in the recipe", () => {
    // Unreachable in production: T1 (`getValidWorkedEntriesInRange`) filters `endTime: { not: null }`,
    // so month-saldo.ts never sees an open row. The recipe returns the sum unchanged (D-03), which
    // is a harmonisation with every other fold, not a change of any reachable behaviour.
    const open: LegacyEntryRow[] = [
      { startTime: new Date("2026-02-02T08:00:00.000Z"), endTime: null, breakMinutes: 30 },
    ];
    expect(legacyMonthSaldoWorkedMinutes(open)).toBe(-30);
    expect(recipeMonthSaldoWorkedMinutes(open)).toBe(0);
  });
});

// ── Sensitivity (D-12) ────────────────────────────────────────────────────────────────────────

describe("Issue #79 D-12 — the matrix can see a float-association change", () => {
  it("the naive `sum + presence-minus-break` fold differs from the legacy S2 fold on ms-precision sequences; addWorkingMinutes never does", () => {
    let naiveMismatches = 0;
    let recipeMismatches = 0;
    let cases = 0;
    for (const seq of MS_CLOSED) {
      cases++;
      const legacy = legacyOvertimeBalanceWorkedMinutes(seq);
      const naive = seq.reduce((s, e) => s + entryDurations(e).workingMinutes, 0);
      if (naive !== legacy) naiveMismatches++;
      if (recipeOvertimeBalanceWorkedMinutes(seq) !== legacy) recipeMismatches++;
    }
    expect(cases).toBeGreaterThan(2000);
    expect(naiveMismatches).toBeGreaterThan(0);
    expect(recipeMismatches).toBe(0);
  });
});
