/**
 * Phase 61 (v1.6.5) — unit suite for calculateWorkDays.
 *
 * The function used to live inline at apps/api/src/routes/leave.ts:1678. It's
 * now extracted to apps/api/src/utils/calculate-work-days.ts so it can be
 * unit-tested without the Fastify / Prisma harness.
 *
 * Test groups:
 *   1. an employee regressions (the 4 cases from the 2026-05-27 incident)
 *   2. halfDay short-circuit (0.5 regardless of range / workDays / holidays)
 *   3. Holiday exclusion
 *   4. DST-boundary ranges (Europe/Berlin DST 2026: Mar 29, Oct 25)
 *   5. Cross-year ranges
 *   6. Edge cases (empty workDays, full week, weekend-only single day)
 *   7. Property-based check against a reference implementation
 *
 * Reference TZ assumption: Node runs with the default `TZ=UTC` (the production
 * docker image does, see 61-AUDIT.md §A.5). Tests construct Date objects from
 * UTC ISO strings so `getDay()` and `toISOString()` agree on the calendar day.
 */
import { describe, it, expect } from "vitest";
import {
  calculateWorkDays,
  deriveWorkDaysFromPerDayHours,
  normalizeWorkDays,
} from "../calculate-work-days";

// ── Helpers ───────────────────────────────────────────────────────────────
function d(iso: string): Date {
  // Force UTC midnight to mirror how the API call sites pass Dates in
  // (leave.ts:162 — `new Date(body.startDate)` with body.startDate = "YYYY-MM-DDT00:00:00Z").
  return new Date(`${iso}T00:00:00Z`);
}

/**
 * Reference implementation — independent from the production one. Iterates
 * day-by-day by adding 86_400_000ms to a UTC timestamp (vs. the production
 * `cur.setDate(cur.getDate()+1)`). Two different strategies should agree on
 * every legal input.
 */
function calculateWorkDaysReference(
  start: Date,
  end: Date,
  halfDay: boolean,
  workDays: number[],
  holidays: Set<string>,
): number {
  if (halfDay) return 0.5;
  const workDaySet = new Set(workDays);
  let count = 0;
  const endMs = end.getTime();
  for (let ms = start.getTime(); ms <= endMs; ms += 86_400_000) {
    const day = new Date(ms);
    const dow = day.getUTCDay(); // UTC server TZ assumption
    const yyyy = day.getUTCFullYear();
    const mm = String(day.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(day.getUTCDate()).padStart(2, "0");
    const key = `${yyyy}-${mm}-${dd}`;
    if (workDaySet.has(dow) && !holidays.has(key)) count++;
  }
  return count;
}

/**
 * Deterministic LCG PRNG so property-based test failures reproduce.
 * Numerical Recipes constants (LCG): m = 2^32, a = 1664525, c = 1013904223.
 */
function makeLcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// ── 1. an employee regressions ─────────────────────────────────────────────
describe("calculateWorkDays — an employee regression cases", () => {
  const ANNA_WORKDAYS = [2, 3, 4, 5]; // Tue-Fri

  it("Mar 16-20 2026, workDays=[2,3,4,5] → 4 (was incorrectly stored as 5)", () => {
    expect(
      calculateWorkDays(d("2026-03-16"), d("2026-03-20"), false, ANNA_WORKDAYS, new Set()),
    ).toBe(4);
  });

  it("Jun 12-26 2026, workDays=[2,3,4,5] → 9 (was incorrectly stored as 11)", () => {
    expect(
      calculateWorkDays(d("2026-06-12"), d("2026-06-26"), false, ANNA_WORKDAYS, new Set()),
    ).toBe(9);
  });

  it("Aug 31 - Sep 15 2026, workDays=[2,3,4,5] → 9 (was incorrectly stored as 12)", () => {
    expect(
      calculateWorkDays(d("2026-08-31"), d("2026-09-15"), false, ANNA_WORKDAYS, new Set()),
    ).toBe(9);
  });

  it("Mar 6 2026 single day, workDays=[2,3,4,5] → 1 (missing entry entirely from her data)", () => {
    expect(
      calculateWorkDays(d("2026-03-06"), d("2026-03-06"), false, ANNA_WORKDAYS, new Set()),
    ).toBe(1);
  });
});

// ── 2. halfDay short-circuit ──────────────────────────────────────────────
describe("calculateWorkDays — halfDay semantics", () => {
  it("returns 0.5 for single-day halfDay on a workday", () => {
    expect(
      calculateWorkDays(d("2026-03-16"), d("2026-03-16"), true, [1, 2, 3, 4, 5], new Set()),
    ).toBe(0.5);
  });

  it("returns 0.5 for multi-day halfDay (per current semantics — leave UI hides toggle for ranges)", () => {
    expect(
      calculateWorkDays(d("2026-03-16"), d("2026-03-20"), true, [1, 2, 3, 4, 5], new Set()),
    ).toBe(0.5);
  });

  it("returns 0.5 for halfDay even when the day is not in workDays (current short-circuit)", () => {
    // Sunday-only halfDay request: the current algorithm returns 0.5 regardless.
    // Documented in 61-AUDIT.md §A.3.
    expect(
      calculateWorkDays(d("2026-03-15"), d("2026-03-15"), true, [1, 2, 3, 4, 5], new Set()),
    ).toBe(0.5);
  });

  it("returns 0.5 for Anna-style halfDay on a Monday (mondayHours=0 schedule)", () => {
    // The single-day Mon halfDay still returns 0.5 — the leave UI is expected
    // to bounce these before they reach the API, but the algorithm itself is
    // permissive.
    expect(calculateWorkDays(d("2026-03-16"), d("2026-03-16"), true, [2, 3, 4, 5], new Set())).toBe(
      0.5,
    );
  });
});

// ── 3. Holiday exclusion ──────────────────────────────────────────────────
describe("calculateWorkDays — holiday exclusion", () => {
  it("excludes a Tue holiday from a Mon-Fri range (May 4-8 2026, May 5 = holiday) → 4", () => {
    // Mon 5/4, Tue 5/5 (holiday), Wed 5/6, Thu 5/7, Fri 5/8 → 4
    expect(
      calculateWorkDays(
        d("2026-05-04"),
        d("2026-05-08"),
        false,
        [1, 2, 3, 4, 5],
        new Set(["2026-05-05"]),
      ),
    ).toBe(4);
  });

  it("does not double-count a holiday that falls on a weekend (i.e. already excluded by workDays)", () => {
    // Workdays Mo-Fr, holiday Sat 5/9. Result should be same as without the holiday: 5.
    expect(
      calculateWorkDays(
        d("2026-05-04"),
        d("2026-05-08"),
        false,
        [1, 2, 3, 4, 5],
        new Set(["2026-05-09"]),
      ),
    ).toBe(5);
  });

  it("excludes ALL workdays when every day in the range is a holiday", () => {
    expect(
      calculateWorkDays(
        d("2026-05-04"),
        d("2026-05-08"),
        false,
        [1, 2, 3, 4, 5],
        new Set(["2026-05-04", "2026-05-05", "2026-05-06", "2026-05-07", "2026-05-08"]),
      ),
    ).toBe(0);
  });
});

// ── 4. DST boundaries ─────────────────────────────────────────────────────
describe("calculateWorkDays — DST boundaries (Europe/Berlin DST 2026)", () => {
  it("spring-forward (Mar 29 2026): Fri Mar 27 - Tue Mar 31, workDays=[1..5] → 3", () => {
    // Fri 27 (counted), Sat 28, Sun 29 (DST day; UTC iteration unaffected), Mon 30, Tue 31
    // = Fri 27 + Mon 30 + Tue 31 = 3.
    expect(
      calculateWorkDays(d("2026-03-27"), d("2026-03-31"), false, [1, 2, 3, 4, 5], new Set()),
    ).toBe(3);
  });

  it("fall-back (Oct 25 2026): Fri Oct 23 - Tue Oct 27, workDays=[1..5] → 3", () => {
    expect(
      calculateWorkDays(d("2026-10-23"), d("2026-10-27"), false, [1, 2, 3, 4, 5], new Set()),
    ).toBe(3);
  });
});

// ── 5. Cross-year ranges ──────────────────────────────────────────────────
describe("calculateWorkDays — cross-year ranges", () => {
  it("2026-12-30 to 2027-01-05 workDays=[1..5] holidays=∅ → 5", () => {
    // Wed 30, Thu 31, Fri Jan 1, Sat Jan 2, Sun Jan 3, Mon Jan 4, Tue Jan 5
    // = Wed, Thu, Fri, Mon, Tue = 5
    expect(
      calculateWorkDays(d("2026-12-30"), d("2027-01-05"), false, [1, 2, 3, 4, 5], new Set()),
    ).toBe(5);
  });

  it("2026-12-30 to 2027-01-05 workDays=[1..5] with Jan 1 as holiday → 4", () => {
    expect(
      calculateWorkDays(
        d("2026-12-30"),
        d("2027-01-05"),
        false,
        [1, 2, 3, 4, 5],
        new Set(["2027-01-01"]),
      ),
    ).toBe(4);
  });
});

// ── 6. Edge cases ─────────────────────────────────────────────────────────
describe("calculateWorkDays — edge cases", () => {
  it("empty workDays array → 0 (no work days configured)", () => {
    expect(calculateWorkDays(d("2026-03-16"), d("2026-03-20"), false, [], new Set())).toBe(0);
  });

  it("workDays covers every weekday (0..6) over a full week → 7", () => {
    // Mon 3/16 .. Sun 3/22
    expect(
      calculateWorkDays(d("2026-03-16"), d("2026-03-22"), false, [0, 1, 2, 3, 4, 5, 6], new Set()),
    ).toBe(7);
  });

  it("single-day range on a weekend day with workDays=[1..5] → 0", () => {
    // Sat 2026-03-14
    expect(
      calculateWorkDays(d("2026-03-14"), d("2026-03-14"), false, [1, 2, 3, 4, 5], new Set()),
    ).toBe(0);
  });

  it("single-day range on a workday → 1", () => {
    // Mon 2026-03-16
    expect(
      calculateWorkDays(d("2026-03-16"), d("2026-03-16"), false, [1, 2, 3, 4, 5], new Set()),
    ).toBe(1);
  });

  it("workDays=[6] (Sat-only) over a full week → 1", () => {
    expect(calculateWorkDays(d("2026-03-16"), d("2026-03-22"), false, [6], new Set())).toBe(1);
  });

  it("workDays=[0] (Sun-only) over a full week → 1", () => {
    expect(calculateWorkDays(d("2026-03-16"), d("2026-03-22"), false, [0], new Set())).toBe(1);
  });

  it("range where start == end and the day is a holiday → 0", () => {
    expect(
      calculateWorkDays(
        d("2026-12-25"),
        d("2026-12-25"),
        false,
        [1, 2, 3, 4, 5],
        new Set(["2026-12-25"]),
      ),
    ).toBe(0);
  });
});

// ── 7. Property-based check ──────────────────────────────────────────────
describe("calculateWorkDays — property-based check vs reference impl", () => {
  it("agrees with reference impl over 200 randomized iterations (seed=42)", () => {
    const rng = makeLcg(42);

    // Generator helpers
    const pickWorkDays = (): number[] => {
      // Build a random non-empty subset of [0..6]. Use 7 coin flips, then if
      // empty, force one bit on.
      const set: number[] = [];
      for (let i = 0; i < 7; i++) if (rng() < 0.5) set.push(i);
      if (set.length === 0) set.push(Math.floor(rng() * 7));
      return set.sort((a, b) => a - b);
    };

    const randomDateInYear = (year: number): Date => {
      const start = Date.UTC(year, 0, 1);
      const end = Date.UTC(year + 1, 0, 1);
      const ms = Math.floor(start + rng() * (end - start));
      // Snap to midnight UTC
      const day = new Date(ms);
      return new Date(
        Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0, 0, 0, 0),
      );
    };

    const randomHolidays = (windowStart: Date, windowEnd: Date): Set<string> => {
      // 0..5 random holidays inside the window
      const count = Math.floor(rng() * 6);
      const out = new Set<string>();
      const startMs = windowStart.getTime();
      const span = windowEnd.getTime() - startMs;
      for (let i = 0; i < count; i++) {
        const dayMs = startMs + Math.floor(rng() * span);
        const day = new Date(dayMs);
        const key = `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, "0")}-${String(day.getUTCDate()).padStart(2, "0")}`;
        out.add(key);
      }
      return out;
    };

    let mismatchCount = 0;
    const mismatchSamples: Array<{ start: string; end: string; got: number; want: number }> = [];

    for (let i = 0; i < 200; i++) {
      const start = randomDateInYear(2026);
      // 60-day window
      const end = new Date(start.getTime() + 60 * 86_400_000);
      const workDays = pickWorkDays();
      const holidays = randomHolidays(start, end);
      const got = calculateWorkDays(start, end, false, workDays, holidays);
      const want = calculateWorkDaysReference(start, end, false, workDays, holidays);
      if (got !== want) {
        mismatchCount++;
        if (mismatchSamples.length < 3) {
          mismatchSamples.push({
            start: start.toISOString(),
            end: end.toISOString(),
            got,
            want,
          });
        }
      }
    }

    if (mismatchCount > 0) {
      console.error("Mismatches:", mismatchSamples);
    }
    expect(mismatchCount).toBe(0);
  });
});

// ── 8. deriveWorkDaysFromPerDayHours ──────────────────────────────────────
describe("deriveWorkDaysFromPerDayHours", () => {
  it("Mo-Fr 8h + Sa/Su 0 → [1,2,3,4,5]", () => {
    expect(
      deriveWorkDaysFromPerDayHours({
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
      }),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it("Anna case: Mon=0, Tue-Fri=8, Sat/Sun=0 → [2,3,4,5]", () => {
    expect(
      deriveWorkDaysFromPerDayHours({
        mondayHours: 0,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
      }),
    ).toEqual([2, 3, 4, 5]);
  });

  it("Frisör Di-Sa (Mo=0, Sa=8) → [2,3,4,5,6]", () => {
    expect(
      deriveWorkDaysFromPerDayHours({
        mondayHours: 0,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 8,
        sundayHours: 0,
      }),
    ).toEqual([2, 3, 4, 5, 6]);
  });

  it("4-day week with Thursday off → [1,2,3,5]", () => {
    expect(
      deriveWorkDaysFromPerDayHours({
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 0,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
      }),
    ).toEqual([1, 2, 3, 5]);
  });

  it("All-zero (MONTHLY_HOURS pure tracking) → []", () => {
    expect(
      deriveWorkDaysFromPerDayHours({
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
      }),
    ).toEqual([]);
  });

  it("accepts string inputs (Prisma Decimal serialization)", () => {
    expect(
      deriveWorkDaysFromPerDayHours({
        mondayHours: "0",
        tuesdayHours: "8.00",
        wednesdayHours: "8.00",
        thursdayHours: "8.00",
        fridayHours: "8.00",
        saturdayHours: "0",
        sundayHours: "0",
      }),
    ).toEqual([2, 3, 4, 5]);
  });

  it("accepts Decimal-like objects with toNumber() (Prisma Decimal in JS)", () => {
    const mkDec = (n: number) => ({ toNumber: () => n });
    expect(
      deriveWorkDaysFromPerDayHours({
        mondayHours: mkDec(0),
        tuesdayHours: mkDec(8),
        wednesdayHours: mkDec(8),
        thursdayHours: mkDec(8),
        fridayHours: mkDec(8),
        saturdayHours: mkDec(0),
        sundayHours: mkDec(0),
      }),
    ).toEqual([2, 3, 4, 5]);
  });

  it("treats fractional hours > 0 as workdays", () => {
    expect(
      deriveWorkDaysFromPerDayHours({
        mondayHours: 0.5,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
      }),
    ).toEqual([1]);
  });
});

// ── 9. normalizeWorkDays ──────────────────────────────────────────────────
describe("normalizeWorkDays", () => {
  const fiveDayHours = {
    mondayHours: 8,
    tuesdayHours: 8,
    wednesdayHours: 8,
    thursdayHours: 8,
    fridayHours: 8,
    saturdayHours: 0,
    sundayHours: 0,
  };
  const annaHours = {
    mondayHours: 0,
    tuesdayHours: 8,
    wednesdayHours: 8,
    thursdayHours: 8,
    fridayHours: 8,
    saturdayHours: 0,
    sundayHours: 0,
  };
  const allZero = {
    mondayHours: 0,
    tuesdayHours: 0,
    wednesdayHours: 0,
    thursdayHours: 0,
    fridayHours: 0,
    saturdayHours: 0,
    sundayHours: 0,
  };

  it("undefined explicit + Mo-Fr hours → [1,2,3,4,5] (derived = same as default)", () => {
    expect(normalizeWorkDays(undefined, fiveDayHours)).toEqual([1, 2, 3, 4, 5]);
  });

  it("undefined explicit + Anna hours (Mon=0) → [2,3,4,5] (Anna's bug fixed)", () => {
    expect(normalizeWorkDays(undefined, annaHours)).toEqual([2, 3, 4, 5]);
  });

  it("literal default [1,2,3,4,5] + Anna hours → [2,3,4,5] (literal default overridden)", () => {
    expect(normalizeWorkDays([1, 2, 3, 4, 5], annaHours)).toEqual([2, 3, 4, 5]);
  });

  it("explicit [2,3,4,5] + Anna hours → [2,3,4,5] (pass through)", () => {
    expect(normalizeWorkDays([2, 3, 4, 5], annaHours)).toEqual([2, 3, 4, 5]);
  });

  it("explicit non-default [0,1,2,3,4] + Mo-Fr hours → [0,1,2,3,4] (admin override wins)", () => {
    // Caller deliberately chose Sun-Thu even though hours suggest Mo-Fr.
    expect(normalizeWorkDays([0, 1, 2, 3, 4], fiveDayHours)).toEqual([0, 1, 2, 3, 4]);
  });

  it("undefined explicit + all-zero hours → [1,2,3,4,5] (fallback to legacy default)", () => {
    // MONTHLY_HOURS pure tracking with no per-day-hours signal — fall back to [1,2,3,4,5].
    expect(normalizeWorkDays(undefined, allZero)).toEqual([1, 2, 3, 4, 5]);
  });

  it("undefined explicit + 4-day-week hours (Thu=0) → [1,2,3,5]", () => {
    expect(
      normalizeWorkDays(undefined, {
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 0,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
      }),
    ).toEqual([1, 2, 3, 5]);
  });

  it("undefined explicit + all-zero hours + tenant fallback [2,3,4,5,6] → [2,3,4,5,6]", () => {
    expect(normalizeWorkDays(undefined, allZero, [2, 3, 4, 5, 6])).toEqual([2, 3, 4, 5, 6]);
  });

  it("empty explicit array [] + Anna hours → [2,3,4,5] (treats [] as not-explicit)", () => {
    // Zod schema rejects empty arrays at API boundary (min(1)), but the helper
    // is defensive — an empty array is treated as "no explicit preference".
    expect(normalizeWorkDays([], annaHours)).toEqual([2, 3, 4, 5]);
  });

  it("literal default [1,2,3,4,5] + Mo-Fr hours → [1,2,3,4,5] (no change)", () => {
    expect(normalizeWorkDays([1, 2, 3, 4, 5], fiveDayHours)).toEqual([1, 2, 3, 4, 5]);
  });
});
