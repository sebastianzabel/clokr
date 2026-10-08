/**
 * Issue #80 (80-AC6) — the day kernel reproduces the pre-80 day warnings of `checkArbZG` with
 * EXACT equality wherever the rule did not change on purpose.
 *
 * The left side is `./fixtures/legacy-day-warnings-pre80.ts`: the verbatim § 4 / § 3 day
 * statements of commit `73838040`. The right side is what `checkArbZG` runs today:
 * `dayLimitWarnings(evaluateDayBreaks({ rows, dayBreaks: [], acks: [] }), bsMinutesToday)`.
 *
 *   (a) every single-entry day: identical, message strings included;
 *   (b) every same-salon multi-entry day: identical (the same-salon rule is unchanged, D-01);
 *   (c) cross-salon days: the ONLY difference is the travel gap of D-01 — the total break shrinks
 *       by exactly the sum of the cross-salon gaps of 0 < gap <= 120 minutes, and when there is no
 *       such gap the warnings equal the legacy ones apart from the additive `crossSalon` key;
 *   (d) a sensitivity floor proves the matrix can see a drift of the 120-minute boundary.
 *
 * DB-free. Every instant is a fixed UTC instant (no clock, no `Math.random`), including both 2026
 * Europe/Berlin DST switch days. Every matrix asserts a case-count floor (anti-vacuity), so a
 * generator that silently produces nothing turns the test red instead of green.
 */
import { describe, it, expect } from "vitest";
import { entryDurations } from "../entry-durations";
import { evaluateDayBreaks, type DayBreakRow } from "../day-break-rule";
import { dayLimitWarnings } from "../arbzg";
import {
  legacyDayWarningsPre80,
  type LegacyDaySlot,
  type LegacyDayWarning,
} from "./fixtures/legacy-day-warnings-pre80";

/** mulberry32 — a seeded PRNG so every run sees the same matrix. */
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

const SEED = 800080;
const MS_MIN = 60_000;
const MS_H = 3_600_000;

// 2026-03-29 and 2026-10-25 are the Europe/Berlin DST switch days.
const DAYS = ["2026-02-02", "2026-03-28", "2026-03-29", "2026-06-15", "2026-10-24", "2026-10-25"];
const dayStart = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);

const DURATIONS_MS: number[] = [
  0,
  1 * MS_MIN,
  5 * MS_H + 59 * MS_MIN,
  6 * MS_H,
  6 * MS_H + 1,
  6 * MS_H + 1 * MS_MIN,
  6 * MS_H + 30 * MS_MIN,
  8 * MS_H,
  9 * MS_H,
  9 * MS_H + 1,
  9 * MS_H + 1 * MS_MIN,
  9 * MS_H + 30 * MS_MIN,
  10 * MS_H,
  10 * MS_H + 1 * MS_MIN,
  11 * MS_H,
  12 * MS_H,
];
const WHOLE_MINUTE_DURATIONS_MS = DURATIONS_MS.filter((d) => d % MS_MIN === 0);
const BREAKS = [0, 15, 29, 30, 44, 45, 60];
const STATUSES = ["AUTO", "CONFIRMED", "WAIVED"] as const;
const BS_MINUTES = [0, 240, 570];
const GAPS_MIN = [-30, 0, 1, 30, 119, 120, 121, 180];

type Row = DayBreakRow & LegacyDaySlot & { endTime: Date };

let idSeq = 0;
function makeRow(
  salonId: string,
  startMs: number,
  durationMs: number,
  breakMinutes: number,
  breakStatus: string,
): Row {
  idSeq += 1;
  return {
    id: `r${String(idSeq).padStart(6, "0")}`,
    startTime: new Date(startMs),
    endTime: new Date(startMs + durationMs),
    breakMinutes,
    breakStatus,
    salonId,
  };
}

/** Rows in the order `findEntriesOfDay` returns them: start time, then id. */
function inLookupOrder(rows: Row[]): Row[] {
  return [...rows].sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime() || (a.id < b.id ? -1 : 1),
  );
}

function newWarnings(rows: Row[], bs: number): LegacyDayWarning[] {
  return dayLimitWarnings(
    evaluateDayBreaks({ rows, dayBreaks: [], acks: [] }),
    bs,
  ) as LegacyDayWarning[];
}

function describeCase(rows: Row[], bs: number): string {
  return JSON.stringify({
    bs,
    rows: rows.map((r) => [
      r.salonId,
      r.startTime.toISOString(),
      r.endTime.toISOString(),
      r.breakMinutes,
      r.breakStatus,
    ]),
  });
}

/** A multi-entry day: `count` rows chained with random gaps, over the given salon pool. */
function randomDay(
  rand: () => number,
  salons: readonly string[],
  durations: readonly number[],
  statuses: readonly string[],
  forceTwoSalons: boolean,
): Row[] {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const count = 2 + Math.floor(rand() * 3);
  const day = pick(DAYS);
  let cursor = dayStart(day) + 6 * MS_H;
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const salon = forceTwoSalons && i < 2 ? salons[i] : pick(salons);
    const duration = pick(durations);
    rows.push(makeRow(salon, cursor, duration, pick(BREAKS), pick(statuses)));
    cursor = cursor + duration + pick(GAPS_MIN) * MS_MIN;
  }
  return inLookupOrder(rows);
}

// ── (a) single-entry matrix ───────────────────────────────────────────────────────────────────

describe("Issue #80 80-AC6 (a) — every single-entry day is unchanged", () => {
  it("equals the frozen pre-80 warnings for the full cartesian matrix", () => {
    let cases = 0;
    let withFinding = 0;
    const mismatches: string[] = [];
    for (const day of DAYS) {
      for (const duration of DURATIONS_MS) {
        for (const brk of BREAKS) {
          for (const status of STATUSES) {
            for (const bs of BS_MINUTES) {
              cases++;
              const rows = [makeRow("salon-a", dayStart(day) + 8 * MS_H, duration, brk, status)];
              const legacy = legacyDayWarningsPre80(rows, bs);
              const current = newWarnings(rows, bs);
              if (legacy.length > 0) withFinding++;
              try {
                expect(current).toEqual(legacy);
                // key order and absent keys are part of the contract too
                expect(JSON.stringify(current)).toBe(JSON.stringify(legacy));
              } catch {
                mismatches.push(describeCase(rows, bs));
              }
            }
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(5000);
    expect(withFinding).toBeGreaterThan(500);
    if (mismatches.length > 0) console.error(mismatches.slice(0, 5));
    expect(mismatches).toHaveLength(0);
  });
});

// ── (b) same-salon multi-entry matrix ─────────────────────────────────────────────────────────

const SAME_SALON_CASES: Array<{ rows: Row[]; bs: number }> = (() => {
  const rand = mulberry32(SEED);
  const cases: Array<{ rows: Row[]; bs: number }> = [];
  for (let i = 0; i < 4000; i++) {
    const rows = randomDay(rand, ["salon-a"], DURATIONS_MS, STATUSES, false);
    cases.push({ rows, bs: BS_MINUTES[Math.floor(rand() * BS_MINUTES.length)] });
  }
  return cases;
})();

describe("Issue #80 80-AC6 (b) — every same-salon multi-entry day is unchanged (D-01)", () => {
  it("equals the frozen pre-80 warnings", () => {
    let withFinding = 0;
    let withGapCounted = 0;
    const mismatches: string[] = [];
    for (const { rows, bs } of SAME_SALON_CASES) {
      const legacy = legacyDayWarningsPre80(rows, bs);
      const current = newWarnings(rows, bs);
      if (legacy.length > 0) withFinding++;
      if (evaluateDayBreaks({ rows, dayBreaks: [], acks: [] }).gapBreakMin > 0) withGapCounted++;
      try {
        expect(current).toEqual(legacy);
        expect(JSON.stringify(current)).toBe(JSON.stringify(legacy));
      } catch {
        mismatches.push(describeCase(rows, bs));
      }
    }
    expect(SAME_SALON_CASES.length).toBeGreaterThan(3000);
    expect(withFinding).toBeGreaterThan(300);
    expect(withGapCounted).toBeGreaterThan(1000);
    if (mismatches.length > 0) console.error(mismatches.slice(0, 5));
    expect(mismatches).toHaveLength(0);
  });
});

// ── (c) cross-salon: the only delta is the travel gap ─────────────────────────────────────────

/** Sum of the gaps of 0 < gap <= 120 minutes between consecutive rows of DIFFERENT salons. */
function crossSalonGapSum(rows: Row[]): number {
  let sum = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].salonId === rows[i - 1].salonId) continue;
    const gap = (rows[i].startTime.getTime() - rows[i - 1].endTime.getTime()) / MS_MIN;
    if (gap > 0 && gap <= 120) sum += gap;
  }
  return sum;
}

function withoutCrossFlag(w: LegacyDayWarning & { crossSalon?: boolean }): LegacyDayWarning {
  const copy = { ...w };
  delete copy.crossSalon;
  return copy;
}

describe("Issue #80 80-AC6 (c) — a cross-salon day differs from the legacy result only by the travel gap (D-01)", () => {
  // breakStatus is drawn from AUTO and CONFIRMED only: an entry-level WAIVED on a cross-salon day
  // is the deliberate D-16 difference and is pinned in arbzg-multi-entry-80.test.ts and
  // day-break-rule.test.ts, not here.
  it("shrinks the total break by exactly the cross-salon gaps and nothing else", () => {
    const rand = mulberry32(SEED + 1);
    let withTravel = 0;
    let withoutTravel = 0;
    const mismatches: string[] = [];
    for (let i = 0; i < 8000; i++) {
      const rows = randomDay(
        rand,
        ["salon-a", "salon-b", "salon-c"],
        WHOLE_MINUTE_DURATIONS_MS,
        ["AUTO", "CONFIRMED"],
        true,
      );
      const bs = BS_MINUTES[Math.floor(rand() * BS_MINUTES.length)];
      const s = crossSalonGapSum(rows);
      const cross = evaluateDayBreaks({ rows, dayBreaks: [], acks: [] });
      const oneSalon = evaluateDayBreaks({
        rows: rows.map((r) => ({ ...r, salonId: "salon-a" })),
        dayBreaks: [],
        acks: [],
      });
      if (!cross.crossSalon) {
        mismatches.push(`not cross-salon: ${describeCase(rows, bs)}`);
        continue;
      }
      if (cross.totalBreakMin !== oneSalon.totalBreakMin - s) {
        mismatches.push(`(c1) ${describeCase(rows, bs)}`);
      }
      if (s > 0) {
        withTravel++;
      } else {
        withoutTravel++;
        const legacy = legacyDayWarningsPre80(rows, bs);
        const current = newWarnings(rows, bs).map(withoutCrossFlag);
        try {
          expect(current).toEqual(legacy);
        } catch {
          mismatches.push(`(c2) ${describeCase(rows, bs)}`);
        }
      }
    }
    expect(withTravel).toBeGreaterThan(1000);
    expect(withoutTravel).toBeGreaterThan(1000);
    if (mismatches.length > 0) console.error(mismatches.slice(0, 5));
    expect(mismatches).toHaveLength(0);
  });
});

// ── (d) sensitivity ───────────────────────────────────────────────────────────────────────────

/** Test-local copy of the legacy day function with the 120-minute boundary drifted to a strict `<`. */
function perturbedLegacyWarnings(daySlots: Row[], bsMinutesToday: number): LegacyDayWarning[] {
  const warnings: LegacyDayWarning[] = [];
  const dayIsWaived = daySlots.some((s) => s.breakStatus === "WAIVED");
  let netWorkedMin = 0;
  let explicitBreakMin = 0;
  for (const slot of daySlots) {
    const d = entryDurations(slot);
    explicitBreakMin += d.breakMinutes;
    netWorkedMin += d.workingMinutes;
  }
  let gapBreakMin = 0;
  for (let i = 1; i < daySlots.length; i++) {
    const gap = (daySlots[i].startTime.getTime() - daySlots[i - 1].endTime.getTime()) / 60000;
    if (gap > 0 && gap < 120) gapBreakMin += gap;
  }
  const totalBreakMin = explicitBreakMin + gapBreakMin;
  if (netWorkedMin > 9 * 60 && totalBreakMin < 45) {
    warnings.push({
      code: "BREAK_TOO_SHORT",
      severity: dayIsWaived ? "warning" : "error",
      message: `§ 4 ArbZG: Bei über 9 Stunden Arbeitszeit sind mindestens 45 Minuten Pause vorgeschrieben. Erfasst: ${Math.round(totalBreakMin)} Min.`,
      ...(dayIsWaived ? { waived: true } : {}),
    });
  } else if (netWorkedMin > 6 * 60 && totalBreakMin < 30) {
    warnings.push({
      code: "BREAK_TOO_SHORT",
      severity: "warning",
      message: `§ 4 ArbZG: Bei über 6 Stunden Arbeitszeit sind mindestens 30 Minuten Pause vorgeschrieben. Erfasst: ${Math.round(totalBreakMin)} Min.`,
      ...(dayIsWaived ? { waived: true } : {}),
    });
  }
  const dailyTotalMin = netWorkedMin + bsMinutesToday;
  if (dailyTotalMin > 10 * 60) {
    warnings.push({
      code: "MAX_DAILY_EXCEEDED",
      severity: "error",
      message: `§ 3 ArbZG: Tägliche Höchstarbeitszeit von 10 Stunden überschritten. Erfasst: ${(dailyTotalMin / 60).toFixed(1)} h.`,
    });
  }
  return warnings;
}

describe("Issue #80 80-AC6 (d) — the matrix can see a drift of the 120-minute gap boundary", () => {
  it("a strict `< 120` copy of the legacy function differs from the kernel on at least one same-salon case", () => {
    let differing = 0;
    for (const { rows, bs } of SAME_SALON_CASES) {
      const perturbed = perturbedLegacyWarnings(rows, bs);
      const current = newWarnings(rows, bs);
      if (JSON.stringify(perturbed) !== JSON.stringify(current)) differing++;
    }
    expect(SAME_SALON_CASES.length).toBeGreaterThan(3000);
    expect(differing).toBeGreaterThan(0);
  });
});
